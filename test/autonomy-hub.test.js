import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { AgentHub, AgentRegistry } from '../src/agent-connection.js';
import { AutonomyController } from '../src/autonomy.js';
import { writeReceipt } from '../src/autonomy-receipt.js';
import { AUTONOMY_PROGRESS_PROMPT, AUTONOMY_PLANNING_PROMPT, autonomyKey } from '../public/remote-autonomy.js';

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
    send: async (_target, text) => { sent.push(text); return {}; },
    schedule: () => 1, cancel() {},
  });
  const hub = new AgentHub(registry, { autonomy }); const socket = new Socket(); hub.handleConnection(socket);
  let id = 0;
  const request = async (type, params = {}) => {
    if (params.commandId) params = { ...params, commandId: params.commandId.padEnd(16, '-') };
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


const start = f => f.request('prepareAutonomyPlanning', { commandId: 'start' });
const approve = async f => {
  const run = [...f.autonomy.runs.values()][0];
  writeReceipt(['--receipt', run.observation.startFile, '--status', 'started', '--goal', '修复输入', '--summary', '用户确认']);
  await f.autonomy.tick();
};

test('planning shortcut sends once without stopping, extracting or starting managed autonomy', async () => {
  const f = await fixture({ openThread: false }); await f.request('bindAutonomySession');
  const params = { commandId: 'plan-once', text: AUTONOMY_PLANNING_PROMPT };
  assert.equal((await f.request('sendSessionMessage', params)).ok, true);
  assert.equal((await f.request('sendSessionMessage', params)).ok, true);
  assert.equal(f.sent.length, 1); assert.equal(f.interrupted.length, 0);
  assert.equal(f.submissions[0].nonInterrupting, true);
  assert.equal(f.autonomy.snapshot(target), null);
  assert.match(AUTONOMY_PLANNING_PROMPT, /确认前.*不执行/);
  assert.match(AUTONOMY_PLANNING_PROMPT, /按此计划开始.*调整计划.*取消/);
  f.autonomy.close();
});

test('prepared planning keeps exact delivery text, tracks only receipts and rejects stale targets', async () => {
  const f = await fixture({ openThread: false }); await f.request('bindAutonomySession');
  const prepared = await f.request('prepareAutonomyPlanning', { commandId: 'prep-observed' });
  assert.equal(prepared.ok, true);
  const { text, planningId } = prepared.result;
  assert.match(text, /^请基于最近的讨论/); assert.match(text, /--status started/);
  assert.equal(f.autonomy.snapshot(target).status, 'planning'); assert.equal(f.sent.length, 0);
  const params = { commandId: 'send-observed', text, planningId };
  assert.equal((await f.request('sendSessionMessage', params)).ok, true);
  assert.equal((await f.request('sendSessionMessage', params)).ok, true);
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0], text); assert.equal(f.submissions[0].nonInterrupting, true);
  assert.equal((await f.request('prepareAutonomyPlanning', { commandId: 'foreign-prep', tmuxSession: 'other' })).ok, false);
  await f.request('resetAutonomy', { commandId: 'reset-observed' });
  assert.equal((await f.request('sendSessionMessage', { ...params, commandId: 'late-observed' })).ok, false);
  f.autonomy.close();
});

test('binding is scoped and setup never injects configuration into a terminal', async () => {
  const f = await fixture({ openThread: false });
  assert.equal((await start(f)).ok, false);
  await f.request('bindAutonomySession');
  assert.equal((await f.request('prepareAutonomyPlanning', { commandId: 'foreign', tmuxSession: 'other' })).ok, false);
  assert.equal((await start(f)).ok, true);
  await f.autonomy.tick(); assert.equal(f.sent.length, 0);
  await f.request('sendSessionMessage', { commandId: 'progress', text: AUTONOMY_PROGRESS_PROMPT });
  assert.equal(f.hub.clients.get(f.socket).threadSubscription, null);
  assert.equal(f.submissions[0].nonInterrupting, true); assert.equal(f.submissions[0].replaceDraft, true);
  f.autonomy.close();
});

