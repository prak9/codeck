import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { transcriptNearLatest, transcriptNeedsLatestButton } from '../public/remote-scroll.js';
import { applyAgentEvent } from '../public/agent-model.js';

const source = fs.readFileSync(new URL('../public/remote.js', import.meta.url), 'utf8');

function functionSource(name) {
  const start = source.search(new RegExp(`^function ${name}\\(`, 'm'));
  return start < 0 ? '' : source.slice(start, start + source.slice(start).search(/^}$/m) + 1);
}

test('remote transcript treats only the final 100px as the latest position', () => {
  assert.equal(transcriptNearLatest({ scrollHeight: 1_000, scrollTop: 801, clientHeight: 100 }), true);
  assert.equal(transcriptNearLatest({ scrollHeight: 1_000, scrollTop: 800, clientHeight: 100 }), false);
  assert.equal(transcriptNearLatest({ scrollHeight: 1_000, scrollTop: 900, clientHeight: 100 }), true);
});

test('the latest shortcut appears only for a scrolled-up conversation', () => {
  assert.equal(transcriptNeedsLatestButton({
    scrollHeight: 1_000, scrollTop: 300, clientHeight: 500,
  }, true), true);
  assert.equal(transcriptNeedsLatestButton({
    scrollHeight: 1_000, scrollTop: 500, clientHeight: 500,
  }, true), false);
  assert.equal(transcriptNeedsLatestButton({
    scrollHeight: 400, scrollTop: 0, clientHeight: 500,
  }, true), false);
  assert.equal(transcriptNeedsLatestButton({
    scrollHeight: 1_000, scrollTop: 300, clientHeight: 500,
  }, false), false);
});

test('the scroll shortcut batches visibility checks and moves focus to the latest transcript', () => {
  const transcript = {
    scrollHeight: 1_000,
    scrollTop: 200,
    clientHeight: 500,
    focused: false,
    focus(options) {
      this.focused = options?.preventScroll === true;
    },
  };
  const button = { hidden: true };
  const frames = [];
  const context = vm.createContext({
    state: { thread: { id: 'thread-1' } },
    transcriptScrollFrame: 0,
    transcriptNeedsLatestButton,
    requestAnimationFrame(callback) {
      frames.push(callback);
      return frames.length;
    },
    $(selector) {
      return selector === '#transcript' ? transcript : button;
    },
  });
  for (const name of [
    'syncTranscriptLatestButton', 'scheduleTranscriptLatestButtonSync', 'scrollTranscriptToLatest',
  ]) vm.runInContext(functionSource(name), context);

  context.scheduleTranscriptLatestButtonSync();
  context.scheduleTranscriptLatestButtonSync();
  assert.equal(frames.length, 1);
  frames.shift()();
  assert.equal(button.hidden, false);

  context.scrollTranscriptToLatest();
  assert.equal(transcript.scrollTop, 1_000);
  assert.equal(transcript.focused, true);
  assert.equal(button.hidden, true);
});

test('background turn and approval events do not force a reader away from history', () => {
  const renders = [];
  const state = { provider: 'codex', thread: { provider: 'codex', id: 'thread-1', turns: [] },
    approvals: new Map(), interactions: new Map() };
  const context = vm.createContext({ state, applyAgentEvent,
    messageTargetsCurrentThread: () => true, updateThreadActivity() {}, settleConfirmedDeliveries() {},
    scheduleThreadRender: force => renders.push(Boolean(force)),
  });
  vm.runInContext(functionSource('handleSocketMessage'), context);
  context.handleSocketMessage({ type: 'event', provider: 'codex', method: 'turn/started',
    params: { threadId: 'thread-1', turn: { id: 'new', status: 'inProgress', items: [] } } });
  context.handleSocketMessage({ type: 'approval', provider: 'codex', request: { id: 'approval', params: { threadId: 'thread-1' } } });
  context.handleSocketMessage({ type: 'interaction', provider: 'codex', request: { id: 'question', params: { threadId: 'thread-1' } } });
  assert.deepEqual(renders, [false, false, false], 'renderThread already follows automatically when near latest');
});
