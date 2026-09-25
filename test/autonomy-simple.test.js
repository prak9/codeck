import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AutonomyController } from '../src/autonomy.js';
import { autonomyPresentation } from '../public/remote-autonomy.js';

test('simple A presents setup, execution, summary and off without a resume label', () => {
  for (const [status, extra, detail, active] of [
    ['configuring', { setup: true }, '待设置', false], ['running', {}, '执行中', true],
    ['exiting', {}, '总结退出中', true], ['off', {}, '已退出', false], ['paused', {}, '已退出', false],
  ]) {
    const view = autonomyPresentation({ mode: 'simple', status, ...extra });
    assert.equal(view.detail, detail); assert.equal(view.active, active); assert.doesNotMatch(view.label, /继续|恢复|暂停/);
  }
});

test('compact autonomy progress contains only round counts, not execution or resume copy', () => {
  for (const status of ['running', 'paused', 'off', 'completed']) {
    assert.equal(autonomyPresentation({ mode: 'simple', status, round: 2, plan: { maxRounds: 5 } }).progress, '2/5');
    assert.equal(autonomyPresentation({ mode: 'simple', status, round: 2, plan: { maxRounds: null } }).progress, '2');
  }
  assert.equal(autonomyPresentation({ mode: 'simple', status: 'configuring', setup: true }).progress, '');
});

function fixture(provider = 'qodercli') {
  const target = { provider, threadId: 'thread-1', tmuxSession: 'work' };
  const session = { name: 'work', hasRunningProcess: true, agent: { kind: provider, id: 'thread-1', paneId: '%7' } };
  const f = { target, session, sent: [], stops: [], turns: [] };
  f.manager = new AutonomyController({ schedule: () => 1, cancel() {},
    readSession: async () => session,
    readThread: async () => ({ thread: { id: target.threadId, turns: f.turns } }),
    stop: async (_target, guard, options) => { assert.equal(guard(), true); f.stops.push(options); session.hasRunningProcess = false; },
    send: async (_target, text) => { f.sent.push(text); f.turns.push({ status: 'inProgress', items: [{ type: 'userMessage', content: text }] }); return { submissionStatus: 'attempted' }; },
  });
  f.state = () => f.manager.snapshot(target);
  f.answer = () => f.manager.respond(target, { requestId: f.state().requestId,
    answers: { goal: ['修复输入框，回归通过'], strategy: ['最小修改，优先验证'], budget: ['5 轮'] } });
  f.reply = record => {
    const turn = f.turns.at(-1); turn.status = 'completed';
    const nonce = /"nonce":"([^"]+)"/.exec(f.sent.at(-1))[1];
    turn.items.push({ type: 'agentMessage', text: '总结\n```codeck-autonomy\n' + JSON.stringify({ nonce, ...record }) + '\n```' });
  };
  return f;
}

test('simple A interrupts then shows local choices without history or configuration delivery for every provider', async () => {
  for (const provider of ['codex', 'claude', 'qodercli']) {
    const f = fixture(provider);
    f.manager.readThread = async () => assert.fail('setup must not wait for history');
    await Promise.all([f.manager.start(f.target, { simple: true }), f.manager.start(f.target, { simple: true })]);
    assert.equal(f.stops.length, 1); assert.equal(f.stops[0].stopBackground, false);
    assert.equal(f.state().setup, true); assert.deepEqual(f.state().questions.map(q => q.id), ['goal', 'strategy', 'budget']);
    await f.manager.tick(); assert.equal(f.sent.length, 0);
    await f.answer(); await f.manager.tick();
    assert.equal(f.state().round, 1); assert.equal(f.sent.length, 1);
    assert.match(f.sent[0], /修复输入框，回归通过/); assert.match(f.sent[0], /"phase":"round"/);
    f.manager.close();
  }
});

test('simple A interrupts a running turn, summarizes once and next A starts fresh setup', async () => {
  const f = fixture(); await f.manager.start(f.target, { simple: true }); await f.answer(); await f.manager.tick();
  f.session.hasRunningProcess = true;
  await Promise.all([f.manager.finish(f.target), f.manager.finish(f.target)]);
  assert.equal(f.stops.length, 3); assert.equal(f.stops.at(-1).stopBackground, false);
  await f.manager.tick(); assert.equal(f.sent.length, 2); assert.equal(f.state().round, 1);
  assert.match(f.sent[1], /"phase":"summary"/);
  f.reply({ status: 'summary', summary: '已完成解析修复，剩余验证' }); await f.manager.tick();
  assert.equal(f.state().status, 'off');
  await f.manager.tick(); assert.equal(f.sent.length, 2);
  const oldId = f.state().id;
  await f.manager.start(f.target, { simple: true });
  assert.notEqual(f.state().id, oldId); assert.equal(f.state().round, 0); assert.equal(f.state().setup, true);
  assert.equal(f.sent.length, 2); f.manager.close();
});

