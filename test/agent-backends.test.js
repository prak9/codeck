import { EventEmitter } from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexAgentBackend } from '../src/agent-backends.js';
import { latestAgentOutputText } from '../public/remote-copy.js';

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

test('reads only Codex summaries to select the latest non-streaming output', async () => {
  for (const status of ['completed', 'failed']) {
    const turns = [
      { id: 'old', status: 'completed', items: [{ type: 'agentMessage', text: 'Old reply' }] },
      { id: 'selected', status, items: [
        { type: 'agentMessage', text: 'First paragraph\n  indentation' },
        { type: 'reasoning', text: 'Do not copy' },
        { type: 'agentMessage', text: 'Second paragraph' },
      ] },
      { id: 'empty', status: 'completed', items: [{ type: 'userMessage', content: [] }] },
      { id: 'running', status: 'running', items: [{ type: 'agentMessage', text: 'Partial' }] },
      { id: 'active', status: 'inProgress', items: [{ type: 'agentMessage', text: 'Partial' }] },
    ];
    const calls = [];
    const backend = new CodexAgentBackend(new FakeAppServer(async (method, params) => {
      calls.push({ method, params });
      assert.equal(method, 'thread/turns/list');
      assert.equal(params.itemsView, 'summary', 'copying cannot hydrate full tool history');
      return { data: [...turns].reverse(), nextCursor: null };
    }));

    assert.deepEqual(await backend.readLatestAgentOutput('thread-1'), {
      text: latestAgentOutputText(turns),
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].params.threadId, 'thread-1');
    assert.equal(calls[0].params.sortDirection, 'desc');
  }
});

test('latest interrupted Codex output retains the exact full-turn fallback', async () => {
  const earlier = { id: 'earlier', status: 'completed', items: [{ type: 'agentMessage', text: 'Earlier reply' }] };
  const summary = { id: 'latest', status: 'interrupted', items: [{ type: 'userMessage', content: [] }] };
  const full = { ...summary, items: [
    ...summary.items,
    { type: 'agentMessage', text: 'Checking' },
    { type: 'commandExecution', aggregatedOutput: 'tool output' },
    { type: 'agentMessage', text: 'Final visible text' },
  ] };
  const calls = [];
  const backend = new CodexAgentBackend(new FakeAppServer(async (method, params) => {
    calls.push({ method, params });
    assert.equal(method, 'thread/turns/list');
    return { data: params.itemsView === 'full' ? [full] : [summary, earlier] };
  }));

  assert.deepEqual(await backend.readLatestAgentOutput('thread-1'), {
    text: latestAgentOutputText([earlier, full]),
  });
  full.items.push({ type: 'agentMessage', text: 'Appended after the first read' });
  assert.deepEqual(await backend.readLatestAgentOutput('thread-1'), {
    text: latestAgentOutputText([earlier, full]),
  });
  assert.deepEqual(calls.filter(({ params }) => params.itemsView === 'full').map(({ params }) => params), [
    { threadId: 'thread-1', limit: 1, sortDirection: 'desc', itemsView: 'full' },
    { threadId: 'thread-1', limit: 1, sortDirection: 'desc', itemsView: 'full' },
  ]);
});

test('latest Codex output follows history cursors without changing a forked thread identity', async () => {
  const calls = [];
  const backend = new CodexAgentBackend(new FakeAppServer(async (method, params) => {
    calls.push({ method, params });
    assert.equal(method, 'thread/turns/list');
    assert.equal(params.itemsView, 'summary');
    if (!params.cursor) return {
      data: [{ id: 'child-empty', status: 'completed', items: [] }], nextCursor: 'inherited-history',
    };
    return {
      data: [{ id: 'parent-turn', status: 'completed', items: [{ type: 'agentMessage', text: 'Inherited reply' }] }],
      nextCursor: null,
    };
  }));

  assert.deepEqual(await backend.readLatestAgentOutput('child-thread'), { text: 'Inherited reply' });
  assert.deepEqual(calls.map(({ params }) => [params.threadId, params.cursor]), [
    ['child-thread', undefined], ['child-thread', 'inherited-history'],
  ]);
});

