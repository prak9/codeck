import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { AgentHub, AgentRegistry } from '../src/agent-connection.js';
import { AutonomyController } from '../src/autonomy.js';
import { AUTONOMY_PROGRESS_PROMPT, autonomyKey } from '../public/remote-autonomy.js';

class Socket extends EventEmitter {
  readyState = 1;
  sent = [];
  send(raw) { this.sent.push(JSON.parse(raw)); }
}
const target = { provider: 'codex', threadId: 'thread', tmuxSession: 'work' };
async function fixture({ openThread = true } = {}) {
  const sent = []; const interrupted = []; const submissions = [];
  const backend = new EventEmitter(); backend.openThread = async () => ({ thread: { id: 'thread', turns: [] } });
  const registry = new AgentRegistry({ codex: backend }, {
    sendTmuxMessage: async params => { sent.push(params.text); submissions.push(params); return { submissionStatus: 'submitted' }; },
    interruptTmuxSession: async params => interrupted.push(params),
  });
  const autonomy = new AutonomyController({
    readSession: async () => ({ name: 'work', agent: { id: 'thread', kind: 'codex', paneId: '%7' } }),
    readThread: () => backend.openThread(), send: async (_target, text) => { sent.push(text); return {}; },
    schedule: () => 1, cancel() {},
  });
  const hub = new AgentHub(registry, { autonomy }); const socket = new Socket(); hub.handleConnection(socket);
  let id = 0;
  const request = async (type, params = {}) => {
    const requestId = ++id;
    socket.emit('message', JSON.stringify({ id: requestId, type, ...target, ...params }));
    for (let attempt = 0; attempt < 50; attempt++) {
      const reply = socket.sent.find(message => message.id === requestId);
      if (reply) return reply;
      await new Promise(resolve => setImmediate(resolve));
    }
    throw new Error(`No response: ${type}`);
  };
  if (openThread) await request('openThread', { readOnly: true });
  return { sent, submissions, interrupted, autonomy, socket, hub, registry, backend, request };
}

test('normal mode binds autonomy without subscribing to history', async () => {
  const f = await fixture({ openThread: false });
  f.backend.openThread = async () => assert.fail('binding must not read history');
  assert.equal(f.socket.sent[0].autonomySessionBinding, true);
  assert.equal((await f.request('startAutonomy', { commandId: 'normal-unbound' })).ok, false);
  assert.equal((await f.request('bindAutonomySession')).ok, true);
  assert.equal(f.hub.clients.get(f.socket).threadSubscription, null);
  assert.equal((await f.request('startAutonomy', { commandId: 'normal-foreign', tmuxSession: 'other' })).ok, false);
  assert.equal((await f.request('startAutonomy', { commandId: 'normal-bound' })).ok, true);
  await f.autonomy.tick(); assert.equal(f.sent.length, 1);
  await f.request('sendSessionMessage', { commandId: 'bound-progress', text: AUTONOMY_PROGRESS_PROMPT });
  assert.equal(f.hub.clients.get(f.socket).threadSubscription, null, 'progress must not retain a history stream in normal mode');
  await f.request('sendSessionMessage', { commandId: 'bound-direction', text: '只修改后端' });
  assert.equal(f.hub.clients.get(f.socket).threadSubscription, null);
});

test('explicit normal binding cannot fall back to an older history target after unbinding', async () => {
  const f = await fixture();
  await f.request('bindAutonomySession');
  await f.request('startAutonomy', { commandId: 'normal-start' });
  await f.request('sendSessionMessage', { commandId: 'normal-progress', text: AUTONOMY_PROGRESS_PROMPT });
  await f.request('bindAutonomySession', { threadId: null, tmuxSession: null });
  assert.equal((await f.request('pauseAutonomy', { commandId: 'normal-stale' })).ok, false);
  assert.equal(f.autonomy.snapshot(target).status, 'configuring');
});

test('normal mode and Remote observe the same autonomous run', async () => {
  const f = await fixture({ openThread: false });
  await f.request('bindAutonomySession'); await f.request('startAutonomy', { commandId: 'normal-start' });
  await f.autonomy.tick(); const before = f.autonomy.snapshot(target);
  const other = new Socket(); f.hub.handleConnection(other);
  assert.equal(other.sent[0].autonomy[0].id, before.id);
  await f.request('pauseAutonomy', { commandId: 'normal-pause' });
  assert.equal(other.sent.at(-1).run.status, 'paused');
  assert.equal(other.sent.at(-1).run.id, before.id);
  assert.equal(f.sent.length, 1); assert.equal(f.interrupted.length, 0);
});

test('progress is a non-interrupting question, not autonomy start, redirection or another round', async () => {
  const f = await fixture();
  await f.request('sendSessionMessage', { commandId: 'progress-idle', text: AUTONOMY_PROGRESS_PROMPT });
  assert.equal(f.autonomy.snapshot(target), null);
  assert.equal(f.submissions[0].nonInterrupting, true);
  await f.request('startAutonomy', { commandId: 'start' }); await f.autonomy.tick();
  const before = f.autonomy.snapshot(target);
  await f.request('sendSessionMessage', { commandId: 'progress-active', text: AUTONOMY_PROGRESS_PROMPT });
  assert.deepEqual(f.autonomy.snapshot(target), before);
  assert.equal(f.interrupted.length, 0);
});

