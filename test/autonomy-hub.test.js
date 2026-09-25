import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { AgentHub, AgentRegistry } from '../src/agent-connection.js';
import { AutonomyController } from '../src/autonomy.js';
import { AUTONOMY_PROGRESS_PROMPT } from '../public/remote-autonomy.js';

class Socket extends EventEmitter {
  readyState = 1;
  sent = [];
  send(raw) { this.sent.push(JSON.parse(raw)); }
}
const target = { provider: 'codex', threadId: 'thread', tmuxSession: 'work' };
async function fixture() {
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
  await request('openThread', { readOnly: true });
  return { sent, submissions, interrupted, autonomy, socket, hub, registry, request };
}

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