test('old configuration and scheduler APIs are rejected even for a bound owner', async () => {
  const f = await fixture();
  for (const type of ['startAutonomy', 'answerAutonomy', 'finishAutonomy', 'pauseAutonomy']) {
    assert.equal((await f.request(type, { commandId: type })).ok, false);
  }
  assert.equal(f.sent.length, 0); assert.equal(f.autonomy.snapshot(target), null); f.autonomy.close();
});

test('normal and Remote share the run; repeated exit sends one summary', async () => {
  const f = await fixture(); await start(f); await approve(f);
  const other = new Socket(); f.hub.handleConnection(other);
  assert.equal(other.sent[0].autonomy[0].id, f.autonomy.snapshot(target).id);
  await f.request('resetAutonomy', { commandId: 'finish' }); await f.request('resetAutonomy', { commandId: 'again' });
  assert.equal(other.sent.at(-1).run.status, 'off'); await f.autonomy.tick(); assert.equal(f.sent.length, 1);
  f.autonomy.close();
});

test('progress and manual input are ordinary messages and preserve autonomy', async () => {
  const f = await fixture(); await start(f); await new Promise(resolve => setImmediate(resolve));
  const before = f.autonomy.snapshot(target);
  for (const text of [AUTONOMY_PROGRESS_PROMPT, '/status', '/usage']) {
    assert.equal((await f.request('sendSessionMessage', { commandId: `query-${text.length}`, text })).ok, true);
    assert.deepEqual(f.autonomy.snapshot(target), before); assert.equal(f.submissions.at(-1).nonInterrupting, true);
  }
  const reply = await f.request('sendSessionMessage', { commandId: 'direction', text: '只改后端' });
  assert.equal(reply.ok, true); assert.equal(reply.result.autonomyHandled, undefined);
  assert.equal(f.autonomy.snapshot(target).status, 'planning'); assert.equal(f.sent.at(-1), '只改后端');
  assert.equal(f.submissions.at(-1).replaceDraft, true); f.autonomy.close();
});

test('permission requests remain part of execution without automatic approval', async () => {
  const f = await fixture(); await start(f); await approve(f);
  f.registry.emit('serverRequest', { provider: 'codex', id: 42, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread' } });
  assert.equal(f.autonomy.snapshot(target).status, 'running'); assert.equal(f.sent.length, 0); f.autonomy.close();
});

test('failed stop reports error, not success', async () => {
  const f = await fixture(); await start(f);
  f.registry.interruptSession = async () => { throw new Error('后台任务仍在运行'); };
  assert.equal((await f.request('interruptSession', { scope: 'all', commandId: 'stop' })).ok, false);
  assert.equal(f.autonomy.snapshot(target).status, 'error'); f.autonomy.close();
});

test('unbinding rejects stale actions; old pause API is absent', async () => {
  const f = await fixture(); await f.request('bindAutonomySession'); await start(f);
  assert.equal((await f.request('pauseAutonomy', { commandId: 'old' })).ok, false);
  await f.request('bindAutonomySession', { threadId: null, tmuxSession: null });
  assert.equal((await f.request('resetAutonomy', { commandId: 'stale' })).ok, false);
  assert.equal(f.autonomy.snapshot(target).status, 'planning'); f.autonomy.close();
});

for (const method of ['openThread', 'bindAutonomySession']) test(method + ' cannot reconstruct an old protocol popup', async () => {
  const f = await fixture();
  f.backend.openThread = async () => ({ thread: { id: 'thread', turns: [{ status: 'completed', items: [
    { type: 'agentMessage', text: '\x60\x60\x60codeck-autonomy\n{"status":"ask","questions":[{"id":"old"}]}\n\x60\x60\x60' },
  ] }] } });
  await f.request(method, { readOnly: true }); await f.autonomy.tick();
  assert.equal(f.autonomy.snapshot(target), null); assert.equal(f.sent.length, 0); f.autonomy.close();
});
