import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AutonomyController } from '../src/autonomy.js';
import { autonomyKey, autonomyPresentation, autonomyDisplayText, autonomyBudgetText, AUTONOMY_PROGRESS_PROMPT } from '../public/remote-autonomy.js';

const target = { provider: 'codex', threadId: 'thread-1', tmuxSession: 'work' };
const plan = { goal: 'Fix the picker', acceptance: 'Regression passes', maxRounds: 3,
  minutes: 30, preferences: 'Minimal changes; do not commit or deploy', advisoryBudget: '' };

test('progress briefly asks about the goal and progress without detailed decomposition or changing pace', () => {
  assert.ok(AUTONOMY_PROGRESS_PROMPT.length <= 80);
  assert.match(AUTONOMY_PROGRESS_PROMPT, /目标.*进展.*剩余.*阻塞/);
  assert.doesNotMatch(AUTONOMY_PROGRESS_PROMPT, /子目标|逐项|完成标准|证据|gap/);
  assert.match(AUTONOMY_PROGRESS_PROMPT, /不打断/);
  assert.match(AUTONOMY_PROGRESS_PROMPT, /不续跑.*不改.*预算/);
  assert.doesNotMatch(AUTONOMY_PROGRESS_PROMPT, /汇报后继续/);
});

test('A configuration provides choices and only the current proposal can authorize a round', async () => {
  const f = fixture(); await f.manager.start(target); await f.manager.tick();
  const questions = [{ id: 'goal', header: '目标', question: '这次推进哪项？',
    options: [{ label: '修复回执', description: '先修复残留' }, { label: '优化弹窗' }] }];
  f.reply({ status: 'ask', questions }); await f.manager.tick();
  const requestId = f.state().requestId;
  assert.ok(requestId); assert.equal(f.state().questions[0].options.length, 2);
  await assert.rejects(f.manager.respond(target, { requestId: 'old', answers: { goal: ['修复回执'] } }));
  await assert.rejects(f.manager.respond(target, { requestId, answers: {} }));
  await f.manager.respond(target, { requestId, answers: { goal: ['修复回执'] } }); await f.manager.tick();
  assert.match(f.sent.at(-1), /修复回执/); assert.equal(f.state().round, 0);
  f.reply({ status: 'ready', plan }); await f.manager.tick();
  const proposalId = f.state().requestId;
  assert.notEqual(proposalId, requestId);
  await assert.rejects(f.manager.respond(target, { requestId, answers: { decision: ['按此目标开始'] } }));
  await f.manager.respond(target, { requestId: proposalId, answers: { decision: ['按此目标开始'] } });
  await f.manager.tick(); assert.equal(f.state().round, 1);
  await assert.rejects(f.manager.respond(target, { requestId: proposalId, answers: { decision: ['按此目标开始'] } }));
});

test('choice rejection and adjustment do not start work or silently accept a revised plan', async () => {
  const f = fixture(); await f.ready();
  await f.manager.respond(target, { requestId: f.state().requestId, answers: { decision: ['暂不开始'] } });
  await f.manager.tick(); assert.equal(f.state().status, 'paused'); assert.equal(f.sent.length, 1);
  await f.manager.start(target); assert.equal(f.state().status, 'confirming');
  await f.manager.respond(target, { requestId: f.state().requestId, answers: { decision: ['调整目标或预算'] } });
  await f.manager.tick(); assert.equal(f.state().round, 0); assert.match(f.sent.at(-1), /选择/);
});

test('invalid choice protocols pause safely instead of creating an unusable modal', async () => {
  for (const questions of [undefined, [], [{ id: 'goal', header: '目标', question: '做什么？', options: ['只有一项'] }]]) {
    const f = fixture(); await f.manager.start(target); await f.manager.tick();
    f.reply({ status: 'ask', questions }); await f.manager.tick();
    assert.equal(f.state().status, 'paused'); assert.equal(f.state().round, 0);
    assert.equal(f.state().requestId, null);
    await f.manager.tick(); assert.equal(f.sent.length, 1);
  }
});

test('a lost configuration result restores a proposal, never work, before explicit confirmation', async () => {
  const f = fixture(); await f.manager.start(target); await f.manager.tick();
  f.reply({ status: 'ready', plan });
  f.manager.pause(target, '发送状态检查失败');
  const thread = { id: target.threadId, ...f.thread };
  f.manager.restoreProposal(target, thread);
  assert.equal(f.state().status, 'confirming'); assert.deepEqual(f.state().proposal, plan);
  const requestId = f.state().requestId;
  f.manager.restoreProposal(target, thread);
  assert.equal(f.state().requestId, requestId, 'refresh cannot replace an active confirmation');
  await f.manager.tick(); assert.equal(f.sent.length, 1); assert.equal(f.state().round, 0);
  await f.manager.respond(target, { requestId, answers: { decision: ['按此目标开始'] } });
  await f.manager.tick(); assert.equal(f.sent.length, 2); assert.equal(f.state().round, 1);
});

test('proposal recovery rejects stale, foreign, unfinished and tool-generated configuration results', async () => {
  for (const scenario of ['human', 'nonce', 'unfinished', 'tool', 'foreign', 'loading', 'no-run']) {
    const f = fixture(); await f.manager.start(target); await f.manager.tick();
    f.reply({ status: 'ready', plan }, scenario === 'nonce' ? { nonce: 'wrong' }
      : scenario === 'unfinished' ? { status: 'inProgress' } : scenario === 'tool' ? { type: 'commandExecution' } : {});
    f.manager.pause(target);
    if (scenario === 'human') f.thread.turns.push({ items: [{ type: 'userMessage', content: '换个目标，先不要执行' }] });
    if (scenario === 'no-run') f.manager.runs.clear();
    f.manager.restoreProposal(target, { ...f.thread, id: scenario === 'foreign' ? 'other-thread' : target.threadId,
      historyLoading: scenario === 'loading' });
    assert.equal(f.state()?.proposal ?? null, null, scenario);
    await f.manager.tick(); assert.equal(f.sent.length, 1, scenario);
  }
});

