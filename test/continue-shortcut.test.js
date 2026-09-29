import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

for (const remote of [false, true]) test(`${remote ? 'remote' : 'normal'}: independent confirmation sends conversation text, not an autonomy action`, async () => {
  const source = fs.readFileSync(new URL(`../public/${remote ? 'remote' : 'app'}.js`, import.meta.url), 'utf8');
  const name = remote ? 'askProgress' : 'askTerminalProgress';
  const start = source.indexOf(`async function ${name}(`);
  const fn = source.slice(start, source.indexOf('\n}', start) + 2);
  const calls = [], selected = [];
  let waiting = false;
  const target = { provider: 'codex', threadId: 't', tmuxSession: 'work', progressKey: 'key' };
  const context = vm.createContext({
    $: id => { selected.push(id); return { hidden: false, disabled: false }; },
    state: { canWrite: true, terminal: { focus() {} } },
    activeAgentSessionTarget: () => ({ ...target, question: waiting }),
    crypto: { randomUUID: () => 'command' }, syncTerminalProgressButton() {}, setConnectionMessage() {},
    sessionFeedRequest: async (type, args) => { calls.push({ type, text: args.text }); return {}; },
    currentThreadWaitingForInput: () => waiting, focusPendingAgentRequest() {},
    submitComposer: async args => calls.push({ type: 'sendSessionMessage', text: args.presetText }),
    PROGRESS_PROMPT: 'progress',
  });
  vm.runInContext(fn, context);
  await context[name]({ confirm: true });
  assert.deepEqual(calls, [{ type: 'sendSessionMessage', text: '好的，请按当前目标和约定继续推进。' }]);
  assert.equal(selected[0], remote ? '#continueButton' : '#terminalContinueButton');
  waiting = true; await context[name]({ confirm: true });
  assert.equal(calls.length, 1, 'never blindly answers a native approval');
});
