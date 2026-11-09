import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { tmuxSessionsToThreads, findTmuxThreadTarget, findTmuxThreadReplacement, normalizeAgentThread } from '../public/agent-model.js';

const source = fs.readFileSync(new URL('../public/remote.js', import.meta.url), 'utf8');
function functionSource(name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  return source.slice(start, source.indexOf('\n}', start) + 2);
}

test('identity loss withdraws old history, cancels a handoff and ignores its late response', async () => {
  const current = { provider: 'codex', id: 'old', turns: [{ id: 'old-turn' }], tmux: { name: 'research', available: true } };
  const state = { thread: current, activeThreadId: 'old', provider: 'codex', providers: ['codex'], threads: [current], threadListGeneration: 0 };
  let released = 0, resolveOpen;
  const context = vm.createContext({
    state, tmuxSessionsToThreads, findTmuxThreadTarget, findTmuxThreadReplacement, normalizeAgentThread,
    requestedTmuxSession: '', queueMicrotask, Date,
    resetThreadHistory() {}, releaseThreadStream() { released++; }, resetThreadStream() {}, resumableThreadCursor() {},
    renderThreadList() {}, updateTerminalActivity() {}, renderComposerState() {}, scheduleThreadRender() {}, closeDrawer() {},
    setLiveMessage() {}, settleConfirmedDeliveries() {}, rememberOpenedThread() {},
    agentRequest: () => new Promise(resolve => { resolveOpen = resolve; }),
  });
  for (const name of ['openPendingThread', 'handoffTmuxThread', 'loadThreads']) vm.runInContext(functionSource(name), context);
  const next = { ...current, id: 'new' };
  const opening = context.handoffTmuxThread(next);
  state.sessionSnapshot = { sessions: [{ name: 'research', agent: { kind: 'codex', id: null } }] };
  await context.loadThreads({ quiet: true });
  assert.equal(state.thread.id, 'tmux:codex:research');
  assert.equal(state.thread.turns.length, 0);
  assert.equal(released, 1);
  assert.equal(state.threadHandoff, null);
  resolveOpen({ thread: { id: 'new', turns: [{ id: 'late-turn' }] } });
  await opening;
  assert.equal(state.thread.turns.length, 0, 'late history cannot restore a withdrawn identity');
  assert.equal(state.thread.id, 'tmux:codex:research');
  state.threads = [next];
  const restored = context.handoffTmuxThread(next);
  resolveOpen({ thread: { id: 'new', turns: [{ id: 'verified-turn' }] } });
  await restored;
  assert.equal(state.thread.id, 'new');
  assert.equal(state.thread.turns[0].id, 'verified-turn');
});