test('latest Codex output retries locked reads and reports an empty history as empty text', async () => {
  let attempts = 0;
  const backend = new CodexAgentBackend(new FakeAppServer(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('database is locked');
    return { data: [], nextCursor: null };
  }), { wait: async () => {} });

  assert.deepEqual(await backend.readLatestAgentOutput('thread-1'), { text: '' });
  assert.equal(attempts, 2);
});

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

  assert.deepEqual(calls, ['thread/read', 'thread/turns/list', 'thread/turns/list']);
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

for (const omitFollowup of [false, true]) {
  test(`persisted Codex follow-ups retain source order when summaries ${omitFollowup ? 'omit' : 'include'} them`, async () => {
    const original = { id: 'user-original', type: 'userMessage', content: [{ type: 'text', text: 'Start' }] };
    const oldOutput = { id: 'output-old', type: 'agentMessage', text: 'Earlier output' };
    const followup = { id: 'user-followup', type: 'userMessage', content: [{ type: 'text', text: '咋样了' }] };
    const newOutput = { id: 'output-new', type: 'agentMessage', text: 'Later output' };
    const full = [original, oldOutput, followup, newOutput];
    const backend = new CodexAgentBackend(new FakeAppServer(async (method, params) => (
      method === 'thread/read' ? { thread: { id: 'thread-1' } }
        : { data: [{ id: 'turn-1', status: 'completed', items: params.itemsView === 'summary' && omitFollowup
          ? [original, oldOutput, newOutput] : full }] }
    )));
    for (let refresh = 0; refresh < 2; refresh += 1) {
      const result = await backend.openThread('thread-1', { readOnly: true });
      assert.deepEqual(result.thread.turns[0].items.map(item => item.id), full.map(item => item.id));
    }
    backend.close();
  });
}

test('Codex item events retain follow-up position before the full transcript catches up', async () => {
  const first = { id: 'first', type: 'userMessage', content: [{ type: 'text', text: 'First' }] };
  const answer = { id: 'old-answer', type: 'agentMessage', text: 'Old answer' };
  const followup = { id: 'followup', type: 'userMessage', content: [{ type: 'text', text: 'Follow up' }] };
  let summary = { id: 'turn', status: 'completed', items: [first] };
  const appServer = new FakeAppServer(async (method, params) => method === 'thread/read'
    ? { thread: { id: 'thread' } }
    : { data: [params.itemsView === 'full' ? { id: 'turn', status: 'inProgress', items: [first] } : summary] });
  const backend = new CodexAgentBackend(appServer);
  await backend.openThread('thread', { readOnly: true });
  for (const item of [answer, followup]) appServer.emit('notification', {
    method: 'item/completed', params: { threadId: 'thread', turnId: 'turn', item },
  });
  summary = { id: 'turn', status: 'inProgress', items: [first, answer] };
  const refreshed = await backend.openThread('thread', { readOnly: true, progressive: true });
  assert.deepEqual(refreshed.thread.turns[0].items.map(item => item.id), ['first', 'old-answer', 'followup']);
  backend.close();
});

test('Codex receipt replacement and turn completion preserve the chronological position', async () => {
  const first = { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'Start' }] };
  const oldOutput = { id: 'old-output', type: 'agentMessage', text: 'Earlier output' };
  const newOutput = { id: 'new-output', type: 'agentMessage', text: 'Later output' };
  let status = 'inProgress';
  let items = [first, oldOutput];
  const appServer = new FakeAppServer(async method => method === 'thread/read'
    ? { thread: { id: 'thread-1' } } : { data: [{ id: 'turn-1', status, items }] });
  const backend = new CodexAgentBackend(appServer);
  await backend.openThread('thread-1', { readOnly: true });
  backend.recordSessionMessage({ threadId: 'thread-1', turnId: 'turn-1', commandId: 'command-replace', text: '咋样了',
    baselineVersion: 2, baselineUserMessageId: 'user-1', baselineTurnId: 'turn-1', baselineLastItemId: 'old-output', baselineMatchingTextCount: 0 });
  items = [...items, newOutput];
  const pending = await backend.openThread('thread-1', { readOnly: true });
  assert.deepEqual(pending.thread.turns[0].items.map(item => item.id), ['user-1', 'old-output', 'delivery:command-replace', 'new-output']);
  const actual = { id: 'user-actual', type: 'userMessage', content: [{ type: 'text', text: '咋样了' }] };
  items = [first, oldOutput, actual, newOutput];
  status = 'completed';
  appServer.emit('notification', { method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status, items } } });
  await new Promise(setImmediate);
  const completed = await backend.openThread('thread-1', { readOnly: true });
  assert.deepEqual(completed.thread.turns[0].items.map(item => item.id), items.map(item => item.id));
  assert.equal(completed.thread.turns[0].items.some(item => item.delivery), false);
  backend.close();
});

