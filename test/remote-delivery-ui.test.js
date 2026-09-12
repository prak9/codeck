import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findTmuxThreadTarget,
  normalizeAgentThread,
  reconcileAgentThreadRefresh,
} from '../public/agent-model.js';

const source = fs.readFileSync(new URL('../public/remote.js', import.meta.url), 'utf8');
function load(context, name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, name);
  vm.runInContext(source.slice(start, start + source.slice(start).search(/^}$/m) + 1), context);
}

test('unknown delivery has an explicit terminal-check warning instead of a waiting label', () => {
  const context = vm.createContext({
    userMessageText: () => 'Continue',
    element: (tag, className, text) => ({ tag, className, text, children: [], append(node) { this.children.push(node); } }),
  });
  load(context, 'itemNode');
  for (const status of ['accepted', 'unknown']) {
    const node = context.itemNode({ type: 'userMessage', delivery: { status } });
    assert.match(node.children[0].text, status === 'unknown' ? /状态未知.*勿重复发送/ : /等待 Agent 确认/);
  }
});

test('a server restart marks unresolved Agent delivery bubbles as unknown consistently', () => {
  for (const provider of ['qodercli', 'codex', 'claude', 'shell']) {
    const pending = { id: 'delivery:command', type: 'userMessage', delivery: { status: 'accepted' } };
    const actual = { id: 'real', type: 'userMessage', content: 'Hello' };
    const state = { provider, thread: { turns: [{ id: 'turn', items: [actual, pending] }] } };
    const context = vm.createContext({ state });
    load(context, 'markRestartedDeliveries');
    context.markRestartedDeliveries();
    assert.equal(state.thread.turns[0].items[1].delivery.status, provider !== 'shell' ? 'unknown' : 'accepted');
    assert.equal(state.thread.turns[0].items[0], actual);
    assert.equal(pending.delivery.status, 'accepted', 'do not mutate an old snapshot');
  }
});

test('switching sessions selects the target before its history request finishes', async () => {
  let finishOpening;
  let drawerCloses = 0;
  const renders = [];
  const target = {
    id: 'thread-2', provider: 'codex', readOnly: true,
    tmux: { name: 'session-2', title: 'Target', status: 'working', activityAt: 2 },
  };
  const state = {
    provider: 'codex', providers: ['codex'], protocolEpoch: 'epoch',
    activeThreadId: 'thread-1', threads: [target],
    thread: {
      id: 'thread-1', provider: 'codex', turns: [{ id: 'old-turn', items: [] }],
      tmux: { name: 'session-1', title: 'Old', status: 'working' },
    },
  };
  const context = vm.createContext({
    state, normalizeAgentThread, reconcileAgentThreadRefresh, findTmuxThreadTarget,
    resumableThreadCursor: () => null,
    agentRequest: () => new Promise((resolve) => { finishOpening = resolve; }),
    ...Object.fromEntries(['resetThreadHistory', 'resetThreadStream', 'rememberOpenedThread',
      'renderComposerState', 'setLiveMessage', 'settleConfirmedDeliveries', 'renderThreadList',
      'renderProviderControls'].map(name => [name, () => {}])),
    closeDrawer: () => { drawerCloses += 1; },
    scheduleThreadRender: force => renders.push({ force, id: state.thread?.id }),
    localStorage: { setItem() {} },
  });
  load(context, 'openThread');

  const opening = context.openThread('thread-2', { provider: 'codex', tmuxSession: 'session-2' });
  assert.equal(state.activeThreadId, 'thread-2');
  assert.equal(state.thread.id, 'thread-2');
  assert.equal(state.thread.tmux.name, 'session-2');
  assert.deepEqual(renders.at(-1), { force: true, id: 'thread-2' });
  assert.equal(drawerCloses, 1);

  finishOpening({ thread: { id: 'thread-2', provider: 'codex', turns: [{ id: 'new-turn', items: [] }] } });
  await opening;
  assert.deepEqual(Array.from(state.thread.turns, turn => turn.id), ['new-turn']);
});

