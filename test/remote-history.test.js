import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileAgentThreadRefresh } from '../public/agent-model.js';

const source = fs.readFileSync(new URL('../public/remote.js', import.meta.url), 'utf8');
function functionSource(name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  return start < 0 ? '' : source.slice(start, start + source.slice(start).search(/^}$/m) + 1);
}
const turn = (id, text = id) => ({ id, status: 'completed', items: [{ id: `answer:${id}`, type: 'agentMessage', text }] });
const thread = (id = 'thread-a', session = 'session-a') => ({
  id, provider: 'codex', truncated: true, oldestTurnId: 'recent',
  tmux: { name: session }, turns: [turn('recent')],
});

function fixture() {
  const state = { provider: 'codex', providers: ['codex'], thread: thread(), historyGeneration: 0, loadingEarlier: false };
  const transcript = { scrollHeight: 100, scrollTop: 10 };
  const frames = [], requests = [], messages = [], renders = [];
  const context = vm.createContext({
    state, $: () => transcript,
    agentRequest(type, params) {
      return new Promise((resolve, reject) => requests.push({ type, params, resolve, reject }));
    },
    requestAnimationFrame: (callback) => frames.push(callback),
    scheduleThreadRender: () => renders.push(state.loadingEarlier), setLiveMessage: (message) => { if (message) messages.push(message); },
    releaseThreadStream() {}, renderThreadList() {}, closeDrawer() {}, renderProviderControls() {},
    localStorage: { setItem() {} }, setTimeout() {},
  });
  for (const name of ['resetThreadHistory', 'loadEarlierTurns', 'startNewThread']) {
    const body = functionSource(name);
    if (body) vm.runInContext(body, context);
  }
  const reopen = (next = thread()) => {
    context.startNewThread({ focus: false });
    state.thread = next;
  };
  const flushFrames = () => { for (const callback of frames.splice(0)) callback(); };
  return { state, transcript, requests, messages, renders, context, reopen, flushFrames };
}

test('history merges into the latest same-view stream without losing new output or duplicating turns', async () => {
  const f = fixture();
  const pending = f.context.loadEarlierTurns();
  f.state.thread = reconcileAgentThreadRefresh(f.state.thread, {
    ...thread(), liveOutput: 'new pane output', turns: [turn('recent', 'updated answer'), turn('new')],
  });
  f.requests[0].resolve({ turns: [turn('older'), turn('recent', 'stale answer')], truncated: false, oldestTurnId: 'older' });
  await pending;
  assert.deepEqual(Array.from(f.state.thread.turns, (item) => item.id), ['older', 'recent', 'new']);
  assert.equal(f.state.thread.turns[1].items[0].text, 'updated answer');
  assert.equal(f.state.thread.liveOutput, 'new pane output');
  assert.equal(f.state.thread.truncated, false);
  assert.equal(f.state.loadingEarlier, false);
});

test('switching away and back releases loading but an old response cannot finish the new request', async () => {
  const f = fixture();
  const old = f.context.loadEarlierTurns();
  f.reopen(thread('thread-b', 'session-b'));
  f.reopen();
  assert.equal(f.state.loadingEarlier, false);
  const current = f.context.loadEarlierTurns();
  assert.equal(f.requests.length, 2);
  f.requests[0].resolve({ turns: [turn('stale')], truncated: false });
  await old;
  assert.equal(f.state.loadingEarlier, true);
  assert.deepEqual(Array.from(f.state.thread.turns, (item) => item.id), ['recent']);
  f.requests[1].resolve({ turns: [turn('older')], truncated: false });
  await current;
  assert.deepEqual(Array.from(f.state.thread.turns, (item) => item.id), ['older', 'recent']);
  assert.equal(f.state.loadingEarlier, false);
});

test('stale history failures and scroll callbacks cannot affect a reopened view', async () => {
  const f = fixture();
  const failed = f.context.loadEarlierTurns();
  f.reopen();
  f.requests[0].reject(new Error('old request failed'));
  await failed;
  assert.deepEqual(f.messages, []);
  const success = f.context.loadEarlierTurns();
  f.requests[1].resolve({ turns: [turn('older')], truncated: false });
  await success;
  f.reopen();
  f.transcript.scrollHeight = 300;
  f.flushFrames();
  assert.equal(f.transcript.scrollTop, 10);
});

test('scroll compensation measures the height at merge time and ignores a superseding request', async () => {
  const f = fixture();
  const pending = f.context.loadEarlierTurns();
  f.transcript.scrollHeight = 180;
  f.requests[0].resolve({ turns: [turn('older')], truncated: true, oldestTurnId: 'older' });
  await pending;
  f.transcript.scrollHeight = 230;
  f.flushFrames();
  assert.equal(f.transcript.scrollTop, 60);
  const next = f.context.loadEarlierTurns();
  f.requests[1].resolve({ turns: [turn('oldest')], truncated: true, oldestTurnId: 'oldest' });
  await next;
  const newest = f.context.loadEarlierTurns();
  f.transcript.scrollHeight = 400;
  f.flushFrames();
  assert.equal(f.transcript.scrollTop, 60);
  f.requests[2].resolve({ turns: [], truncated: false });
  await newest;
});

test('a same-thread history request is not duplicated while pending and current failures remain retryable', async () => {
  const f = fixture();
  const pending = f.context.loadEarlierTurns();
  await f.context.loadEarlierTurns();
  assert.equal(f.requests.length, 1);
  f.requests[0].reject(new Error('temporary history failure'));
  await pending;
  assert.deepEqual(f.messages, ['temporary history failure']);
  assert.equal(f.state.loadingEarlier, false);
});

test('an opening view or rolled-back history cannot receive a stale prefix', async () => {
  const f = fixture();
  f.state.threadOpening = {};
  await f.context.loadEarlierTurns();
  assert.equal(f.requests.length, 0);
  f.state.threadOpening = null;
  const pending = f.context.loadEarlierTurns();
  f.state.thread = { ...thread(), turns: [turn('rollback-target')] };
  f.requests[0].resolve({ turns: [turn('obsolete-prefix')], truncated: false });
  await pending;
  assert.deepEqual(Array.from(f.state.thread.turns, (item) => item.id), ['rollback-target']);
  assert.equal(f.state.loadingEarlier, false);
});

test('invalidating an outstanding request redraws its loading control before a replacement finishes', async () => {
  const f = fixture();
  const pending = f.context.loadEarlierTurns();
  assert.deepEqual(f.renders, [true]);
  f.context.resetThreadHistory();
  assert.deepEqual(f.renders, [true, false]);
  f.requests[0].reject(new Error('stale failure'));
  await pending;
  assert.deepEqual(f.renders, [true, false]);
});

test('every explicit view replacement invalidates pending history, including same-id reopen and handoff', () => {
  for (const name of ['openPendingThread', 'openShellThread', 'handoffTmuxThread', 'openThread', 'startNewThread', 'switchProvider']) {
    assert.match(functionSource(name), /resetThreadHistory\(\)/, name);
  }
  assert.doesNotMatch(functionSource('refreshActiveThread'), /resetThreadHistory\(\)/);
});
