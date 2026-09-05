import { EventEmitter } from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexAgentBackend } from '../src/agent-backends.js';
import { AgentHub, AgentRegistry } from '../src/agent-connection.js';

class FakeAppServer extends EventEmitter {
  calls = [];
  turns = Array.from({ length: 105 }, (_, index) => ({
    id: `turn-${index + 1}`, status: 'completed',
    items: [{ id: `answer-${index + 1}`, type: 'agentMessage', text: `Answer ${index + 1}` }],
  }));

  async request(method, params) {
    this.calls.push({ method, ...params });
    if (method === 'thread/read') return { thread: { id: params.threadId } };
    assert.equal(method, 'thread/turns/list', 'history must not acquire a writer or start an Agent');
    const descending = [...this.turns].reverse();
    const start = params.cursor ? descending.findIndex((turn) => `before:${turn.id}` === params.cursor) + 1 : 0;
    assert.ok(!params.cursor || start > 0, 'only real opaque cursors are accepted');
    const data = descending.slice(start, start + params.limit);
    return { data, nextCursor: start + data.length < descending.length ? `before:${data.at(-1).id}` : null };
  }

  close() {}
}
class FakeSocket extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  sent = [];
  send(raw) { this.sent.push(JSON.parse(raw)); }
}

function fixture({ progressive = false } = {}) {
  const appServer = new FakeAppServer();
  const backend = new CodexAgentBackend(appServer);
  const registry = new AgentRegistry({ codex: backend });
  const threadFeed = progressive ? { subscribe: () => () => {} } : null;
  const hub = new AgentHub(registry, { threadFeed });
  const socket = new FakeSocket();
  hub.handleConnection(socket);
  let nextId = 0;
  async function rpc(type, params = {}) {
    const id = ++nextId;
    socket.emit('message', Buffer.from(JSON.stringify({
      id, type, provider: 'codex', threadId: 'thread-a', ...params,
    })));
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = socket.sent.find((message) => message.id === id);
      if (response) {
        if (!response.ok) throw new Error(response.error);
        return response.result;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error('History RPC timed out');
  }
  return { appServer, backend, registry, hub, socket, rpc };
}

test('Codex progressive history reaches every turn beyond 80 with bounded cursor reads', async (t) => {
  const f = fixture({ progressive: true });
  t.after(() => f.registry.close());
  const opened = await f.rpc('openThread', { readOnly: true, tmuxSession: 'fixture' });
  assert.equal(opened.thread.truncated, true, 'the first 20-turn frame must already advertise older history');
  let turns = opened.thread.turns;
  let anchor = turns[0].id;
  let truncated = true;
  f.appServer.calls.length = 0;
  while (truncated) {
    const page = await f.rpc('loadThreadHistory', { beforeTurnId: anchor });
    turns = [...page.turns, ...turns];
    anchor = page.oldestTurnId;
    truncated = page.truncated;
  }
  assert.deepEqual(turns.map((turn) => turn.id), f.appServer.turns.map((turn) => turn.id));
  const reads = f.appServer.calls.filter((call) => call.itemsView === 'summary');
  assert.equal(reads.length, 5);
  assert.ok(reads.every((call) => call.limit <= 20 && call.cursor));
  assert.equal(f.appServer.calls.some((call) => call.method === 'thread/read'), false);
});

test('the history RPC does not mistake the oldest of 80 recent Codex turns for the beginning', async (t) => {
  const f = fixture();
  t.after(() => f.registry.close());
  const opened = await f.rpc('openThread', { readOnly: true });
  let turns = opened.thread.turns;
  let anchor = turns[0].id;
  while (anchor) {
    const page = await f.rpc('loadThreadHistory', { beforeTurnId: anchor });
    turns = [...page.turns, ...turns];
    anchor = page.truncated ? page.oldestTurnId : null;
  }
  assert.deepEqual(turns.map((turn) => turn.id), f.appServer.turns.map((turn) => turn.id));
});

test('recent-anchor history RPC waits for existing user hydration and reuses its once-only cache', async (t) => {
  const f = fixture({ progressive: true });
  t.after(() => f.registry.close());
  f.appServer.turns = f.appServer.turns.slice(0, 61).map((turn) => ({
    ...turn,
    items: [{ id: `user:${turn.id}`, type: 'userMessage', content: [{ type: 'text', text: 'Initial prompt' }] }],
  }));
  let releaseHydration;
  const hydration = new Promise((resolve) => { releaseHydration = resolve; });
  const original = f.appServer.request.bind(f.appServer);
  f.appServer.request = async (method, params) => {
    const result = await original(method, params);
    if (params.itemsView !== 'full') return result;
    await hydration;
    return {
      ...result,
      data: result.data.map((turn) => ({
        ...turn,
        items: [...turn.items, { id: `followup:${turn.id}`, type: 'userMessage', content: [{ type: 'text', text: 'Follow-up prompt' }] }],
      })),
    };
  };
  const opened = await f.rpc('openThread', { readOnly: true });
  assert.equal(opened.thread.turns.length, 20);
  let settled = false;
  const loading = f.rpc('loadThreadHistory', { beforeTurnId: 'turn-61' }).then((result) => {
    settled = true;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const settledBeforeHydration = settled;
  releaseHydration();
  const result = await loading;
  assert.equal(settledBeforeHydration, false);
  assert.equal(result.turns.length, 20);
  assert.equal(result.turns.flatMap((turn) => turn.items).length, 29, 'nine of the latest ten hydrated turns precede the anchor');
  const repeated = await f.rpc('loadThreadHistory', { beforeTurnId: 'turn-61' });
  assert.deepEqual(repeated, result);
  assert.deepEqual(f.appServer.calls.filter((call) => call.itemsView === 'full').map((call) => call.limit), [10]);
});

test('history resolves uncached and partial-page anchors then reuses their actual cursor positions', async (t) => {
  const f = fixture();
  t.after(() => f.registry.close());
  const first = await f.rpc('loadThreadHistory', { beforeTurnId: 'turn-88', limit: 3 });
  assert.deepEqual(first.turns.map((turn) => turn.id), ['turn-85', 'turn-86', 'turn-87']);
  f.appServer.calls.length = 0;
  const next = await f.rpc('loadThreadHistory', { beforeTurnId: first.oldestTurnId, limit: 3 });
  assert.deepEqual(next.turns.map((turn) => turn.id), ['turn-82', 'turn-83', 'turn-84']);
  assert.equal(f.appServer.calls.filter((call) => call.itemsView === 'summary').length, 1);
  assert.equal(f.appServer.calls[0].cursor, 'before:turn-86');
  const empty = await f.rpc('loadThreadHistory', { beforeTurnId: 'turn-1' });
  assert.deepEqual(empty, { turns: [], truncated: false, oldestTurnId: null });
  await assert.rejects(f.rpc('loadThreadHistory', { beforeTurnId: 'missing-turn' }), /anchor is no longer present/);
});

test('opaque cursors retain chronological pagination while new turns arrive and stay scoped to a thread', async (t) => {
  const f = fixture({ progressive: true });
  t.after(() => f.registry.close());
  const opened = await f.rpc('openThread', { readOnly: true });
  const anchor = opened.thread.turns[0].id;
  f.appServer.turns.push({ id: 'turn-106', status: 'completed', items: [] });
  f.appServer.calls.length = 0;
  const page = await f.rpc('loadThreadHistory', { beforeTurnId: anchor });
  assert.deepEqual(page.turns.map((turn) => turn.id), Array.from({ length: 20 }, (_, index) => `turn-${index + 66}`));
  assert.equal(f.appServer.calls[0].cursor, 'before:turn-86');
  f.appServer.calls.length = 0;
  await f.rpc('loadThreadHistory', { threadId: 'thread-b', beforeTurnId: anchor });
  assert.equal(f.appServer.calls[0].cursor, undefined, 'another thread must locate its own anchor');
});

test('an invalid cached cursor is discarded so retry can locate the anchor again', async (t) => {
  const f = fixture({ progressive: true });
  t.after(() => f.registry.close());
  const opened = await f.rpc('openThread', { readOnly: true });
  const anchor = opened.thread.turns[0].id;
  const original = f.appServer.request.bind(f.appServer);
  let fail = true;
  f.appServer.request = async (method, params) => {
    if (params.cursor && fail) {
      fail = false;
      throw new Error('Expired opaque cursor');
    }
    return original(method, params);
  };
  await assert.rejects(f.rpc('loadThreadHistory', { beforeTurnId: anchor }), /Expired opaque cursor/);
  f.appServer.calls.length = 0;
  const page = await f.rpc('loadThreadHistory', { beforeTurnId: anchor });
  assert.equal(f.appServer.calls[0].cursor, undefined);
  assert.equal(page.turns.length, 20);
});

test('history positions are bounded and a non-advancing store cursor cannot loop forever', async (t) => {
  const f = fixture();
  t.after(() => f.registry.close());
  for (let index = 0; index < 550; index += 1) {
    await f.backend.loadThreadHistory(`thread-${index}`, { limit: 1 });
  }
  assert.ok(f.backend.historyPositions.size <= 1_024);
  f.appServer.request = async () => ({ data: [], nextCursor: 'repeated-cursor' });
  await assert.rejects(f.backend.loadThreadHistory('new-thread', { beforeTurnId: 'absent' }), /cursor did not advance/);
  f.registry.close();
  assert.equal(f.backend.historyPositions.size, 0);
});

test('SDK history keeps its read-only fallback and paging never changes the active subscription', async () => {
  class Backend extends EventEmitter {
    calls = [];
    async openThread(id, options) {
      this.calls.push({ id, options });
      return { thread: { id, turns: Array.from({ length: 25 }, (_, index) => ({ id: `turn-${index + 1}`, items: [] })) } };
    }
  }
  const backend = new Backend();
  const registry = new AgentRegistry({ claude: backend });
  const hub = new AgentHub(registry);
  const socket = new FakeSocket();
  hub.handleConnection(socket);
  const subscription = { target: { provider: 'claude', threadId: 'viewed', tmuxSession: 'fixture' } };
  hub.clients.get(socket).threadSubscription = subscription;
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'loadThreadHistory', id: 1, provider: 'claude', threadId: 'other', beforeTurnId: 'turn-25', limit: 3 })));
  await new Promise((resolve) => setImmediate(resolve));
  const result = socket.sent.find((message) => message.id === 1).result;
  assert.deepEqual(result.turns.map((turn) => turn.id), ['turn-22', 'turn-23', 'turn-24']);
  assert.deepEqual(backend.calls, [{ id: 'other', options: { readOnly: true } }]);
  assert.equal(hub.clients.get(socket).threadSubscription, subscription);
});
