import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { CONTINUE_PROMPT } from '../public/continue-prompt.js';

const expectedPrompt = `确认，请按当前目标和约定持续自主推进，不只执行下一步。

在已有授权和剩余预算内，自行决定常规、可逆的行动；遇到问题先诊断并尝试替代方案。阶段性汇报后直接继续，不要反复询问“是否继续”，也不要只列出下一步就结束。

只有目标经验证完成、预算耗尽、我要求停止，或确实需要我补充关键决策、信息或授权时才停下。需要提问时说明具体阻塞，同时继续不受影响的工作。

不扩大范围、不降低验收标准、不重置预算。结束时总结已验证结果、未完成事项和下一步。现在直接执行。`;

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
    CONTINUE_PROMPT,
  });
  vm.runInContext(fn, context);
  await context[name]({ confirm: true });
  assert.deepEqual(calls, [{ type: 'sendSessionMessage', text: expectedPrompt }]);
  assert.equal(selected[0], remote ? '#continueButton' : '#terminalContinueButton');
  waiting = true; await context[name]({ confirm: true });
  assert.equal(calls.length, 1, 'never blindly answers a native approval');
  waiting = false; await context[name]();
  assert.equal(calls.at(-1).text, 'progress', 'question shortcut remains observation-only');
});