test('starts recent Codex user hydration without waiting for the long summary page', async () => {
  let resolveSummary;
  const summary = new Promise((resolve) => { resolveSummary = resolve; });
  const calls = [];
  const appServer = new FakeAppServer(async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/read') return { thread: { id: 'thread-1', turns: [] } };
    if (params.itemsView === 'summary') return summary;
    return { data: [{ id: 'turn-1', items: [] }] };
  });
  const backend = new CodexAgentBackend(appServer);

  const opening = backend.openThread('thread-1', { readOnly: true });
  await new Promise((resolve) => setImmediate(resolve));
  const hydrationStarted = calls.some((call) => call.params?.itemsView === 'full');
  resolveSummary({ data: [{ id: 'turn-1', items: [] }] });
  await opening;

  assert.equal(hydrationStarted, true);
});

test('progressive Codex loading returns a short summary before exact user hydration', async () => {
  const first = { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'Start' }] };
  const followUp = { id: 'user-2', type: 'userMessage', content: [{ type: 'text', text: 'Also verify mobile' }] };
  let resolveHydration;
  const hydration = new Promise((resolve) => { resolveHydration = resolve; });
  const calls = [];
  const appServer = new FakeAppServer(async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/read') return { thread: { id: 'thread-1', turns: [] } };
    if (params.itemsView === 'full') return hydration;
    return { data: [{ id: 'turn-1', status: 'inProgress', items: [first] }] };
  });
  const backend = new CodexAgentBackend(appServer);
  let opened;

  const opening = backend.openThread('thread-1', { readOnly: true, progressive: true })
    .then((result) => { opened = result; return result; });
  await new Promise((resolve) => setImmediate(resolve));
  const returnedBeforeHydration = Boolean(opened);
  resolveHydration({ data: [{ id: 'turn-1', status: 'inProgress', items: [first, followUp] }] });
  await opening;
  const exact = await backend.openThread('thread-1', { readOnly: true });

  assert.equal(returnedBeforeHydration, true);
  assert.equal(calls.find((call) => call.params?.itemsView === 'summary').params.limit, 20);
  assert.deepEqual(opened.thread.turns[0].items.map((item) => item.id), ['user-1']);
  assert.deepEqual(exact.thread.turns[0].items.map((item) => item.id), ['user-1', 'user-2']);
});

test('refreshes items appended to an interrupted Codex turn without waiting for completion', async () => {
  const first = { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'Continue' }] };
  const interim = { id: 'answer-1', type: 'agentMessage', text: 'Checking the latest state' };
  const final = { id: 'answer-2', type: 'agentMessage', text: 'The task is complete' };
  let latestItems = [first, interim];
  const calls = [];
  const appServer = new FakeAppServer(async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/read') return { thread: { id: 'thread-1', turns: [] } };
    if (params.itemsView === 'full') {
      if (params.limit === 1) {
        return { data: [{ id: 'turn-1', status: 'interrupted', items: latestItems }] };
      }
      return { data: [{ id: 'turn-1', status: 'interrupted', items: [first] }] };
    }
    return { data: [{ id: 'turn-1', status: 'interrupted', items: [first] }] };
  });
  const backend = new CodexAgentBackend(appServer);

  const progressive = await backend.openThread('thread-1', { readOnly: true, progressive: true });
  const firstExact = await backend.openThread('thread-1', { readOnly: true });
  latestItems = [first, interim, final];
  const secondExact = await backend.openThread('thread-1', { readOnly: true });

  assert.deepEqual(progressive.thread.turns[0].items.map((item) => item.id), ['user-1']);
  assert.deepEqual(firstExact.thread.turns[0].items.map((item) => item.id), ['user-1', 'answer-1']);
  assert.deepEqual(secondExact.thread.turns[0].items.map((item) => item.id), [
    'user-1', 'answer-1', 'answer-2',
  ]);
  assert.equal(calls.filter((call) => call.params?.itemsView === 'full' && call.params.limit === 1).length, 2);
});

