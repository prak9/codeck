import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAgentThread, reconcileAgentThreadRefresh } from '../public/agent-model.js';

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