test('read-only status queries keep continuation; mutating commands still pause it', async () => {
  const f = await fixture(); await f.request('startAutonomy', { commandId: 'start-query' }); await f.autonomy.tick();
  const before = f.autonomy.snapshot(target);
  for (const text of ['/status', '/usage']) {
    const response = await f.request('sendSessionMessage', { commandId: `query-${text.slice(1)}`, text });
    assert.equal(response.ok, true, response.error);
    assert.deepEqual(f.autonomy.snapshot(target), before);
    assert.equal(f.submissions.at(-1).nonInterrupting, true);
  }
  await f.request('sendSessionMessage', { commandId: 'model-change', text: '/model' });
  assert.equal(f.autonomy.snapshot(target).status, 'paused');
});

test('owner Agent API binds start to the open session and deduplicates control requests', async () => {
  const f = await fixture();
  assert.deepEqual(f.socket.sent[0].autonomy, []);
  assert.equal((await f.request('startAutonomy', { tmuxSession: 'other', commandId: 'start-other' })).ok, false);
  assert.equal((await f.request('startAutonomy', { commandId: 'start-work' })).ok, true);
  await f.autonomy.tick();
  await f.request('startAutonomy', { commandId: 'start-work' }); await f.autonomy.tick();
  assert.equal(f.sent.length, 1);
  assert.ok(f.socket.sent.some(message => message.type === 'autonomyState'));
  const reconnect = new Socket(); f.hub.handleConnection(reconnect);
  assert.equal(reconnect.sent[0].autonomy.length, 1);
});

test('Remote manual instructions reconfigure rather than racing the loop; stop also pauses it', async () => {
  const f = await fixture(); await f.request('startAutonomy', { commandId: 'start-work' });
  await f.autonomy.tick();
  const reply = await f.request('sendSessionMessage', { commandId: 'manual-direction', text: '只改后端，先别继续' });
  assert.equal(reply.result.autonomyHandled, true); assert.equal(f.sent.length, 1);
  await f.autonomy.tick(); assert.match(f.sent.at(-1), /只改后端/);
  await f.request('interruptSession');
  assert.equal(f.autonomy.snapshot(target).status, 'paused'); assert.equal(f.interrupted.length, 1);
  await f.autonomy.tick(); assert.equal(f.sent.length, 2);
});

