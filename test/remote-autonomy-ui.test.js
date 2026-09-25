import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { autonomyKey, autonomyPresentation, AUTONOMY_DECISIONS } from '../public/remote-autonomy.js';

const source = fs.readFileSync(new URL('../public/remote.js', import.meta.url), 'utf8');
function fixture(status, question) {
  const calls = []; const button = { hidden: false, disabled: false };
  const state = { provider: 'codex', thread: { id: 'thread', tmux: { name: 'report' } }, autonomyRuns: new Map() };
  const context = vm.createContext({ state, autonomyKey, autonomyPresentation, AUTONOMY_DECISIONS,
    crypto: { randomUUID: () => 'confirm-command' },
    $: () => button, currentAutonomy: () => ({ status }), autonomyQuestionEntry: () => question,
    currentThreadWaitingForInput: () => false,
    focusPendingAgentRequest: () => calls.push({ type: 'native-dialog' }),
    renderComposerState: () => { button.disabled = state.autonomyPending; },
    setLiveMessage() {}, syncAutonomyDialog: () => calls.push({ type: 'dialog' }),
    agentRequest: async (type, payload) => { calls.push({ type, payload }); return {}; },
  });
  const start = source.indexOf('async function toggleAutonomy(');
  vm.runInContext(source.slice(start, start + source.slice(start).search(/^}$/m) + 1), context);
  return { context, calls };
}

test('A confirms the displayed proposal once instead of reopening the dialog or pausing', async () => {
  const f = fixture('confirming', { plan: { maxRounds: 5 }, request: { id: 'proposal-request' } });
  await Promise.all([f.context.toggleAutonomy(), f.context.toggleAutonomy()]);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].type, 'answerAutonomy');
  assert.equal(f.calls[0].payload.requestId, 'proposal-request');
  assert.equal(f.calls[0].payload.answers.decision[0], '按此目标开始');
  assert.equal(f.calls[0].payload.tmuxSession, 'report');
});

test('A still opens missing-information choices and pauses an executing run', async () => {
  const ask = fixture('configuring', { request: { id: 'goal-question' } });
  await ask.context.toggleAutonomy(); assert.deepEqual(ask.calls, [{ type: 'dialog' }]);
  const running = fixture('running', null); await running.context.toggleAutonomy();
  assert.equal(running.calls[0].type, 'pauseAutonomy');
});

test('A cancels queued configuration without approving or starting work', async () => {
  const f = fixture('configuring', null); await f.context.toggleAutonomy();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].type, 'pauseAutonomy');
});

test('A opens a pending native question without automatically answering or pausing it', async () => {
  const f = fixture('blocked', null);
  f.context.currentThreadWaitingForInput = () => true;
  await f.context.toggleAutonomy();
  assert.deepEqual(f.calls, [{ type: 'native-dialog' }]);
});