test('switching back to a recent session restores its view and stream cursor immediately', async () => {
  let finishOpening;
  let requestPayload;
  const oldCursor = { epoch: 'epoch', sequence: 7 };
  const targetCursor = { epoch: 'epoch', sequence: 11 };
  const oldThread = {
    id: 'thread-1', provider: 'codex', turns: [{ id: 'old-turn', items: [] }],
    tmux: { name: 'session-1', title: 'Old', status: 'working' },
  };
  const cachedThread = {
    id: 'thread-2', provider: 'codex', turns: [{ id: 'cached-turn', items: [] }],
    tmux: { name: 'session-2', title: 'Cached', status: 'done' },
  };
  const target = {
    id: 'thread-2', provider: 'codex', readOnly: true,
    tmux: { name: 'session-2', title: 'Target', status: 'working', activityAt: 3 },
  };
  const state = {
    provider: 'codex', providers: ['codex'], protocolEpoch: 'epoch', streamVersion: 2,
    activeThreadId: 'thread-1', threads: [target], thread: oldThread,
    threadStreamKey: 'codex:thread-1:session-1', threadStreamCursor: oldCursor,
    threadStreamSnapshot: oldThread, threadStreamResyncing: false, threadStreamHealthy: true,
    threadCompletionRefreshUntil: 0,
    threadViewCache: new Map([['codex:thread-2:session-2', {
      thread: cachedThread, cursor: targetCursor, snapshot: cachedThread,
    }]]),
  };
  const context = vm.createContext({
    state, normalizeAgentThread, reconcileAgentThreadRefresh, findTmuxThreadTarget,
    THREAD_VIEW_CACHE_LIMIT: 6,
    agentRequest: (_type, payload) => {
      requestPayload = payload;
      return new Promise(resolve => { finishOpening = resolve; });
    },
    ...Object.fromEntries(['resetThreadHistory', 'rememberOpenedThread', 'renderComposerState',
      'setLiveMessage', 'settleConfirmedDeliveries', 'renderThreadList', 'scheduleThreadRender',
      'closeDrawer', 'renderProviderControls'].map(name => [name, () => {}])),
    localStorage: { setItem() {} },
  });
  for (const name of ['streamTargetKey', 'cacheCurrentThreadView', 'resetThreadStream',
    'resumableThreadCursor', 'openThread']) load(context, name);

  const opening = context.openThread('thread-2', { provider: 'codex', tmuxSession: 'session-2' });
  assert.deepEqual(Array.from(state.thread.turns, turn => turn.id), ['cached-turn']);
  assert.deepEqual(requestPayload.streamCursor, targetCursor);
  assert.equal(state.threadViewCache.get('codex:thread-1:session-1').thread, oldThread);

  finishOpening({ resumed: true });
  await opening;
  assert.deepEqual(Array.from(state.thread.turns, turn => turn.id), ['cached-turn']);
});

for (const provider of ['codex', 'claude', 'qodercli']) {
test(`${provider} server restart does not downgrade an observed input receipt`, () => {
  const item = { id: 'delivery:one', type: 'userMessage', delivery: { status: 'received' } };
  const state = { provider, thread: { turns: [{ items: [item] }] } };
  const context = vm.createContext({ state });
  load(context, 'markRestartedDeliveries');
  context.markRestartedDeliveries();
  assert.equal(state.thread.turns[0].items[0].delivery.status, 'received');
});

test(`${provider} reopening after a restart preserves unknown input until it is confirmed`, async () => {
  const renders = [];
  const state = { provider, threads: [], protocolEpoch: 'new', thread: {
    id: 'thread-1', provider, turns: [{ id: 'delivery-turn:command-1', deliveryOnly: true, items: [{
      id: 'delivery:command-1', type: 'userMessage', content: 'Continue',
      delivery: { status: 'unknown', commandId: 'command-1' },
    }] }],
  } };
  const context = vm.createContext({
    state, normalizeAgentThread, reconcileAgentThreadRefresh,
    findTmuxThreadTarget: () => null, resumableThreadCursor: () => null,
    agentRequest: async (_type, params) => ({ thread: { id: params.threadId, turns: [] } }),
    ...Object.fromEntries(['resetThreadHistory', 'resetThreadStream', 'rememberOpenedThread',
      'renderComposerState', 'setLiveMessage', 'settleConfirmedDeliveries', 'renderThreadList',
      'closeDrawer'].map(name => [name, () => {}])),
    scheduleThreadRender: force => renders.push(force),
  });
  load(context, 'openThread');
  await context.openThread('thread-1', { quiet: true });
  assert.equal(renders.at(-1), false, 'quiet same-session reconnect must preserve reading position');
  assert.equal(state.thread.turns[0]?.items[0]?.delivery?.status, 'unknown');
  await context.openThread('another-thread');
  assert.equal(state.thread.turns.length, 0, 'do not carry pending input into a different session');
});
}
