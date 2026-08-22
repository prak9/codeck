import { EventEmitter } from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentHub, AgentRegistry } from '../src/agent-connection.js';

class FakeSocket extends EventEmitter {
  OPEN = 1;
  readyState = this.OPEN;
  sent = [];

  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; this.emit('close'); }
}

class FakeBackend extends EventEmitter {
  constructor(provider) {
    super();
    this.provider = provider;
    this.label = provider === 'codex' ? 'Codex' : provider === 'claude' ? 'Claude Code' : 'QoderCLI';
    this.calls = [];
    this.responses = [];
  }

  async listThreads() {
    this.calls.push({ method: 'listThreads' });
    return { data: [{ id: `${this.provider}-thread`, preview: `A ${this.provider} thread` }] };
  }

  async openThread(threadId, options) {
    this.calls.push({ method: 'openThread', threadId, options });
    return { thread: { id: threadId, turns: [] } };
  }

  async newThread(params) {
    this.calls.push({ method: 'newThread', params });
    return { thread: { id: `${this.provider}-new`, cwd: params.cwd }, turn: { id: 'turn-new' } };
  }

  async sendMessage(params) {
    this.calls.push({ method: 'sendMessage', params });
    return { turn: { id: params.turnId || 'turn-next' } };
  }

  async interruptTurn(params) {
    this.calls.push({ method: 'interruptTurn', params });
    return {};
  }

  async respond(id, result) { this.responses.push({ id, result }); }
}

async function waitFor(check) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('condition was not reached');
}

function send(socket, message) {
  socket.emit('message', Buffer.from(JSON.stringify(message)), false);
}

function setup({ listTmuxSessions, sendTmuxMessage, interruptTmuxSession } = {}) {
  const backends = Object.fromEntries(['codex', 'claude', 'qodercli'].map((provider) => [provider, new FakeBackend(provider)]));
  const registry = new AgentRegistry(backends, { listTmuxSessions, sendTmuxMessage, interruptTmuxSession });
  const hub = new AgentHub(registry, { defaultCwd: '/srv/codeck', hostname: 'devbox' });
  return { backends, registry, hub };
}

test('lists only the selected provider sessions that still exist in tmux', async () => {
  const listTmuxSessions = async () => [
    {
      name: 'newer-codex', createdAt: 3_000, activityAt: 30_000, hasRunningProcess: true,
      agent: { kind: 'codex', id: 'codex-live-new', name: 'Mobile review' },
    },
    {
      name: 'claude-work', createdAt: 2_000, activityAt: 20_000, hasRunningProcess: false,
      agent: { kind: 'claude', id: 'claude-live', name: 'Claude task' },
    },
    {
      name: 'older-codex', createdAt: 1_000, activityAt: 10_000, hasRunningProcess: false,
      agent: { kind: 'codex', id: 'codex-live-old', name: null },
    },
    { name: 'shell', createdAt: 500, activityAt: 5_000, hasRunningProcess: false, agent: null },
  ];
  const { backends, registry } = setup({ listTmuxSessions });
  backends.codex.listThreads = async () => ({ data: [
    { id: 'codex-stale', name: 'Exited history' },
    { id: 'codex-live-old', name: 'Old backend title' },
    { id: 'codex-live-new', name: 'New backend title' },
  ] });

  const result = await registry.listThreads('codex');

  assert.deepEqual(result.data.map((thread) => thread.id), ['codex-live-new', 'codex-live-old']);
  assert.deepEqual(result.data.map((thread) => thread.tmux), [
    {
      name: 'newer-codex', title: 'Mobile review', activityAt: 30_000,
      status: 'working', available: true,
    },
    {
      name: 'older-codex', title: 'older-codex', activityAt: 10_000,
      status: 'done', available: true,
    },
  ]);
});

test('matches a newly started tmux agent to its local SDK session without guessing across projects', async () => {
  const listTmuxSessions = async () => [
    {
      name: 'qoder-project', createdAt: 1_000, activityAt: 9_000, hasRunningProcess: false,
      agent: { kind: 'qodercli', id: null, name: 'qoder-project', cwd: '/srv/project', startedAt: 1_700_000_000_000 },
    },
  ];
  const { backends, registry } = setup({ listTmuxSessions });
  backends.qodercli.listThreads = async () => ({ data: [
    { id: 'wrong-project', cwd: '/srv/other', createdAt: 1_700_000_001 },
    { id: 'too-old', cwd: '/srv/project', createdAt: 1_699_999_700 },
    { id: 'qoder-live', cwd: '/srv/project', createdAt: 1_700_000_015 },
  ] });

  const result = await registry.listThreads('qodercli');

  assert.deepEqual(result.data.map((thread) => thread.id), ['qoder-live']);
  assert.equal(result.data[0].tmux.name, 'qoder-project');
});

