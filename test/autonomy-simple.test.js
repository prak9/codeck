import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixture, answers } from '../test-support/autonomy-fixture.js';
import { autonomyPresentation } from '../public/remote-autonomy.js';

test('A has only new states, border tones and numeric progress, never resume controls', () => {
  for (const [status, tone, active] of [['configuring', 'idle', false], ['running', 'running', true], ['exiting', 'running', true],
    ['completed', 'completed', false], ['error', 'error', false], ['off', 'idle', false]]) {
    const view = autonomyPresentation({ status, round: 2, plan: { maxRounds: 5 } });
    assert.equal(view.tone, tone); assert.equal(view.active, active); assert.equal(view.progress, '2/5');
    assert.doesNotMatch(view.detail + view.label, /暂停|续跑|恢复/);
  }
  assert.equal(autonomyPresentation({ status: 'running', round: 2, plan: { maxRounds: null } }).progress, '2');
});

for (const provider of ['codex', 'claude', 'qodercli']) test(`${provider}: A stops once, configures without waiting for history and approves once`, async () => {
  const f = fixture(provider); f.session.hasRunningProcess = true;
  f.manager.readThread = () => new Promise(() => {});
  await Promise.all([f.manager.start(f.target), f.manager.start(f.target)]);
  assert.equal(f.stops.length, 1); assert.equal(f.stops[0].stopBackground, false); assert.equal(f.state().setup, true);
  assert.equal(f.state().questions, undefined); assert.equal(f.sent.length, 0);
  await f.approve(); await f.manager.tick(); assert.equal(f.sent.length, 1); assert.equal(f.state().status, 'running'); f.manager.close();
});

test('A interrupts, summarizes once, exits and starts a fresh definition on its next click', async () => {
  const f = fixture('qodercli'); await f.start('5轮'); f.session.hasRunningProcess = true;
  await Promise.all([f.manager.finish(f.target), f.manager.finish(f.target)]);
  assert.equal(f.stops.length, 3); assert.equal(f.stops.at(-1).stopBackground, false);
  await f.manager.tick(); assert.equal(f.sent.length, 2); assert.equal(f.state().round, 1);
  f.reply('summary', { summary: '已完成解析，待验证', next: '验证窄屏' }); await f.manager.tick();
  assert.equal(f.state().status, 'off'); assert.equal(f.state().handoff.next, '验证窄屏');
  const id = f.state().id; await f.manager.start(f.target);
  assert.notEqual(f.state().id, id); assert.equal(f.state().round, 0); assert.equal(f.state().setup, true); assert.equal(f.sent.length, 2); f.manager.close();
});

test('failed interruption errors; takeover during interruption prevents late setup', async () => {
  const f = fixture(); f.manager.stop = async () => { throw Error('无法中断'); };
  await assert.rejects(f.manager.start(f.target), /无法中断/); assert.equal(f.state().status, 'error');
  let release; f.manager.stop = () => new Promise(resolve => { release = resolve; });
  const pending = f.manager.start(f.target); while (!release) await Promise.resolve();
  f.manager.exitSession('work'); release(); await pending;
  assert.equal(f.state().status, 'off'); assert.equal(f.state().requestId, null); assert.equal(f.sent.length, 0); f.manager.close();
});

test('summary timeout remains bounded even when a background task is running', async () => {
  const f = fixture(); await f.start('1轮'); await f.manager.finish(f.target); await f.manager.tick(); await f.manager.tick();
  f.session.agent.hasBackgroundProcess = true; f.now += 120001; await f.manager.tick();
  assert.equal(f.state().status, 'error'); assert.match(f.state().reason, /总结未完成/); assert.equal(f.sent.length, 2); f.manager.close();
});

test('restart never repeats work, stop or summary, and next A always starts at setup', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeck-state-restart-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = fixture('qodercli', path.join(dir, 'autonomy.json')); await f.start(); await f.manager.finish(f.target); await f.manager.tick();
  const id = f.state().id, sent = f.sent.length, stops = f.stops.length; f.restart(); await f.manager.tick();
  assert.equal(f.state().status, 'off'); assert.equal(f.sent.length, sent); assert.equal(f.stops.length, stops);
  await f.manager.start(f.target); assert.notEqual(f.state().id, id); assert.equal(f.state().setup, true); assert.equal(f.sent.length, sent); f.manager.close();
});

test('old answers and stale approval IDs are rejected, not interpreted as compatibility requests', async () => {
  const f = fixture(); await f.manager.start(f.target); const requestId = f.state().requestId;
  for (const extra of [{ continuation: ['true'] }, { problem: ['旧字段'] }, { decision: ['按此目标开始'] }]) {
    await assert.rejects(f.manager.respond(f.target, { requestId, answers: { ...answers(), ...extra } }), /格式/);
  }
  await f.approve(); await assert.rejects(f.manager.respond(f.target, { requestId, answers: answers() }), /已变化/); f.manager.close();
});
