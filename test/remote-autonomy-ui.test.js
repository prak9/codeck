import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { autonomyKey, autonomyPresentation, AUTONOMY_PLANNING_PROMPT } from '../public/remote-autonomy.js';

const source = fs.readFileSync(new URL('../public/remote.js', import.meta.url), 'utf8');
function fixture(status, question) {
  const calls = []; const button = { hidden: false, disabled: false, focus() {} };
  const state = { provider: 'codex', thread: { id: 'thread', tmux: { name: 'report' } }, autonomyRuns: new Map() };
  const context = vm.createContext({ state, autonomyKey, autonomyPresentation, AUTONOMY_PLANNING_PROMPT,
    crypto: { randomUUID: () => 'confirm-command' },
    $: () => button, currentAutonomy: () => ({ status }), autonomyQuestionEntry: () => question,
    currentThreadWaitingForInput: () => false,
    focusPendingAgentRequest: () => calls.push({ type: 'native-dialog' }),
    renderComposerState: () => {},
    setLiveMessage() {}, syncAutonomyDialog: () => calls.push({ type: 'dialog' }),
    agentRequest: async (type, payload) => { calls.push({ type, payload }); return {}; },
    submitComposer: async payload => calls.push({ type: 'send-preset', payload }),
  });
  const start = source.indexOf('async function toggleAutonomy(');
  vm.runInContext(source.slice(start, start + source.slice(start).search(/^}$/m) + 1), context);
  return { context, calls };
}


test('A always sends plain planning input regardless of old managed state', async () => {
  for (const status of ['off', 'ended', 'error', 'running', 'planning', 'completed', 'exiting']) {
    const f = fixture(status, null); await f.context.toggleAutonomy();
    assert.equal(f.calls[0].type, 'send-preset');
    assert.equal(f.calls[0].payload.presetText, AUTONOMY_PLANNING_PROMPT);
  }
});


test('A focuses a pending native question instead of injecting text into its selector', async () => {
  const f = fixture('off', null); f.context.currentThreadWaitingForInput = () => true;
  await f.context.toggleAutonomy(); assert.deepEqual(f.calls, [{ type: 'native-dialog' }]);
});
