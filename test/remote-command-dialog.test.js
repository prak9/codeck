import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSessionCommandOutput, parseSkillsCommandOutput } from '../public/remote-command-output.js';

const source = fs.readFileSync(new URL('../public/remote.js', import.meta.url), 'utf8');
function load(context, name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  vm.runInContext(source.slice(start, start + source.slice(start).search(/^}$/m) + 1), context);
}
function element(tag, className, text = '') {
  return { tag, className, text, children: [], append(...nodes) { this.children.push(...nodes); } };
}

test('skills popup renders the parsed skill names rather than blank cards', () => {
  const context = vm.createContext({ element, parseSkillsCommandOutput });
  for (const name of ['skillCard', 'skillsCommandDialog']) load(context, name);
  const dialog = context.skillsCommandDialog({ text: 'Skills\nweb-design  Design web interfaces' });
  assert.equal(dialog.content.children[0].children[0].children[0].text, 'web-design');
});

test('native skills action menus remain readable output, not a misleading skill list', () => {
  const context = vm.createContext({
    element,
    state: { provider: 'codex' }, normalizeSessionCommandOutput,
    skillsCommandDialog() { assert.fail('an action picker is not a list of skills'); },
  });
  load(context, 'commandDialogPresentation');
  const text = 'Skills\nChoose an action\n› 1. List skills  Open list\n2. Enable/Disable Skills\nPress enter to confirm or esc to go back';
  const dialog = context.commandDialogPresentation({ command: '/skills', text });
  assert.equal(dialog.content.text, text);
});

for (const provider of ['claude', 'qodercli']) {
  test(`${provider} unsupported model selection is readable without dead buttons`, () => {
    const context = vm.createContext({ element, state: { provider }, normalizeSessionCommandOutput,
      modelCommandDialog() { assert.fail('native model selection is not supported'); },
    });
    load(context, 'commandDialogPresentation');
    const text = 'Select Model and Effort\n› 1. model-a (current)  Fast';
    const dialog = context.commandDialogPresentation({ command: '/model', text });
    assert.equal(dialog.content.text, text);
  });
}

test('explicit popup close waits for its native dismissal and cannot close a replacement dialog', async () => {
  let resolve;
  let dismissed = 0;
  const requests = [];
  const commandOutput = { command: '/model', text: 'menu' };
  const state = { provider: 'codex', thread: { provider: 'codex', id: 'thread', tmux: { name: 'work', commandOutput } } };
  const context = vm.createContext({
    normalizeSessionCommandOutput,
    state, composerRequestGate: { pending: false, run: callback => callback() },
    agentRequest: (type, params) => { requests.push({ type, ...params }); return new Promise(r => { resolve = r; }); },
    dismissCommandDialog: () => { dismissed += 1; }, setLiveMessage() {},
  });
  load(context, 'closeCommandDialog');
  const close = context.closeCommandDialog();
  assert.equal(dismissed, 0);
  state.thread.tmux.commandOutput = { command: '/status', text: 'new result' };
  resolve({ dismissed: true });
  await close;
  assert.equal(dismissed, 0);
  assert.deepEqual(requests, [{ type: 'dismissSessionCommand', provider: 'codex', threadId: 'thread', tmuxSession: 'work', command: '/model' }]);
});

test('a temporary approval failure leaves the existing choices retryable', async () => {
  const buttons = [{ disabled: false }, { disabled: false }];
  const messages = [];
  const entry = { provider: 'codex', request: { id: 'approval', params: { threadId: 'thread' } } };
  const state = { approvals: new Map([['codex:approval', entry]]) };
  const context = vm.createContext({ state,
    agentRequest: async () => { throw new Error('Agent 连接已断开'); },
    messageTargetsCurrentThread: () => true,
    scheduleThreadRender() {}, setLiveMessage: message => messages.push(message),
  });
  load(context, 'resolveApproval');
  await context.resolveApproval('codex:approval', entry, 'accept', { querySelectorAll: () => buttons });
  assert.ok(buttons.every(button => !button.disabled));
  assert.equal(state.approvals.size, 1);
  assert.match(messages[0], /连接已断开/);
});
