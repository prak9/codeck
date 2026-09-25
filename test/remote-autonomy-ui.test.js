import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { autonomyKey, autonomyPresentation } from '../public/remote-autonomy.js';

const source = fs.readFileSync(new URL('../public/remote.js', import.meta.url), 'utf8');
function fixture(status, question) {
  const calls = []; const button = { hidden: false, disabled: false, focus() {} };
  const state = { provider: 'codex', thread: { id: 'thread', tmux: { name: 'report' } }, autonomyRuns: new Map() };
  const context = vm.createContext({ state, autonomyKey, autonomyPresentation,
    crypto: { randomUUID: () => 'confirm-command' },
    $: () => button, currentAutonomy: () => ({ status }), autonomyQuestionEntry: () => question,
    currentThreadWaitingForInput: () => false,
    focusPendingAgentRequest: () => calls.push({ type: 'native-dialog' }),
    renderComposerState: () => {},
    setLiveMessage() {}, syncAutonomyDialog: () => calls.push({ type: 'dialog' }),
    agentRequest: async (type, payload) => { calls.push({ type, payload }); return {}; },
  });
  const start = source.indexOf('async function toggleAutonomy(');
  vm.runInContext(source.slice(start, start + source.slice(start).search(/^}$/m) + 1), context);
  return { context, calls };
}


test('A opens setup from inactive states and exits active execution', async () => {
  for (const status of ['off', 'error', 'completed', 'configuring']) {
    const f = fixture(status, null); await f.context.toggleAutonomy();
    assert.equal(f.calls[0].type, 'startAutonomy');
  }
  for (const status of ['running', 'exiting']) {
    const f = fixture(status, null); await f.context.toggleAutonomy();
    assert.equal(f.calls[0].type, 'finishAutonomy');
  }
});

test('A never locks on an outstanding request; stale errors cannot overwrite latest intent', async () => {
  const f = fixture('off', null); let reject;
  f.context.agentRequest = () => new Promise((_resolve, fail) => { reject = fail; });
  const first = f.context.toggleAutonomy();
  f.context.agentRequest = async () => ({});
  const messages = []; f.context.setLiveMessage = text => messages.push(text);
  await f.context.toggleAutonomy(); reject(new Error('old failure')); await first;
  assert.equal(f.context.state.autonomyPending, false);
  assert.equal(messages.includes('old failure'), false);
});

test('only an explicit setup form is eligible for the A dialog', () => {
  let run = { status: 'paused', requestId: 'old', questions: [{ id: 'old' }] };
  const context = vm.createContext({ currentAutonomy: () => run, autonomyKey });
  const start = source.indexOf('function autonomyQuestionEntry(');
  vm.runInContext(source.slice(start, start + source.slice(start).search(/^}$/m) + 1), context);
  assert.equal(context.autonomyQuestionEntry(), null);
  run = { status: 'configuring', setup: true, requestId: 'new', target: { provider: 'codex', threadId: 't', tmuxSession: 's' } };
  assert.ok(context.autonomyQuestionEntry());
});