test('an exact Codex refresh retries after progressive hydration fails transiently', async () => {
  const first = { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'Start' }] };
  const followUp = { id: 'user-2', type: 'userMessage', content: [{ type: 'text', text: 'Also verify mobile' }] };
  let hydrationCalls = 0;
  const appServer = new FakeAppServer(async (method, params) => {
    if (method === 'thread/read') return { thread: { id: 'thread-1', turns: [] } };
    if (params.itemsView === 'full' && params.limit === 10) {
      hydrationCalls += 1;
      if (hydrationCalls === 1) throw new Error('rollout is still being written');
      return { data: [{ id: 'turn-1', status: 'inProgress', items: [first, followUp] }] };
    }
    if (params.itemsView === 'full') {
      return { data: [{ id: 'turn-1', status: 'inProgress', items: [first, followUp] }] };
    }
    return { data: [{ id: 'turn-1', status: 'inProgress', items: [first] }] };
  });
  const backend = new CodexAgentBackend(appServer);

  await backend.openThread('thread-1', { readOnly: true, progressive: true });
  await new Promise((resolve) => setImmediate(resolve));
  const exact = await backend.openThread('thread-1', { readOnly: true });

  assert.equal(hydrationCalls, 2);
  assert.deepEqual(exact.thread.turns[0].items.map((item) => item.id), ['user-1', 'user-2']);
});

test('older interrupted Codex turns retain all messages after follow-ups and reopening', async () => {
  const old = { id: 'old', status: 'interrupted', completedAt: 123, items: [
    { id: 'user-old', type: 'userMessage', content: [{ type: 'text', text: 'Fix remote menus' }] },
  ] };
  const messages = [...old.items, ...['Checking', 'Found the cause', 'Adding tests'].map((text, index) => (
    { id: `answer-${index}`, type: 'agentMessage', text }
  ))];
  const latest = { id: 'latest', status: 'completed', items: [] };
  const calls = [];
  const appServer = new FakeAppServer(async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/read') return { thread: { id: params.threadId } };
    if (method === 'thread/items/list') {
      assert.equal(params.turnId, 'old');
      return { data: [...messages, { id: 'tool', type: 'commandExecution', aggregatedOutput: 'large tool log' }]
        .map((item) => ({ turnId: 'old', item })), nextCursor: null };
    }
    return { data: [latest, old] };
  });
  const backend = new CodexAgentBackend(appServer);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const opened = await backend.openThread('thread-1', { readOnly: true });
    assert.deepEqual(opened.thread.turns[0].items, messages);
  }
  assert.equal(calls.filter(call => call.method === 'thread/items/list').length, 1,
    'closed-turn message hydration must not reread tool logs on every live poll');
  assert.deepEqual(await backend.readLatestAgentOutput('thread-1'), { text: 'Checking\n\nFound the cause\n\nAdding tests' });
});

