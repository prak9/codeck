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

  assert.deepEqual(calls.map((call) => call.method), [
    'thread/resume', 'thread/read', 'thread/turns/list', 'thread/turns/list',
  ]);
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
    {
      method: 'thread/turns/list',
      params: { threadId: 'thread-1', limit: 10, sortDirection: 'desc', itemsView: 'full' },
    },
  ]);
  assert.deepEqual(opened.thread.turns.map((turn) => turn.id), ['turn-old', 'turn-new']);
  assert.equal(opened.thread.name, 'Review');
});

test('hydrates lightweight Codex summaries with every recent user follow-up only once', async () => {
  const calls = [];
  const first = { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'Start' }] };
  const followUp = { id: 'user-2', type: 'userMessage', content: [{ type: 'text', text: 'Also verify mobile' }] };
  const answer = { id: 'answer-1', type: 'agentMessage', text: 'Done' };
  const appServer = new FakeAppServer(async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/read') return { thread: { id: 'thread-1', turns: [] } };
    if (params.itemsView === 'full') {
      return { data: [{
        id: 'turn-1', status: 'completed',
        items: [first, { id: 'tool-1', type: 'commandExecution', command: 'npm test' }, followUp, answer],
      }] };
    }
    return { data: [{ id: 'turn-1', status: 'completed', items: [first, answer] }] };
  });
  const backend = new CodexAgentBackend(appServer);

  const opened = await backend.openThread('thread-1', { readOnly: true });
  const reopened = await backend.openThread('thread-1', { readOnly: true });

  assert.deepEqual(opened.thread.turns[0].items.map((item) => item.type), [
    'userMessage', 'userMessage', 'agentMessage',
  ]);
  assert.deepEqual(opened.thread.turns[0].items
    .filter((item) => item.type === 'userMessage')
    .map((item) => item.content[0].text), ['Start', 'Also verify mobile']);
  assert.deepEqual(reopened.thread.turns[0].items, opened.thread.turns[0].items);
  assert.equal(calls.filter((call) => call.params?.itemsView === 'full').length, 1);
});

test('records an accepted tmux follow-up in the sparse Codex summary cache', async () => {
  const first = { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'Start' }] };
  const answer = { id: 'answer-1', type: 'agentMessage', text: 'Working' };
  const appServer = new FakeAppServer(async (method, params) => {
    if (method === 'thread/read') return { thread: { id: 'thread-1', turns: [] } };
    if (params.itemsView === 'full') {
      return { data: [{ id: 'turn-1', status: 'inProgress', items: [first] }] };
    }
    return { data: [{ id: 'turn-1', status: 'inProgress', items: [first, answer] }] };
  });
  const backend = new CodexAgentBackend(appServer);
  await backend.openThread('thread-1', { readOnly: true });

  backend.recordSessionMessage({
    threadId: 'thread-1', turnId: 'turn-1', text: 'Use the latest data',
    commandId: 'command-12345678',
  });
  const opened = await backend.openThread('thread-1', { readOnly: true });

  assert.deepEqual(opened.thread.turns[0].items
    .filter((item) => item.type === 'userMessage')
    .map((item) => item.content[0].text), ['Start', 'Use the latest data']);
});

test('a lagging Codex full refresh cannot delete an accepted tmux follow-up', async () => {
  const first = { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'Start' }] };
  const acceptedText = 'Use the latest data';
  let fullUsers = [first];
  const appServer = new FakeAppServer(async (method, params) => {
    if (method === 'thread/read') return { thread: { id: 'thread-1', turns: [] } };
    const items = params.itemsView === 'full'
      ? fullUsers
      : [first, { id: 'answer-1', type: 'agentMessage', text: 'Working' }];
    return { data: [{ id: 'turn-1', status: 'inProgress', items }] };
  });
  const backend = new CodexAgentBackend(appServer);
  await backend.openThread('thread-1', { readOnly: true });
  backend.recordSessionMessage({
    threadId: 'thread-1', turnId: 'turn-1', text: acceptedText,
    commandId: 'command-12345678',
  });

  appServer.emit('notification', {
    method: 'turn/completed',
    params: { threadId: 'thread-1', turn: { id: 'turn-1', items: [first] } },
  });
  await new Promise((resolve) => setImmediate(resolve));
  let opened = await backend.openThread('thread-1', { readOnly: true });

  assert.deepEqual(opened.thread.turns[0].items
    .filter((item) => item.type === 'userMessage')
    .map((item) => item.content[0].text), ['Start', acceptedText]);

  fullUsers = [first, {
    id: 'user-2', type: 'userMessage', content: [{ type: 'text', text: acceptedText }],
  }];
  appServer.emit('notification', {
    method: 'turn/completed',
    params: { threadId: 'thread-1', turn: { id: 'turn-1', items: fullUsers } },
  });
  await new Promise((resolve) => setImmediate(resolve));
  opened = await backend.openThread('thread-1', { readOnly: true });

  assert.deepEqual(opened.thread.turns[0].items
    .filter((item) => item.type === 'userMessage')
    .map((item) => item.id), ['user-1', 'user-2']);
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