test('lost setup choices recover without another continue prompt or authorizing work', async () => {
  const f = fixture(); await f.manager.start(target); await f.manager.tick();
  const questions = [{ id: 'goal', header: '目标', question: '推进到哪里？', options: ['修复并验证', '只继续研究'] }];
  f.reply({ status: 'ask', questions });
  f.manager.pause(target, '发送未确认，请检查终端');
  f.manager.restoreProposal(target, { id: target.threadId, ...f.thread });
  assert.equal(f.state().status, 'configuring');
  assert.equal(f.state().questions[0].question, questions[0].question);
  const requestId = f.state().requestId;
  assert.ok(requestId);
  f.manager.restoreProposal(target, { id: target.threadId, ...f.thread });
  assert.equal(f.state().requestId, requestId);
  await f.manager.start(target); await f.manager.tick();
  assert.equal(f.sent.length, 1); assert.equal(f.state().round, 0);
  await f.manager.respond(target, { requestId, answers: { goal: ['只继续研究'] } });
  await f.manager.tick(); assert.match(f.sent.at(-1), /目标：只继续研究/);
});

test('invalid or obsolete setup choices are not recovered as a dialog', async () => {
  for (const scenario of ['malformed', 'nonce', 'unfinished', 'tool', 'human']) {
    const f = fixture(); await f.manager.start(target); await f.manager.tick();
    const questions = [{ id: 'goal', header: '目标', question: '做什么？', options: ['修复', '分析'] }];
    f.reply({ status: 'ask', questions: scenario === 'malformed' ? [] : questions },
      scenario === 'nonce' ? { nonce: 'wrong' } : scenario === 'unfinished' ? { status: 'inProgress' }
        : scenario === 'tool' ? { type: 'commandExecution' } : {});
    if (scenario === 'human') f.thread.turns.push({ items: [{ type: 'userMessage', content: '先不要继续' }] });
    f.manager.pause(target);
    f.manager.restoreProposal(target, { id: target.threadId, ...f.thread });
    assert.equal(f.state().status, 'paused', scenario); assert.equal(f.state().requestId, null, scenario);
  }
});
function fixture(options = {}) {
  const f = { sent: [], thread: { turns: [] }, session: { name: 'work', hasRunningProcess: false,
    agent: { kind: 'codex', id: 'thread-1', paneId: '%7' } }, now: 100_000 };
  f.manager = new AutonomyController({
    readSession: async () => f.session,
    readThread: async () => ({ thread: f.thread }),
    send: async (_target, text, guard) => { assert.equal(guard(), true); f.sent.push(text); return { submissionStatus: 'submitted' }; },
    now: () => f.now, schedule: () => ({ unref() {} }), cancel: () => {}, ...options,
  });
  f.state = () => f.manager.snapshot(target);
  f.reply = (record, { status = 'completed', type = 'agentMessage', nonce } = {}) => {
    const text = f.sent.at(-1);
    const token = nonce || /"nonce":"([^"]+)"/.exec(text)[1];
    f.thread.turns.push({ id: `turn-${f.thread.turns.length}`, status, items: [
      { type: 'userMessage', content: [{ type: 'text', text }] },
      { type, text: `Summary\n\n\`\`\`codeck-autonomy\n${JSON.stringify({ nonce: token, ...record })}\n\`\`\`` },
    ] });
  };
  f.ready = async () => {
    await f.manager.start(target); await f.manager.tick();
    f.reply({ status: 'ready', plan }); await f.manager.tick();
    assert.equal(f.state().status, 'confirming');
  };
  f.run = async () => { await f.ready(); await f.manager.message(target, '开始'); await f.manager.tick(); };
  return f;
}

test('resume observes the same in-flight round without cancellation or replay', async () => {
  const f = fixture(); await f.run();
  f.manager.stop = async () => assert.fail('same goal must not cancel work');
  f.session.hasRunningProcess = true;
  f.manager.pause(target); await f.manager.start(target); await f.manager.tick();
  assert.equal(f.state().round, 1); assert.equal(f.sent.length, 2);
  f.session.hasRunningProcess = false;
  f.reply({ status: 'complete', summary: 'Done', evidence: 'tests pass' });
  await f.manager.tick();
  assert.equal(f.state().status, 'completed'); assert.equal(f.sent.length, 2);
});