test('interrupted hydration keeps summary tools between their source messages without caching tool logs', async () => {
  const user = { id: 'user', type: 'userMessage', content: [] };
  const tool = { id: 'tool', type: 'commandExecution', aggregatedOutput: 'summary log' };
  const reply = { id: 'reply', type: 'agentMessage', text: 'After the tool' };
  const old = { id: 'old', status: 'interrupted', completedAt: 123, items: [user, tool] };
  const latest = { id: 'latest', status: 'completed', items: [] };
  const backend = new CodexAgentBackend(new FakeAppServer(async (method, params) => {
    if (method === 'thread/read') return { thread: { id: 'thread' } };
    if (method === 'thread/items/list') return { data: [user, { ...tool, aggregatedOutput: 'large raw log' }, reply]
      .map(item => ({ turnId: 'old', item })) };
    return { data: [latest, old] };
  }));
  for (let i = 0; i < 2; i += 1) {
    const result = await backend.openThread('thread', { readOnly: true });
    assert.deepEqual(result.thread.turns[0].items.map(item => item.id), ['user', 'tool', 'reply']);
    assert.equal(result.thread.turns[0].items[1].aggregatedOutput, 'summary log');
  }
  assert.ok([...backend.interruptedMessages.values()].every(entry => entry.items.every(item => item.type !== 'commandExecution')));
  backend.close();
});

test('a live window request hydrates only its requested tail, retaining explicit history access', async () => {
  const calls = [];
  const backend = new CodexAgentBackend(new FakeAppServer(async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/read') return { thread: { id: 'thread' } };
    return { data: [{ id: 'latest', status: 'completed', items: [] }] };
  }));
  await backend.openThread('thread', { readOnly: true, turnLimit: 20 });
  assert.equal(calls.find(call => call.params.itemsView === 'summary').params.limit, 20);
  calls.length = 0;
  await backend.openThread('thread', { readOnly: true });
  assert.equal(calls.find(call => call.params.itemsView === 'summary').params.limit, 80);
  backend.close();
});

test('interrupted history hydration follows item cursors and retries failures without caching partial messages', async () => {
  const turn = { id: 'old', status: 'interrupted', completedAt: 123, items: [] };
  let fail = true;
  const calls = [];
  const backend = new CodexAgentBackend(new FakeAppServer(async (method, params) => {
    if (method === 'thread/turns/list') return { data: [turn], nextCursor: null };
    assert.equal(method, 'thread/items/list');
    calls.push(params);
    if (params.cursor && fail) throw new Error('temporary item read failure');
    const item = { id: params.cursor ? 'answer-2' : 'answer-1', type: 'agentMessage', text: params.cursor ? 'Second' : 'First' };
    return { data: [{ turnId: 'old', item }], nextCursor: params.cursor ? null : 'next-item' };
  }));
  await assert.rejects(backend.loadThreadHistory('thread-1'), /temporary item read failure/);
  fail = false;
  const result = await backend.loadThreadHistory('thread-1');
  assert.deepEqual(result.turns[0].items.map(item => item.text), ['First', 'Second']);
  assert.deepEqual(calls.map(params => params.cursor), [undefined, 'next-item', undefined, 'next-item']);
});

test('interrupted message cache is isolated by thread and invalidated by changed turn metadata', async () => {
  const turn = { id: 'shared-turn', status: 'interrupted', completedAt: 123, items: [] };
  const backend = new CodexAgentBackend(new FakeAppServer(async (method, params) => {
    if (method === 'thread/turns/list') return { data: [structuredClone(turn)] };
    assert.equal(method, 'thread/items/list');
    return { data: [{ turnId: turn.id, item: { id: 'answer', type: 'agentMessage', text: `${params.threadId}:${turn.completedAt}` } }] };
  }));
  assert.equal((await backend.loadThreadHistory('a')).turns[0].items[0].text, 'a:123');
  assert.equal((await backend.loadThreadHistory('b')).turns[0].items[0].text, 'b:123');
  turn.completedAt = 456;
  assert.equal((await backend.loadThreadHistory('a')).turns[0].items[0].text, 'a:456');
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

for (const progressive of [false, true]) {
  test(`Codex ${progressive ? 'summary' : 'full'} view preserves a follow-up's captured position`, async () => {
    const first = { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'Start' }] };
    const oldAnswer = { id: 'answer-old', type: 'agentMessage', text: 'Old output' };
    let items = [first, oldAnswer];
    const backend = new CodexAgentBackend(new FakeAppServer(async method => (
      method === 'thread/read' ? { thread: { id: 'thread-1' } }
        : { data: [{ id: 'turn-1', status: 'inProgress', items }] }
    )));
    await backend.openThread('thread-1', { readOnly: true });
    backend.recordSessionMessage({
      threadId: 'thread-1', turnId: 'turn-1', text: '咋样了', commandId: 'command-position',
      baselineVersion: 2, baselineUserMessageId: 'user-1', baselineTurnId: 'turn-1',
      baselineMatchingTextCount: 0, baselineLastItemId: 'answer-old',
    });
    items = [...items, { id: 'answer-new', type: 'agentMessage', text: 'New output' }];
    for (let refresh = 0; refresh < 2; refresh += 1) {
      const opened = await backend.openThread('thread-1', { readOnly: true, progressive });
      assert.deepEqual(opened.thread.turns[0].items.map(item => item.id), [
        'user-1', 'answer-old', 'delivery:command-position', 'answer-new',
      ]);
    }
    backend.close();
  });
}

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

