import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { CONTINUE_PROMPT } from '../public/continue-prompt.js';
import { AUTONOMY_PROGRESS_PROMPT } from '../public/remote-autonomy.js';

const expectedPrompt = '确认，请按当前目标、授权和预算自主推进。阶段汇报后直接继续，不反复请示；仅在完成、预算耗尽、我要求停止或确需我决策时停下，并总结结果与下一步。';
const expectedProgress = '请简要汇报当前目标、进展、剩余事项和阻塞。仅汇报，不打断、不续跑、不改方向或预算。';

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
    PROGRESS_PROMPT: AUTONOMY_PROGRESS_PROMPT,
    CONTINUE_PROMPT,
  });
  vm.runInContext(fn, context);
  await context[name]({ confirm: true });
  assert.deepEqual(calls, [{ type: 'sendSessionMessage', text: expectedPrompt }]);
  assert.equal(selected[0], remote ? '#continueButton' : '#terminalContinueButton');
  waiting = true; await context[name]({ confirm: true });
  assert.equal(calls.length, 1, 'never blindly answers a native approval');
  waiting = false; await context[name]();
  assert.equal(calls.at(-1).text, expectedProgress, 'question shortcut remains observation-only');
});
