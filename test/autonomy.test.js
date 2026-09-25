import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AutonomyController } from '../src/autonomy.js';
import { autonomyKey, autonomyPresentation, autonomyDisplayText, AUTONOMY_PROGRESS_PROMPT } from '../public/remote-autonomy.js';

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
    assert.deepEqual(policies, [{ requireIdle: false, nonInterrupting: true }]);
    assert.equal(autonomyPresentation(f.state()).detail, '配置中');
    await f.manager.tick(); assert.equal(f.sent.length, 1, 'busy setup must not be resent');
    f.session.hasRunningProcess = false;
    f.reply({ status: 'ready', plan }); await f.manager.tick();
    assert.equal(f.state().status, 'confirming', 'background work must not block setup results');
  }
});

test('native questions block setup without automatic approval', async () => {
  const f = fixture(); f.session.agent.question = { id: 'permission' };
  await f.manager.start(target); await f.manager.tick();
  await f.manager.tick(); assert.equal(f.sent.length, 0);
  f.session.agent.question = null; await f.manager.tick(); assert.equal(f.sent.length, 1);
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

test('unconfirmed sends, changed pane and two no-progress rounds pause without retries', async () => {
  const uncertain = fixture({ send: async () => ({ submissionStatus: 'unconfirmed' }) });
  await uncertain.manager.start(target); await uncertain.manager.tick();
  assert.equal(uncertain.state().status, 'paused'); assert.match(uncertain.state().reason, /未确认/);
  const f = fixture(); await f.run();
  f.session.agent.paneId = '%8'; await f.manager.tick();
  assert.equal(f.state().status, 'paused'); assert.equal(f.sent.length, 2);
  const stuck = fixture(); await stuck.run();
  for (let n = 0; n < 2; n++) {
    stuck.reply({ status: 'continue', summary: 'Same failure', next: 'Retry', progress: false });
    await stuck.manager.tick(); await stuck.manager.tick();
  }
  assert.equal(stuck.state().status, 'paused'); assert.equal(stuck.state().round, 2);
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
  for (const change of [{ maxRounds: 0 }, { maxRounds: 101 }, { acceptance: '' }, { minutes: -1 }]) {
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