for (const submissionStatus of ['submitted', 'unconfirmed', undefined, 'unknown']) {
  test(`Codex delivery retains ${submissionStatus ?? 'missing'} submission status until a real user message arrives`, async () => {
    const first = { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'Start' }] };
    const text = 'Check the skills implementation';
    let users = [first];
    const appServer = new FakeAppServer(async (method) => (
      method === 'thread/read'
        ? { thread: { id: 'thread-1' } }
        : { data: [{ id: 'turn-1', status: 'inProgress', items: users }] }
    ));
    const backend = new CodexAgentBackend(appServer);
    await backend.openThread('thread-1', { readOnly: true });
    backend.recordSessionMessage({
      threadId: 'thread-1', turnId: 'turn-1', text, commandId: 'command-submission-1',
      submissionStatus,
    });

    for (let refresh = 0; refresh < 2; refresh += 1) {
      const opened = await backend.openThread('thread-1', { readOnly: true });
      const pending = opened.thread.turns[0].items.filter((item) => item.delivery);
      assert.equal(pending.length, 1, 'a lagging full view must retain the optimistic message');
      assert.deepEqual(pending[0].delivery, {
        status: 'accepted',
        submissionStatus: submissionStatus === 'submitted' ? 'submitted' : 'unconfirmed',
      });
    }

    users = [first, { id: 'user-actual', type: 'userMessage', content: [{ type: 'text', text }] }];
    const confirmed = await backend.openThread('thread-1', { readOnly: true });
    assert.deepEqual(confirmed.thread.turns[0].items.map((item) => item.id), ['user-1', 'user-actual']);
    assert.equal(confirmed.thread.turns[0].items.some((item) => item.delivery), false);
    backend.close();
  });
}

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

test('a locked Codex thread store is retried instead of surfaced to the user', async () => {
  // Codex 的 thread-store 是 SQLite; 它自己的 TUI 在写、codeck 在读, 撞上就是
  // "(code: 5) database is locked"。这是瞬时的, 而读操作幂等, 重试一次通常就好 ——
  // 直接把这句抛到界面上, 用户只能自己再点一次。
  let attempts = 0;
  const appServer = new FakeAppServer(async (method) => {
    if (method === 'thread/read') {
      attempts += 1;
      if (attempts < 3) {
        throw new Error('thread-store internal error: failed to read thread metadata for t1: error returned from database: (code: 5) database is locked');
      }
      return { thread: { id: 't1', turns: [] } };
    }
    if (method === 'thread/turns/list') return { data: [] };
    return {};
  });
  const backend = new CodexAgentBackend(appServer, { wait: async () => {} });

  const opened = await backend.openThread('t1', { readOnly: true });
  assert.equal(attempts, 3);
  assert.equal(opened.thread.id, 't1');
});

test('a lock that never clears still reports the real error', async () => {
  const appServer = new FakeAppServer(async (method) => {
    if (method === 'thread/read') throw new Error('error returned from database: (code: 5) database is locked');
    if (method === 'thread/turns/list') return { data: [] };
    return {};
  });
  const backend = new CodexAgentBackend(appServer, { wait: async () => {} });
  await assert.rejects(() => backend.openThread('t1', { readOnly: true }), /database is locked/);
});