test('restart preserves a reserved round for observation, never replay', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeck-resume-'));
  try {
    const file = path.join(dir, 'runs.json'); const f = fixture({ file }); await f.run();
    f.reply({ status: 'complete', summary: 'Done', evidence: 'tests pass' }); f.manager.close();
    const restored = fixture({ file, stop: async () => assert.fail('no cancellation') });
    restored.thread = f.thread;
    await restored.manager.start(target); await restored.manager.tick();
    assert.equal(restored.state().status, 'completed'); assert.equal(restored.state().round, 1);
    assert.deepEqual(restored.sent, []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('background work does not trigger the idle missing-result timeout', async () => {
  const f = fixture(); await f.run(); f.session.agent.hasBackgroundProcess = true;
  await f.manager.tick(); f.now += 40_000; await f.manager.tick();
  assert.equal(f.state().status, 'running');
  f.session.agent.hasBackgroundProcess = false;
  await f.manager.tick(); f.now += 31_000; await f.manager.tick();
  assert.equal(f.state().status, 'paused');
});

test('pause and immediate resume invalidate a pending read without spending another round', async () => {
  const f = fixture(); await f.run();
  f.reply({ status: 'continue', summary: 'Tested', next: 'Next', progress: true }); await f.manager.tick();
  let finish; const read = f.manager.readSession;
  f.manager.readSession = () => new Promise(resolve => { finish = resolve; });
  const tick = f.manager.tick(); await Promise.resolve();
  f.manager.pause(target); await f.manager.start(target); finish(f.session); await tick;
  assert.equal(f.sent.length, 2); assert.equal(f.state().round, 1);
  f.manager.readSession = read; await f.manager.tick();
  assert.equal(f.sent.length, 3); assert.equal(f.state().round, 2);
});

test('legacy paused runs wait for current work before checking results, without cancellation', async () => {
  const f = fixture(); await f.run(); f.manager.pause(target);
  f.manager.runs.get(autonomyKey(target)).suspended = null;
  f.manager.stop = async () => assert.fail('legacy resume cannot cancel');
  f.session.hasRunningProcess = true;
  await f.manager.start(target); await f.manager.tick(); assert.equal(f.sent.length, 2);
  f.session.hasRunningProcess = false; f.session.agent.hasBackgroundProcess = true;
  await f.manager.tick(); assert.equal(f.sent.length, 2);
  f.session.agent.hasBackgroundProcess = false;
  await f.manager.tick(); await f.manager.tick(); assert.equal(f.state().round, 2);
});

test('explicit resume after a blocked result queues a bounded check instead of hanging', async () => {
  const f = fixture(); await f.run();
  f.reply({ status: 'blocked', summary: 'Need a decision' }); await f.manager.tick();
  assert.equal(f.state().status, 'paused');
  await f.manager.start(target); await f.manager.tick(); await f.manager.tick();
  assert.equal(f.state().round, 2); assert.equal(f.sent.length, 3);
});

test('paused activity remains visible without changing the A resume action', () => {
  const run = { status: 'paused', round: 2, plan };
  for (const [session, label] of [
    [{ hasRunningProcess: true }, '执行中'],
    [{ agent: { hasBackgroundProcess: true } }, '后台执行中'],
  ]) {
    const view = autonomyPresentation(run, session);
    assert.equal(view.detail, `2/3 ${label} · 续跑关闭`);
    assert.equal(view.active, false); assert.equal(view.label, '继续自主迭代');
  }
});

test('autonomy asks for configuration before dispatching any work and requires human confirmation', async () => {
  const f = fixture(); await f.ready();
  assert.equal(f.sent.length, 1); assert.equal(f.state().round, 0);
  assert.match(f.sent[0], /目标/); assert.match(f.sent[0], /预算/); assert.match(f.sent[0], /偏好/);
  await f.manager.tick(); assert.equal(f.sent.length, 1);
  await f.manager.message(target, '开始'); await f.manager.tick();
  assert.equal(f.state().round, 1); assert.equal(f.sent.length, 2);
});

test('explicit unlimited budget runs past 100 rounds and stops on completion', async () => {
  const f = fixture(); await f.manager.start(target); await f.manager.tick();
  assert.match(f.sent[0], /不设预算/);
  f.reply({ status: 'ready', plan: { ...plan, maxRounds: null, minutes: null } }); await f.manager.tick();
  assert.equal(f.state().status, 'confirming');
  await f.manager.message(target, '开始'); await f.manager.tick();
  for (let n = 1; n <= 101; n++) {
    f.now += 60_000;
    f.reply({ status: 'continue', summary: `Done ${n}`, next: 'Next', progress: true });
    await f.manager.tick(); await f.manager.tick();
  }
  assert.equal(f.state().round, 102); assert.equal(f.state().status, 'running');
  assert.match(autonomyPresentation(f.state()).text, /102\/∞/);
  assert.doesNotMatch(f.sent.at(-1), /102\/null/);
  f.reply({ status: 'complete', summary: 'Done', evidence: 'Tests passed' }); await f.manager.tick();
  assert.equal(f.state().status, 'completed');
});

test('rejected unlimited setup recovers to confirmation without dispatching work', async () => {
  const f = fixture(); await f.manager.start(target); await f.manager.tick();
  f.reply({ status: 'ready', plan: { ...plan, maxRounds: null, minutes: null } });
  f.manager.pause(target, '配置结果无效，请明确目标、预算和偏好');
  f.manager.restoreProposal(target, { id: target.threadId, ...f.thread });
  assert.equal(f.state().status, 'confirming');
  assert.equal(f.state().proposal.maxRounds, null); assert.equal(f.state().proposal.minutes, null);
  await f.manager.tick(); assert.equal(f.sent.length, 1); assert.equal(f.state().round, 0);
});

test('unlimited rounds still honor a configured time limit', async () => {
  const f = fixture(); await f.manager.start(target); await f.manager.tick();
  f.reply({ status: 'ready', plan: { ...plan, maxRounds: null, minutes: 1 } }); await f.manager.tick();
  await f.manager.message(target, '开始'); await f.manager.tick();
  f.now += 60_001;
  f.reply({ status: 'continue', summary: 'Progress', next: 'Next', progress: true });
  await f.manager.tick(); await f.manager.tick();
  assert.equal(f.state().status, 'limit'); assert.equal(f.state().reason, '已达时间上限');
  assert.equal(f.sent.length, 2);
});

test('unlimited plan survives restart without automatic continuation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeck-unlimited-'));
  try {
    const file = path.join(dir, 'runs.json'); const f = fixture({ file });
    await f.manager.start(target); await f.manager.tick();
    f.reply({ status: 'ready', plan: { ...plan, maxRounds: null, minutes: null } }); await f.manager.tick();
    await f.manager.message(target, '开始'); await f.manager.tick(); f.manager.close();
    const restored = fixture({ file });
    assert.equal(restored.state().status, 'paused'); assert.equal(restored.state().plan.maxRounds, null);
    assert.equal(restored.state().deadline, null);
    await restored.manager.tick(); assert.deepEqual(restored.sent, []);
    restored.manager.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('both modes share explicit unlimited and finite budget labels', () => {
  assert.equal(autonomyBudgetText({ maxRounds: null, minutes: null }, 0), '不设预算上限（已用 0 轮）');
  assert.equal(autonomyBudgetText({ maxRounds: null, minutes: 30 }, 1), '不限轮数 · 30 分钟（已用 1 轮）');
  assert.equal(autonomyBudgetText(plan, 2), '3 轮 · 30 分钟（已用 2 轮）');
});

test('user budgets have no arbitrary round or duration ceiling', async () => {
  const f = fixture(); await f.manager.start(target); await f.manager.tick();
  f.reply({ status: 'ready', plan: { ...plan, maxRounds: 1000, minutes: 10080 } });
  await f.manager.tick(); assert.equal(f.state().status, 'confirming');
  await f.manager.message(target, '开始'); await f.manager.tick();
  assert.equal(f.state().status, 'running'); assert.equal(f.state().plan.maxRounds, 1000);
  assert.equal(f.state().deadline, f.now + 10080 * 60000);
});

test('exploration can adapt after inconclusive rounds without changing the approved goal', async () => {
  const f = fixture(); await f.manager.start(target); await f.manager.tick();
  f.reply({ status: 'ready', plan: { ...plan, maxRounds: null, minutes: null } }); await f.manager.tick();
  await f.manager.message(target, '开始'); await f.manager.tick();
  for (let i = 0; i < 3; i++) {
    f.reply({ status: 'continue', summary: '尚无结论', next: `验证另一假设 ${i}`, progress: false });
    await f.manager.tick(); await f.manager.tick();
  }
  assert.equal(f.state().status, 'running'); assert.equal(f.state().round, 4);
  assert.equal(f.state().plan.goal, plan.goal);
  assert.match(f.sent.at(-1), /调整.*假设.*方法/);
  assert.match(f.sent.at(-1), /验证另一假设 2/);
  f.reply({ status: 'blocked', summary: '需要用户授权读取额外数据' }); await f.manager.tick();
  assert.equal(f.state().status, 'paused');
});

test('removing a finite budget cannot be implicitly approved by a direction change', async () => {
  const f = fixture(); await f.run();
  await f.manager.message(target, '调整方向，继续'); await f.manager.tick();
  f.reply({ status: 'ready', plan: { ...plan, maxRounds: null } }); await f.manager.tick();
  assert.equal(f.state().status, 'confirming'); assert.equal(f.state().plan.maxRounds, 3);
});

test('unlimited execution stops on an error and an omitted budget never becomes unlimited', async () => {
  const f = fixture(); await f.manager.start(target); await f.manager.tick();
  const missing = { ...plan }; delete missing.maxRounds;
  f.reply({ status: 'ready', plan: missing }); await f.manager.tick(); assert.equal(f.state().status, 'paused');
  await f.manager.message(target, '不设预算'); await f.manager.tick();
  f.reply({ status: 'ready', plan: { ...plan, maxRounds: null, minutes: null } }); await f.manager.tick();
  await f.manager.message(target, '开始'); await f.manager.tick();
  f.reply({ status: 'error', summary: '构建失败，需要检查依赖' }); await f.manager.tick();
  assert.equal(f.state().status, 'paused'); assert.match(f.state().reason, /构建失败/);
  const sent = f.sent.length; await f.manager.tick(); assert.equal(f.sent.length, sent);
});

test('autonomy continues once per result without browser subscribers and stops at the round limit', async () => {
  const f = fixture(); await f.run();
  for (let round = 1; round <= 3; round++) {
    f.reply({ status: 'continue', summary: `Fixed ${round}`, next: 'Next test', progress: true });
    await Promise.all([f.manager.tick(), f.manager.tick()]);
    await f.manager.tick();
  }
  assert.equal(f.state().status, 'limit'); assert.equal(f.state().round, 3);
  assert.equal(f.sent.length, 4);
});

test('completion requires current final assistant evidence, not stale, tool or unfinished output', async () => {
  for (const options of [{ type: 'commandExecution' }, { status: 'inProgress' }, { nonce: 'old' }]) {
    const f = fixture(); await f.run();
    f.reply({ status: 'complete', summary: 'Done', evidence: 'tests passed' }, options);
    await f.manager.tick(); assert.notEqual(f.state().status, 'completed'); assert.equal(f.sent.length, 2);
  }
  const f = fixture(); await f.run();
  f.reply({ status: 'complete', summary: 'Done', evidence: 'Regression test passed' });
  await f.manager.tick(); assert.equal(f.state().status, 'completed'); assert.equal(f.state().round, 1);
});

test('setup sends immediately while foreground or background work runs, without interrupting it', async () => {
  for (const busy of ['foreground', 'background']) {
    const f = fixture(); const policies = [];
    const send = f.manager.send;
    f.manager.send = (...args) => { policies.push(args[3]); return send(...args); };
    f.session.hasRunningProcess = busy === 'foreground';
    f.session.agent.hasBackgroundProcess = busy === 'background';
    await f.manager.start(target); await f.manager.tick();
    assert.equal(f.sent.length, 1, busy); assert.equal(f.state().round, 0);
    assert.equal(policies.length, 1);
    assert.equal(policies[0].requireIdle, false); assert.equal(policies[0].nonInterrupting, true);
    assert.equal(policies[0].commandId, f.manager.runs.get(autonomyKey(target)).exchange.commandId);
    assert.equal(autonomyPresentation(f.state()).detail, '配置中');
    await f.manager.tick(); assert.equal(f.sent.length, 1, 'busy setup must not be resent');
    f.session.hasRunningProcess = false;
    f.reply({ status: 'ready', plan }); await f.manager.tick();
    assert.equal(f.state().status, 'confirming', 'background work must not block setup results');
  }
});

test('Qoder empty composer without input receipt times out even while foreground and background stay busy', async () => {
  const qoder = { ...target, provider: 'qodercli' };
  const f = fixture(); f.session.agent.kind = 'qodercli';
  f.session.hasRunningProcess = true; f.session.agent.hasBackgroundProcess = true;
  await f.manager.start(qoder); await f.manager.tick();
  await f.manager.tick(); f.now += 30_001; await f.manager.tick();
  assert.equal(f.manager.snapshot(qoder).status, 'paused');
  assert.match(f.manager.snapshot(qoder).reason, /送达.*未确认|未确认送达/);
  await f.manager.tick(); assert.equal(f.sent.length, 1);
});

test('configuration replies are parsed while old foreground work is still busy', async () => {
  const f = fixture(); f.session.hasRunningProcess = true;
  await f.manager.start(target); await f.manager.tick();
  f.reply({ status: 'ready', plan }); await f.manager.tick();
  assert.equal(f.state().status, 'confirming'); assert.equal(f.state().round, 0);
});

test('received configuration has a bounded response wait independent of background work', async () => {
  const qoder = { ...target, provider: 'qodercli' };
  const f = fixture(); f.session.agent.kind = 'qodercli'; f.session.agent.hasBackgroundProcess = true;
  await f.manager.start(qoder); await f.manager.tick();
  const exchange = f.manager.runs.get(autonomyKey(qoder)).exchange;
  f.thread.receivedDeliveryIds = [exchange.commandId]; await f.manager.tick();
  f.now += 120_001; await f.manager.tick();
  assert.equal(f.manager.snapshot(qoder).status, 'paused');
  assert.match(f.manager.snapshot(qoder).reason, /配置回复/);
  assert.equal(f.sent.length, 1);
});

test('native questions block setup without automatic approval', async () => {
  const f = fixture(); f.session.agent.question = { id: 'permission' };
  await f.manager.start(target); await f.manager.tick();
  await f.manager.tick(); assert.equal(f.sent.length, 0);
  f.session.agent.question = null; await f.manager.tick(); assert.equal(f.sent.length, 1);
});

test('explicit A migrates legacy Qoder setup once, preferring existing results', async () => {
  for (const reply of ['missing', 'ask', 'ready']) {
    const qoder = { ...target, provider: 'qodercli' };
    const f = fixture(); f.session.agent.kind = 'qodercli';
    await f.manager.start(qoder); await f.manager.tick();
    const old = f.manager.runs.get(autonomyKey(qoder)).exchange;
    delete old.commandId; delete old.deliveryBaseline; delete old.receivedAt;
    if (reply === 'ready') f.reply({ status: 'ready', plan });
    if (reply === 'ask') f.reply({ status: 'ask', questions: [{ id: 'goal', header: '目标', question: '做什么？', options: ['修复', '研究'] }] });
    f.manager.pause(qoder); f.now += 60000;
    await Promise.all([f.manager.start(qoder), f.manager.start(qoder)]);
    await f.manager.tick(); await f.manager.tick();
    const state = f.manager.snapshot(qoder);
    assert.notEqual(state.status, 'paused', reply);
    assert.equal(f.sent.length, reply === 'missing' ? 2 : 1, reply);
    if (reply === 'missing') {
      const current = f.manager.runs.get(autonomyKey(qoder)).exchange;
      assert.ok(current.commandId); assert.notEqual(current.nonce, old.nonce);
    } else assert.ok(state.requestId, reply);
    assert.equal(state.round, 0);
  }
});

test('restart never sends legacy Qoder exchanges and explicit A never replays legacy work', async () => {
  for (const kind of ['config', 'round']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeck-legacy-autonomy-'));
    try {
      const file = path.join(dir, 'runs.json'); const qoder = { ...target, provider: 'qodercli' };
      const f = fixture({ file }); f.session.agent.kind = 'qodercli';
      await f.manager.start(qoder); await f.manager.tick();
      const run = f.manager.runs.get(autonomyKey(qoder));
      run.exchange.kind = kind; delete run.exchange.commandId; delete run.exchange.deliveryBaseline;
      if (kind === 'round') { run.round = 1; run.plan = plan; run.status = 'running'; }
      f.manager.changed(run); f.manager.close();
      const restored = fixture({ file }); restored.session.agent.kind = 'qodercli'; restored.now += 60000;
      await restored.manager.tick(); assert.equal(restored.sent.length, 0);
      assert.equal(restored.manager.snapshot(qoder).status, 'paused');
      await restored.manager.start(qoder); await restored.manager.tick();
      assert.equal(restored.sent.length, kind === 'config' ? 1 : 0);
      restored.manager.close();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test('legacy setup recovery never sends while history is unavailable or after a newer direction', async () => {
  for (const scenario of ['loading', 'error', 'redirect']) {
    const qoder = { ...target, provider: 'qodercli' }; const f = fixture(); f.session.agent.kind = 'qodercli';
    await f.manager.start(qoder); await f.manager.tick();
    delete f.manager.runs.get(autonomyKey(qoder)).exchange.commandId;
    f.manager.pause(qoder);
    if (scenario !== 'redirect') {
      f.thread[scenario === 'loading' ? 'historyLoading' : 'historyError'] = true;
      await assert.rejects(f.manager.start(qoder), /历史/);
    } else {
      let finish;
      f.manager.readThread = () => new Promise(resolve => { finish = resolve; });
      const recovery = f.manager.start(qoder);
      await f.manager.message(qoder, '新的目标'); finish({ thread: { turns: [] } }); await recovery;
      assert.equal(f.manager.runs.get(autonomyKey(qoder)).pending.text, '新的目标');
    }
    assert.equal(f.sent.length, 1);
  }
});

test('late send preparation cannot send or pause a replacement configuration', async () => {
  for (const fail of [false, true]) {
    let settle;
    const f = fixture({ prepare: () => new Promise((resolve, reject) => { settle = () => fail ? reject(new Error('old read failed')) : resolve({}); }) });
    await f.manager.start(target); const pending = f.manager.tick();
    for (let i = 0; !settle && i < 10; i++) await Promise.resolve();
    assert.ok(settle);
    await f.manager.message(target, '改为只定位原因'); settle(); await pending;
    assert.equal(f.state().status, 'configuring'); assert.equal(f.sent.length, 0);
    assert.equal(f.manager.runs.get(autonomyKey(target)).pending.text, '改为只定位原因');
  }
});

test('new-goal approval stops old work before dispatch and never cancels during configuration', async () => {
  const f = fixture(); const events = [];
  f.manager.stop = async (actualTarget, guard) => {
    assert.equal(actualTarget.paneId, '%7'); assert.equal(guard(), true);
    assert.equal(f.state().round, 0); events.push('stop');
    f.session.hasRunningProcess = false;
  };
  await f.ready(); assert.deepEqual(events, []);
  f.session.hasRunningProcess = true;
  const send = f.manager.send;
  f.manager.send = (...args) => { events.push('round'); return send(...args); };
  await f.manager.respond(target, { requestId: f.state().requestId, answers: { decision: ['按此目标开始'] } });
  await f.manager.tick();
  assert.deepEqual(events, ['stop', 'round']); assert.equal(f.state().round, 1);
  f.reply({ status: 'continue', summary: 'One done', next: 'Next', progress: true });
  await f.manager.tick(); await f.manager.tick();
  assert.deepEqual(events, ['stop', 'round', 'round'], 'automatic continuation must not cancel its own work');
});

test('failed or unverified cancellation pauses new-goal execution without spending a round', async () => {
  for (const scenario of ['failure', 'still-running', 'background', 'question', 'changed-pane']) {
    const f = fixture(); await f.ready(); f.session.hasRunningProcess = true;
    f.manager.stop = async () => {
      if (scenario === 'failure') throw new Error('停止失败');
      f.session.hasRunningProcess = scenario === 'still-running';
      f.session.agent.hasBackgroundProcess = scenario === 'background';
      if (scenario === 'question') f.session.agent.question = { id: 'old-permission' };
      if (scenario === 'changed-pane') f.session.agent.paneId = '%8';
    };
    await f.manager.message(target, '开始'); await f.manager.tick();
    assert.equal(f.state().status, 'paused', scenario); assert.equal(f.state().round, 0, scenario);
    assert.equal(f.sent.length, 1, scenario);
    await f.manager.tick(); assert.equal(f.sent.length, 1, 'failed cancellation is never retried automatically');
  }
});

test('pause or direction change while stopping invalidates the new-goal dispatch', async () => {
  for (const action of ['pause', 'redirect']) {
    const f = fixture(); await f.ready(); let finish;
    f.manager.stop = () => new Promise(resolve => { finish = resolve; });
    await f.manager.message(target, '开始'); const tick = f.manager.tick();
    for (let step = 0; !finish && step < 10; step++) await Promise.resolve();
    assert.ok(finish);
    if (action === 'pause') f.manager.pause(target);
    else await f.manager.message(target, '换个目标，不要执行');
    finish(); await tick;
    assert.equal(f.state().round, 0); assert.equal(f.sent.length, 1);
    assert.equal(f.state().status, action === 'pause' ? 'paused' : 'configuring');
  }
});

test('Qoder configuration sends while busy and distinguishes preparing, questions and approval', async () => {
  const qoderTarget = { ...target, provider: 'qodercli' };
  const f = fixture(); f.session.agent.kind = 'qodercli'; f.session.hasRunningProcess = true;
  const state = () => f.manager.snapshot(qoderTarget);
  await f.manager.start(qoderTarget); await f.manager.tick();
  assert.equal(autonomyPresentation(state()).detail, '配置中');
  assert.equal(autonomyPresentation(state()).label, '暂停自主配置');
  assert.equal(f.sent.length, 1); assert.equal(state().round, 0);
  assert.equal('pending' in state(), false); assert.equal('exchange' in state(), false);
  f.manager.pause(qoderTarget); f.session.hasRunningProcess = false;
  await f.manager.tick(); assert.equal(f.sent.length, 1, 'pausing setup cannot send it again');
  await f.manager.start(qoderTarget); await f.manager.tick();
  assert.equal(autonomyPresentation(state()).detail, '配置中');
  assert.equal(autonomyPresentation(state()).label, '暂停自主配置');
  f.reply({ status: 'ask', questions: [{ id: 'goal', header: '目标', question: '推进哪项？', options: ['修复选择器', '只定位'] }] });
  await f.manager.tick();
  assert.equal(autonomyPresentation(state()).detail, '待回答');
  await f.manager.respond(qoderTarget, { requestId: state().requestId, answers: { goal: ['修复选择器'] } });
  await f.manager.tick(); f.reply({ status: 'ready', plan }); await f.manager.tick();
  assert.equal(autonomyPresentation(state()).detail, '0/3 待确认');
  await f.manager.tick(); assert.equal(state().round, 0); assert.equal(f.sent.length, 2, 'resume observes setup instead of resending it');
});

test('native question dismissal restores the queued or in-flight phase even while the Agent is busy', async () => {
  for (const phase of ['config-queued', 'config-sent', 'round-queued', 'round-sent']) {
    const f = fixture();
    if (phase.startsWith('round')) {
      await f.run();
      f.reply({ status: 'continue', summary: 'Next', next: 'Continue', progress: true });
      await f.manager.tick();
    }
    else await f.manager.start(target);
    if (phase.endsWith('sent')) await f.manager.tick();
    const sends = f.sent.length;
    f.session.agent.question = { id: 'permission' };
    await f.manager.tick(); assert.equal(f.state().status, 'blocked', phase);
    assert.match(autonomyPresentation(f.state()).detail, /待处理/);
    f.session.agent.question = null; f.session.hasRunningProcess = true;
    await f.manager.tick();
    assert.equal(f.state().status, phase.startsWith('config') ? 'configuring'
      : phase.endsWith('queued') ? 'queued' : 'running', phase);
    assert.equal(f.sent.length, sends + (phase === 'config-queued' ? 1 : 0),
      'clearing a question can send setup into a busy Agent, never an execution round');
  }
});

test('a native question during background wait does not permanently stop autonomy polling', async () => {
  const f = fixture(); await f.run(); f.session.agent.hasBackgroundProcess = true;
  f.reply({ status: 'wait', summary: 'Training', next: 'Check result', progress: true });
  await f.manager.tick();
  f.session.agent.question = { id: 'permission' }; await f.manager.tick();
  assert.equal(f.state().status, 'blocked');
  f.session.agent.question = null; await f.manager.tick();
  assert.equal(f.state().status, 'waiting'); assert.equal(f.sent.length, 2);
  f.session.agent.hasBackgroundProcess = false; await f.manager.tick(); await f.manager.tick();
  assert.equal(f.state().round, 2); assert.equal(f.sent.length, 3);
});

test('pause cancels a continuation already waiting on a read and keeps spent rounds', async () => {
  const f = fixture(); await f.run();
  f.reply({ status: 'continue', summary: 'Tested', next: 'Fix remaining', progress: true });
  await f.manager.tick();
  let finish; f.manager.readSession = () => new Promise(resolve => { finish = resolve; });
  const pending = f.manager.tick();
  await Promise.resolve(); f.manager.pause(target);
  finish(f.session); await pending;
  assert.equal(f.sent.length, 2); assert.equal(f.state().round, 1); assert.equal(f.state().status, 'paused');
});

test('redirection invalidates prior responses and preserves used budget until a new proposal is confirmed', async () => {
  const f = fixture(); await f.run();
  const old = f.sent.at(-1);
  await f.manager.message(target, '只修后端，先别继续'); await f.manager.tick();
  f.reply({ status: 'ready', plan: { ...plan, goal: 'Backend only' } }); await f.manager.tick();
  assert.equal(f.state().round, 1); assert.equal(f.state().status, 'confirming');
  await f.manager.message(target, '继续'); await f.manager.tick();
  assert.equal(f.state().round, 2); assert.match(f.sent.at(-1), /Backend only/);
  f.reply({ status: 'complete', summary: 'old', evidence: 'old' }, { nonce: /"nonce":"([^"]+)"/.exec(old)[1] });
  await f.manager.tick(); assert.notEqual(f.state().status, 'completed');
});

test('unconfirmed sends and changed pane pause without retries', async () => {
  const uncertain = fixture({ send: async () => ({ submissionStatus: 'unconfirmed' }) });
  await uncertain.manager.start(target); await uncertain.manager.tick();
  assert.equal(uncertain.state().status, 'paused'); assert.match(uncertain.state().reason, /未确认/);
  const f = fixture(); await f.run();
  f.session.agent.paneId = '%8'; await f.manager.tick();
  assert.equal(f.state().status, 'paused'); assert.equal(f.sent.length, 2);
});

test('background wait spends no rounds; deadline stops further dispatch', async () => {
  const f = fixture(); await f.run(); f.session.agent.hasBackgroundProcess = true;
  f.reply({ status: 'wait', summary: 'Training', next: 'Check result', progress: true });
  await f.manager.tick(); await f.manager.tick();
  assert.equal(f.state().status, 'waiting'); assert.equal(f.state().round, 1);
  f.session.agent.hasBackgroundProcess = false; await f.manager.tick(); await f.manager.tick();
  assert.equal(f.state().round, 2);
  f.now += 31 * 60_000; await f.manager.tick();
  assert.equal(f.state().status, 'limit'); assert.equal(f.sent.length, 3);
});

test('a separate progress response does not hide a completed autonomous result', async () => {
  const f = fixture(); await f.run();
  f.reply({ status: 'complete', summary: 'Fixed', evidence: 'regression passed' });
  f.thread.turns.push({ id: 'progress', status: 'completed', items: [
    { type: 'userMessage', content: AUTONOMY_PROGRESS_PROMPT },
    { type: 'agentMessage', text: 'Goal: fix picker. Gap: none.' },
  ] });
  await f.manager.tick();
  assert.equal(f.state().status, 'completed'); assert.equal(f.state().round, 1);
});

test('invalid plans, missing completion evidence and unrelated human input cannot continue', async () => {
  for (const change of [{ maxRounds: 0 }, { maxRounds: 1.5 }, { maxRounds: '100' },
    { maxRounds: Number.MAX_SAFE_INTEGER + 1 }, { acceptance: '' }, { minutes: -1 }, { minutes: '30' }]) {
    const f = fixture(); await f.manager.start(target); await f.manager.tick();
    f.reply({ status: 'ready', plan: { ...plan, ...change } }); await f.manager.tick();
    assert.equal(f.state().status, 'paused'); assert.equal(f.state().round, 0);
  }
  const f = fixture(); await f.run(); f.reply({ status: 'complete', summary: 'Done' });
  await f.manager.tick(); assert.equal(f.state().status, 'paused');
  const manual = fixture(); await manual.run();
  manual.reply({ status: 'continue', summary: 'Tested', next: 'Fix', progress: true });
  manual.thread.turns.push({ items: [{ type: 'userMessage', content: 'Stop the task' }] });
  await manual.manager.tick(); assert.equal(manual.state().status, 'paused'); assert.equal(manual.sent.length, 2);
});

test('persistent transcript failures pause rather than silently hang', async () => {
  const f = fixture(); await f.run();
  f.manager.readThread = async () => ({ thread: { historyError: 'reader failed' } });
  await f.manager.tick();
  f.now += 31_000; await f.manager.tick();
  assert.equal(f.state().status, 'paused'); assert.match(f.state().reason, /读取/);
  assert.equal(f.sent.length, 2);
});

test('a slow session does not hold another session in the controller queue', async () => {
  const f = fixture(); await f.manager.start(target);
  const another = { ...target, tmuxSession: 'other', threadId: 'thread-2' };
  const otherSession = { name: 'other', agent: { ...f.session.agent, id: 'thread-2', paneId: '%8' } };
  f.manager.readSession = async () => otherSession; await f.manager.start(another);
  let finish;
  f.manager.readSession = async value => value.tmuxSession === 'work'
    ? new Promise(resolve => { finish = resolve; }) : otherSession;
  const pending = f.manager.tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.sent.length, 1);
  f.manager.pause(target); finish(f.session); await pending;
  assert.equal(f.sent.length, 1);
});

test('an obsolete read failure cannot pause a newly supplied direction', async () => {
  const f = fixture(); await f.run();
  let fail;
  f.manager.readThread = () => new Promise((_resolve, reject) => { fail = reject; });
  const pending = f.manager.tick(); await new Promise(resolve => setImmediate(resolve));
  await f.manager.message(target, '改成只修后端'); fail(new Error('old reader failed')); await pending;
  assert.equal(f.state().status, 'configuring');
});

test('restart restores paused state without replaying uncertain side effects', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeck-autonomy-test-'));
  try {
    const file = path.join(dir, 'runs.json'); const f = fixture({ file }); await f.run(); f.manager.close();
    const restored = fixture({ file });
    assert.equal(restored.state().status, 'paused'); assert.equal(restored.state().round, 1);
    await restored.manager.tick(); assert.equal(restored.sent.length, 0);
    assert.equal(restored.state().plan.goal, plan.goal);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('restart during cancellation never repeats the stop or starts the new goal', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeck-autonomy-switch-test-'));
  try {
    const file = path.join(dir, 'runs.json'); const f = fixture({ file }); await f.ready();
    let finish;
    f.manager.stop = () => new Promise(resolve => { finish = resolve; });
    await f.manager.message(target, '开始'); const tick = f.manager.tick();
    for (let step = 0; !finish && step < 10; step++) await Promise.resolve();
    assert.ok(finish); assert.equal(f.state().status, 'switching');
    f.manager.close();
    const restored = fixture({ file, stop: async () => assert.fail('must not replay cancellation') });
    await restored.manager.tick();
    assert.equal(restored.state().status, 'paused'); assert.equal(restored.state().round, 0);
    assert.deepEqual(restored.sent, []);
    finish(); await tick; assert.equal(f.sent.length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('restart after receiving setup choices recovers the dialog from artifacts without replay', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeck-autonomy-choices-'));
  try {
    const file = path.join(dir, 'runs.json'); const f = fixture({ file });
    await f.manager.start(target); await f.manager.tick();
    f.reply({ status: 'ask', questions: [{ id: 'goal', header: '目标', question: '要做哪项？', options: ['修复', '研究'] }] });
    // The CLI effect succeeded, but its controller acknowledgment was lost.
    f.manager.close();
    const restored = fixture({ file });
    restored.manager.restoreProposal(target, { id: target.threadId, ...f.thread });
    assert.equal(restored.state().status, 'configuring');
    assert.ok(restored.state().requestId); assert.equal(restored.state().questions.length, 1);
    await restored.manager.tick(); assert.deepEqual(restored.sent, []); assert.equal(restored.state().round, 0);
    await assert.rejects(restored.manager.respond(target, { requestId: 'obsolete', answers: { goal: ['修复'] } }));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('compact autonomy presentation and hidden protocol retain human-facing conversation', () => {
  assert.equal(autonomyPresentation(null).text, 'Ⓐ');
  assert.equal(autonomyPresentation({ status: 'configuring' }).text, 'Ⓐ 配置中');
  assert.equal(autonomyPresentation({ status: 'configuring', configurationQueued: true }).text, 'Ⓐ 配置中');
  assert.equal(autonomyPresentation({ status: 'switching', round: 0, plan }).text, 'Ⓐ 0/3 切换中');
  assert.equal(autonomyPresentation({ status: 'switching' }).active, true);
  assert.equal(autonomyPresentation({ status: 'running', round: 2, plan }).text, 'Ⓐ 2/3');
  assert.match(autonomyPresentation({ status: 'paused', round: 2, plan }).text, /2\/3 已暂停/);
  assert.notEqual(autonomyKey(target), autonomyKey({ ...target, threadId: 'another' }));
  assert.equal(autonomyDisplayText('Done\n\n```codeck-autonomy\n{"nonce":"x"}\n```'), 'Done');
});