test('advertises and routes all three providers through one owner-scoped socket', async () => {
  const { backends, hub } = setup();
  const socket = new FakeSocket();
  hub.handleConnection(socket);

  assert.deepEqual(socket.sent[0], {
    type: 'ready',
    defaultCwd: '/srv/codeck',
    hostname: 'devbox',
    providers: [
      { id: 'codex', label: 'Codex' },
      { id: 'claude', label: 'Claude Code' },
      { id: 'qodercli', label: 'QoderCLI' },
    ],
  });

  for (const [index, provider] of ['codex', 'claude', 'qodercli'].entries()) {
    send(socket, { type: 'listThreads', id: index + 1, provider });
  }
  await waitFor(() => socket.sent.filter((message) => message.ok).length === 3);
  assert.equal(backends.codex.calls[0].method, 'listThreads');
  assert.equal(backends.claude.calls[0].method, 'listThreads');
  assert.equal(backends.qodercli.calls[0].method, 'listThreads');
  assert.equal(socket.sent.find((message) => message.id === 3).result.data[0].id, 'qodercli-thread');
});

test('opens, starts, follows up, steers and interrupts the selected provider', async () => {
  const { backends, hub } = setup();
  const socket = new FakeSocket();
  hub.handleConnection(socket);

  send(socket, { type: 'openThread', id: 1, provider: 'claude', threadId: 'claude-thread', readOnly: true });
  send(socket, { type: 'newThread', id: 2, provider: 'qodercli', cwd: '/srv/project', text: 'Review this repository' });
  await waitFor(() => socket.sent.some((message) => message.id === 1) && socket.sent.some((message) => message.id === 2));
  assert.deepEqual(backends.claude.calls[0], { method: 'openThread', threadId: 'claude-thread', options: { readOnly: true } });
  assert.deepEqual(backends.qodercli.calls[0], {
    method: 'newThread', params: { cwd: '/srv/project', text: 'Review this repository' },
  });

  send(socket, { type: 'sendMessage', id: 3, provider: 'qodercli', threadId: 'qodercli-new', turnId: 'turn-new', mode: 'steer', text: 'Only inspect mobile code' });
  send(socket, { type: 'interruptTurn', id: 4, provider: 'qodercli', threadId: 'qodercli-new', turnId: 'turn-new' });
  await waitFor(() => socket.sent.some((message) => message.id === 3) && socket.sent.some((message) => message.id === 4));
  assert.deepEqual(backends.qodercli.calls.slice(1), [
    {
      method: 'sendMessage',
      params: { threadId: 'qodercli-new', turnId: 'turn-new', mode: 'steer', text: 'Only inspect mobile code' },
    },
    { method: 'interruptTurn', params: { threadId: 'qodercli-new', turnId: 'turn-new' } },
  ]);
});

test('routes direct participation to the selected tmux session without trusting client pane data', async () => {
  const messages = [];
  const { backends, hub } = setup({
    sendTmuxMessage: async (params) => { messages.push(params); return {}; },
  });
  const socket = new FakeSocket();
  hub.handleConnection(socket);

  send(socket, {
    type: 'sendSessionMessage', id: 7, provider: 'claude', threadId: 'thread-1',
    tmuxSession: 'work', text: 'Review mobile', paneId: '%999', pid: 999,
  });
  await waitFor(() => socket.sent.some((message) => message.id === 7));

  assert.deepEqual(messages, [{
    provider: 'claude', threadId: 'thread-1', sessionName: 'work', text: 'Review mobile',
  }]);
  assert.deepEqual(backends.claude.calls, []);
  assert.equal(socket.sent.find((message) => message.id === 7).ok, true);
});

test('routes a direct tmux interruption without requiring a backend turn id', async () => {
  const interruptions = [];
  const { hub } = setup({
    interruptTmuxSession: async (params) => { interruptions.push(params); return {}; },
  });
  const socket = new FakeSocket();
  hub.handleConnection(socket);

  send(socket, {
    type: 'interruptSession', id: 8, provider: 'qodercli', threadId: 'thread-1',
    tmuxSession: 'work', turnId: 'untrusted-turn', paneId: '%999',
  });
  await waitFor(() => socket.sent.some((message) => message.id === 8));

  assert.deepEqual(interruptions, [{
    provider: 'qodercli', threadId: 'thread-1', sessionName: 'work',
  }]);
  assert.equal(socket.sent.find((message) => message.id === 8).ok, true);
});

