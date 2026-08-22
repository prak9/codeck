import { EventEmitter } from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexAgentBackend } from '../src/agent-backends.js';

class FakeAppServer extends EventEmitter {
  constructor(request) {
    super();
    this.requestImpl = request;
    this.responses = [];
    this.errors = [];
  }

  request(method, params) { return this.requestImpl(method, params); }
  async respond(id, result) { this.responses.push({ id, result }); }
  async respondError(id, code, message) { this.errors.push({ id, code, message }); }
  close() {}
}

test('opens a Codex thread read-only when a terminal already owns its writer', async () => {
  const calls = [];
  const appServer = new FakeAppServer(async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/resume') throw new Error('thread thread-1 already has an active writer');
    if (method === 'thread/turns/list') return { data: [{ id: 'turn-1', items: [] }] };
    return { thread: { id: 'thread-1', turns: [{ id: 'turn-1', items: [] }] } };
  });
  const backend = new CodexAgentBackend(appServer);

  const opened = await backend.openThread('thread-1');

  assert.deepEqual(calls.map((call) => call.method), ['thread/resume', 'thread/read', 'thread/turns/list']);
  assert.equal(opened.thread.readOnly, true);
  assert.equal(opened.thread.readOnlyReason, 'activeWriter');
  assert.equal(opened.thread.turns.length, 1);
});

test('reads a known tmux-owned Codex thread without waiting for writer acquisition', async () => {
  const calls = [];
  const appServer = new FakeAppServer(async (method) => {
    calls.push(method);
    if (method === 'thread/turns/list') return { data: [] };
    return { thread: { id: 'thread-1', turns: [] } };
  });
  const backend = new CodexAgentBackend(appServer);

  const opened = await backend.openThread('thread-1', { readOnly: true });

  assert.deepEqual(calls, ['thread/read', 'thread/turns/list']);
  assert.equal(opened.thread.readOnly, true);
  assert.equal(opened.thread.readOnlyReason, 'activeWriter');
});

test('loads Codex history as lightweight turn summaries in chronological order', async () => {
  const calls = [];
  const appServer = new FakeAppServer(async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/read') return { thread: { id: 'thread-1', name: 'Review', turns: [] } };
    return {
      data: [
        { id: 'turn-new', status: 'completed', items: [{ id: 'answer-new', type: 'agentMessage', text: 'New' }] },
        { id: 'turn-old', status: 'completed', items: [{ id: 'answer-old', type: 'agentMessage', text: 'Old' }] },
      ],
      nextCursor: null,
    };
  });
  const backend = new CodexAgentBackend(appServer);

  const opened = await backend.openThread('thread-1', { readOnly: true });

  assert.deepEqual(calls, [
    { method: 'thread/read', params: { threadId: 'thread-1', includeTurns: false } },
    {
      method: 'thread/turns/list',
      params: { threadId: 'thread-1', limit: 80, sortDirection: 'desc', itemsView: 'summary' },
    },
  ]);
  assert.deepEqual(opened.thread.turns.map((turn) => turn.id), ['turn-old', 'turn-new']);
  assert.equal(opened.thread.name, 'Review');
});

test('keeps a resumed Codex thread writable', async () => {
  const appServer = new FakeAppServer(async (method) => (
    method === 'thread/resume'
      ? { thread: { id: 'thread-1' } }
      : { thread: { id: 'thread-1', turns: [] } }
  ));
  const backend = new CodexAgentBackend(appServer);

  const opened = await backend.openThread('thread-1');

  assert.equal(opened.thread.readOnly, false);
});

test('maps Codex permission approvals to the app-server response schema', async () => {
  const appServer = new FakeAppServer(async () => ({}));
  const backend = new CodexAgentBackend(appServer);
  const requests = [];
  backend.on('serverRequest', (request) => requests.push(request));
  appServer.emit('serverRequest', {
    id: 42,
    method: 'item/permissions/requestApproval',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      permissions: { network: { enabled: true } },
    },
  });

  assert.equal(requests.length, 1);
  await backend.respond(42, { decision: 'acceptForSession' });
  assert.deepEqual(appServer.responses, [{
    id: 42,
    result: {
      permissions: { network: { enabled: true } },
      scope: 'session',
    },
  }]);
});

test('returns structured answers to Codex user-input requests', async () => {
  const appServer = new FakeAppServer(async () => ({}));
  const backend = new CodexAgentBackend(appServer);
  appServer.emit('serverRequest', {
    id: 43,
    method: 'item/tool/requestUserInput',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      questions: [{ id: 'target', header: 'Target', question: 'Which target?' }],
    },
  });

  await backend.respond(43, { answers: { target: ['Mobile'] } });
  assert.deepEqual(appServer.responses, [{
    id: 43,
    result: { answers: { target: { answers: ['Mobile'] } } },
  }]);
});

test('fails closed for unsupported Codex client requests', () => {
  const appServer = new FakeAppServer(async () => ({}));
  const backend = new CodexAgentBackend(appServer);
  const requests = [];
  backend.on('serverRequest', (request) => requests.push(request));

  appServer.emit('serverRequest', {
    id: 44,
    method: 'account/chatgptAuthTokens/refresh',
    params: {},
  });

  assert.deepEqual(requests, []);
  assert.deepEqual(appServer.errors, [{
    id: 44,
    code: -32601,
    message: 'Unsupported Codex server request: account/chatgptAuthTokens/refresh',
  }]);
});