test('simple setup rejects malformed budgets and stale approvals without sending', async () => {
  const f = fixture(); await f.manager.start(f.target, { simple: true }); const requestId = f.state().requestId;
  await assert.rejects(f.manager.respond(f.target, { requestId, answers: { goal: ['目标'], strategy: ['策略'], budget: ['随便'] } }), /预算/);
  assert.equal(f.sent.length, 0);
  await f.manager.respond(f.target, { requestId, answers: { goal: ['目标'], strategy: ['策略'], budget: ['不设预算，直到完成或出错'] } });
  assert.equal(f.state().plan.maxRounds, null); assert.equal(f.state().plan.minutes, null);
  await assert.rejects(f.manager.respond(f.target, { requestId, answers: {} }), /已变化/);
  f.manager.close();
});

test('failed interrupt and human takeover prevent setup or summary from starting', async () => {
  const f = fixture(); f.manager.stop = async () => { throw new Error('无法中断'); };
  await assert.rejects(f.manager.start(f.target, { simple: true }), /无法中断/);
  await f.manager.tick(); assert.equal(f.sent.length, 0); assert.equal(f.state().status, 'paused');
  let release; f.manager.stop = () => new Promise(resolve => { release = resolve; });
  const pending = f.manager.start(f.target, { simple: true });
  while (!release) await Promise.resolve();
  f.manager.pauseSession('work'); release(); await pending;
  assert.equal(f.state().status, 'paused'); assert.equal(f.state().requestId, null); f.manager.close();
});

test('summary ignores the spent round budget and times out even with background work', async () => {
  const f = fixture(); let now = 1000; f.manager.now = () => now;
  await f.manager.start(f.target, { simple: true }); await f.answer();
  f.manager.runs.values().next().value.plan.maxRounds = 1;
  await f.manager.tick(); await f.manager.finish(f.target); await f.manager.tick();
  assert.equal(f.state().round, 1); assert.equal(f.sent.length, 2);
  await f.manager.tick(); // Observe the persisted summary request.
  f.session.agent.hasBackgroundProcess = true; now += 120001; await f.manager.tick();
  assert.equal(f.state().status, 'paused'); assert.match(f.state().reason, /总结未完成/);
  await f.manager.tick(); assert.equal(f.sent.length, 2); f.manager.close();
});

test('restart does not repeat interruption, work or summary; next A creates new setup', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeck-simple-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = fixture(); f.manager.file = path.join(dir, 'autonomy.json');
  await f.manager.start(f.target, { simple: true }); await f.answer(); await f.manager.tick();
  await f.manager.finish(f.target); await f.manager.tick();
  const first = f.state().id, sent = f.sent.length, stops = f.stops.length;
  const old = f.manager; old.close();
  f.manager = new AutonomyController({ file: old.file, readSession: old.readSession, readThread: old.readThread,
    send: old.send, stop: old.stop, schedule: () => 1, cancel() {} });
  await f.manager.tick(); assert.equal(f.sent.length, sent); assert.equal(f.stops.length, stops);
  await f.manager.start(f.target, { simple: true });
  assert.notEqual(f.state().id, first); assert.equal(f.state().setup, true); assert.equal(f.sent.length, sent);
  f.manager.close();
});

test('new setup supersedes an in-flight legacy recovery and never publishes its late state', async () => {
  const f = fixture(); await f.manager.start(f.target); await f.manager.tick();
  const old = f.manager.runs.values().next().value;
  old.exchange.deliveryState = 'unconfirmed'; f.manager.pause(f.target);
  let release;
  f.manager.readThread = () => new Promise(resolve => { release = resolve; });
  const recovering = f.manager.start(f.target);
  while (!release) await Promise.resolve();
  const changes = []; f.manager.on('change', state => changes.push(state.id));
  await f.manager.start(f.target, { simple: true }); const id = f.state().id;
  release({ thread: { id: f.target.threadId, turns: [], receivedDeliveryIds: [old.suspended.exchange.commandId] } }); await recovering;
  assert.equal(changes.at(-1), id); assert.equal(f.state().setup, true);
  assert.equal(f.state().questions?.length, 3); await f.manager.tick(); assert.equal(f.sent.length, 1);
  f.manager.close();
});