test('routes shell participation without advertising or requiring an Agent backend', async () => {
  const messages = [];
  const interruptions = [];
  const { backends, hub } = setup({
    sendTmuxMessage: async (params) => { messages.push(params); return {}; },
    interruptTmuxSession: async (params) => { interruptions.push(params); return {}; },
  });
  const socket = new FakeSocket();
  hub.handleConnection(socket);

  send(socket, {
    type: 'sendSessionMessage', id: 9, provider: 'shell', threadId: 'tmux:shell:work',
    tmuxSession: 'work', text: 'pwd',
  });
  send(socket, {
    type: 'interruptSession', id: 10, provider: 'shell', threadId: 'tmux:shell:work',
    tmuxSession: 'work',
  });
  await waitFor(() => socket.sent.some((message) => message.id === 9)
    && socket.sent.some((message) => message.id === 10));

  assert.deepEqual(messages, [{
    provider: 'shell', threadId: 'tmux:shell:work', sessionName: 'work', text: 'pwd',
  }]);
  assert.deepEqual(interruptions, [{
    provider: 'shell', threadId: 'tmux:shell:work', sessionName: 'work',
  }]);
  assert.equal(Object.values(backends).every((backend) => backend.calls.length === 0), true);
  assert.equal(socket.sent.find((message) => message.id === 9).ok, true);
  assert.equal(socket.sent.find((message) => message.id === 10).ok, true);
});

test('broadcasts only to matching subscriptions and resolves an approval once', async () => {
  const { backends, hub } = setup();
  const first = new FakeSocket();
  const second = new FakeSocket();
  hub.handleConnection(first);
  hub.handleConnection(second);
  send(first, { type: 'openThread', id: 1, provider: 'codex', threadId: 'shared-id' });
  send(second, { type: 'openThread', id: 2, provider: 'claude', threadId: 'shared-id' });
  await waitFor(() => first.sent.some((message) => message.id === 1) && second.sent.some((message) => message.id === 2));

  backends.codex.emit('notification', { method: 'turn/started', params: { threadId: 'shared-id', turn: { id: 'turn-1' } } });
  assert.equal(first.sent.at(-1).method, 'turn/started');
  assert.notEqual(second.sent.at(-1).method, 'turn/started');

  backends.codex.emit('serverRequest', {
    id: 91,
    method: 'item/commandExecution/requestApproval',
    params: { threadId: 'shared-id', turnId: 'turn-1', command: 'npm test' },
  });
  assert.equal(first.sent.at(-1).request.id, 91);

  send(first, { type: 'resolveApproval', id: 3, provider: 'codex', requestId: 91, decision: 'accept' });
  await waitFor(() => backends.codex.responses.length === 1);
  assert.deepEqual(backends.codex.responses[0], { id: 91, result: { decision: 'accept' } });

  send(first, { type: 'resolveApproval', id: 4, provider: 'codex', requestId: 91, decision: 'accept' });
  await waitFor(() => first.sent.some((message) => message.id === 4));
  assert.equal(first.sent.find((message) => message.id === 4).ok, false);
  assert.match(first.sent.find((message) => message.id === 4).error, /already resolved/i);
});

test('routes structured user questions and answers without treating them as approvals', async () => {
  const { backends, hub } = setup();
  const socket = new FakeSocket();
  hub.handleConnection(socket);
  send(socket, { type: 'openThread', id: 1, provider: 'qodercli', threadId: 'qoder-thread' });
  await waitFor(() => socket.sent.some((message) => message.id === 1));

  backends.qodercli.emit('serverRequest', {
    id: 'question-request',
    method: 'item/tool/requestUserInput',
    params: {
      threadId: 'qoder-thread',
      turnId: 'turn-1',
      questions: [{ id: 'question-1', question: 'Which target?', options: [] }],
    },
  });
  assert.equal(socket.sent.at(-1).type, 'interaction');

  const reconnected = new FakeSocket();
  hub.handleConnection(reconnected);
  send(reconnected, { type: 'openThread', id: 9, provider: 'qodercli', threadId: 'qoder-thread' });
  await waitFor(() => reconnected.sent.some((message) => message.id === 9));
  assert.equal(reconnected.sent.filter((message) => message.type === 'interaction').length, 1);

  send(reconnected, {
    type: 'resolveInteraction',
    id: 2,
    provider: 'qodercli',
    requestId: 'question-request',
    answers: { 'question-1': ['Mobile'] },
  });
  await waitFor(() => backends.qodercli.responses.length === 1);
  assert.deepEqual(backends.qodercli.responses[0], {
    id: 'question-request',
    result: { answers: { 'question-1': ['Mobile'] } },
  });
});

test('rejects unknown providers and empty prompts', async () => {
  const { hub } = setup();
  const socket = new FakeSocket();
  hub.handleConnection(socket);
  send(socket, { type: 'listThreads', id: 1, provider: 'unknown' });
  send(socket, { type: 'newThread', id: 2, provider: 'codex', cwd: '/srv/codeck', text: '   ' });
  await waitFor(() => socket.sent.some((message) => message.id === 1) && socket.sent.some((message) => message.id === 2));
  assert.match(socket.sent.find((message) => message.id === 1).error, /provider/i);
  assert.match(socket.sent.find((message) => message.id === 2).error, /message/i);
});