test('permission requests pause autonomy; they are not automatically answered', async () => {
  const f = await fixture(); await f.request('startAutonomy', { commandId: 'start-work' });
  f.registry.emit('serverRequest', { provider: 'codex', id: 42, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread' } });
  assert.equal(f.autonomy.snapshot(target).status, 'paused'); await f.autonomy.tick(); assert.equal(f.sent.length, 0);
});

test('verified stop locks continuation until completion and forwards the explicit scope', async () => {
  const f = await fixture(); await f.request('startAutonomy', { commandId: 'start-stop' });
  await f.autonomy.tick();
  let finish;
  f.registry.interruptSession = async (_provider, params) => {
    assert.equal(params.waitForIdle, true); assert.equal(params.stopBackground, true);
    return new Promise(resolve => { finish = resolve; });
  };
  const stopping = f.request('interruptSession', { scope: 'all', commandId: 'stop-all' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.autonomy.snapshot(target).status, 'stopping');
  assert.equal((await f.request('startAutonomy', { commandId: 'racing-resume' })).ok, false);
  await f.autonomy.tick(); assert.equal(f.sent.length, 1);
  finish(); assert.equal((await stopping).ok, true);
  assert.equal(f.autonomy.snapshot(target).status, 'paused');
});

test('failed verified stop stays paused with a visible failure, never claims success', async () => {
  const f = await fixture(); await f.request('startAutonomy', { commandId: 'start-failure' });
  f.registry.interruptSession = async () => { throw new Error('后台任务仍在运行'); };
  const result = await f.request('interruptSession', { scope: 'all', commandId: 'stop-failed' });
  assert.equal(result.ok, false);
  assert.match(f.autonomy.snapshot(target).reason, /停止未确认.*后台/);
  await f.autonomy.tick(); assert.equal(f.sent.length, 0);
});

test('cached progress buttons remain non-interrupting after the prompt changes', async () => {
  const f = await fixture();
  await f.request('startAutonomy', { commandId: 'start-work' }); await f.autonomy.tick();
  const before = f.autonomy.snapshot(target);
  const text = '现在进展怎么样？这是一次进度问询，请在不打断当前工作的自然汇报节点简要回答，不改变当前节奏，不催促续跑，也不进入自主模式。请复述你理解的当前目标，必须是具体、拆解过的子目标，不能只给笼统概括。沿用已确认的任务拆解，逐项简要列出：子目标、完成标准、当前状态及证据、距完成的差距（gap）；再说明下一步优先推进哪项、有什么阻塞或需要我决策。目标或边界不明确时标出待确认部分，不把推测当成已确认要求，不扩大范围或重置已有预算。若处于 Codeck 自主轮次中，保持原有轮次和结果协议；本次问询不构成新一轮执行授权。';
  const prompts = [text, '请在方便时简报：你理解的目标及具体子目标、逐项完成标准、进展/证据、剩余gap、下一步和阻塞。不确定处标出；不打断、不续跑、不改方向、模式或预算。'];
  for (const [index, cached] of prompts.entries()) {
    assert.equal((await f.request('sendSessionMessage', { commandId: `cached-progress-${index}`, text: cached })).ok, true);
    assert.deepEqual(f.autonomy.snapshot(target), before);
    assert.equal(f.submissions.at(-1).nonInterrupting, true);
  }
});

test('choice answers bind to the subscribed session and deduplicate before starting work', async () => {
  const f = await fixture(); await f.request('startAutonomy', { commandId: 'start-work' });
  const run = f.autonomy.runs.get(autonomyKey(target));
  Object.assign(run, { status: 'confirming', requestId: 'config-request', pending: null,
    proposal: { goal: '修复弹窗', acceptance: '回归通过', preferences: '不部署', maxRounds: 3, minutes: null } });
  const answer = { commandId: 'approve-goal', requestId: run.requestId, answers: { decision: ['按此目标开始'] } };
  assert.equal((await f.request('answerAutonomy', { ...answer, tmuxSession: 'other' })).ok, false);
  assert.equal(f.sent.length, 0);
  assert.equal((await f.request('answerAutonomy', answer)).ok, true);
  await f.autonomy.tick();
  assert.equal((await f.request('answerAutonomy', answer)).ok, true);
  assert.equal((await f.request('answerAutonomy', { ...answer, commandId: 'stale-goal' })).ok, false);
  await f.autonomy.tick(); assert.equal(f.sent.length, 1); assert.equal(run.round, 1);
});

test('opening report restores its lost ready proposal without sending configuration or work', async () => {
  const f = await fixture(); await f.request('startAutonomy', { commandId: 'start-work' }); await f.autonomy.tick();
  const text = f.sent[0]; const nonce = /"nonce":"([^"]+)"/.exec(text)[1];
  f.autonomy.pause(target, '终端输入框未就绪');
  f.backend.openThread = async () => ({ thread: { id: target.threadId, turns: [{ status: 'completed', items: [
    { type: 'userMessage', content: text },
    { type: 'agentMessage', text: '配置完成\n\n```codeck-autonomy\n' + JSON.stringify({ nonce, status: 'ready',
      plan: { goal: '收尾诊断并验证一个候选', acceptance: '完成对照并交付裁决', preferences: '不改生产，不部署', maxRounds: 5, minutes: null } }) + '\n```' },
  ] }] } });
  assert.equal((await f.request('openThread', { readOnly: true })).ok, true);
  const run = f.autonomy.snapshot(target);
  assert.equal(run.status, 'confirming'); assert.equal(run.proposal.maxRounds, 5);
  assert.ok(f.socket.sent.some(message => message.type === 'autonomyState' && message.run.requestId === run.requestId));
  await f.autonomy.tick(); assert.equal(f.sent.length, 1);
  assert.equal((await f.request('answerAutonomy', { commandId: 'confirm-report', requestId: run.requestId,
    answers: { decision: ['按此目标开始'] } })).ok, true);
  await f.autonomy.tick(); assert.equal(f.sent.length, 2);
  assert.match(f.sent.at(-1), /"phase":"round"/);
});

for (const method of ['openThread', 'bindAutonomySession']) test(`${method} recovers research choices without sending continue again`, async () => {
  const f = await fixture(); await f.request('startAutonomy', { commandId: 'start-work' }); await f.autonomy.tick();
  const text = f.sent[0]; const nonce = /"nonce":"([^"]+)"/.exec(text)[1];
  f.autonomy.pause(target, '发送状态未确认');
  f.backend.openThread = async () => ({ thread: { id: target.threadId, turns: [{ status: 'completed', items: [
    { type: 'userMessage', content: text },
    { type: 'agentMessage', text: '请选择目标\n\n```codeck-autonomy\n' + JSON.stringify({ nonce, status: 'ask',
      questions: [{ id: 'goal', header: '目标', question: '推进到哪一步？', options: ['修复及离线原型', '只继续研究'] }] }) + '\n```' },
  ] }] } });
  await f.request(method, { readOnly: true });
  await new Promise(resolve => setImmediate(resolve));
  const run = f.autonomy.snapshot(target);
  assert.equal(run.status, 'configuring'); assert.ok(run.requestId); assert.equal(run.questions.length, 1);
  assert.ok(f.socket.sent.some(message => message.type === 'autonomyState' && message.run.requestId === run.requestId));
  await f.autonomy.tick(); assert.equal(f.sent.length, 1); assert.equal(f.interrupted.length, 0);
});
