import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { currentCommandOutput, setCommandOutput, normalizeSessionCommandOutput, parseSkillsCommandOutput } from '../public/remote-command-output.js';

const source = fs.readFileSync(new URL('../public/remote.js', import.meta.url), 'utf8');
function load(context, name) {
  Object.assign(context, { currentCommandOutput, setCommandOutput });
  if (name === 'selectionCommandDialog') load(context, 'revealCommandCursor');
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

test('a same-session snapshot refresh does not discard a command choice result', async () => {
  const commandOutput = normalizeSessionCommandOutput('codex', '/usage', {
    terminalOutput: 'Usage\n› 1. Show usage  View usage\nPress enter to confirm or esc to go back',
  });
  const state = { provider: 'codex', thread: { id: 'thread', tmux: { name: 'work', commandOutput } } };
  const nodes = [];
  const context = vm.createContext({
    state, normalizeSessionCommandOutput,
    element(tag, cls, text) {
      const node = element(tag, cls, text);
      node.addEventListener = (type, fn) => { node[type] = fn; };
      node.querySelectorAll = () => nodes.filter(n => n.tag === 'button');
      nodes.push(node); return node;
    },
    composerRequestGate: { pending: false, run: fn => fn() },
    agentRequest: async () => {
      state.thread = { ...state.thread, tmux: { ...state.thread.tmux } };
      return { terminalOutput: 'Latest usage' };
    }, scheduleThreadRender() {}, setLiveMessage() {},
  });
  load(context, 'selectionCommandDialog');
  context.selectionCommandDialog(commandOutput);
  await nodes.find(n => n.tag === 'button').click();
  assert.equal(state.thread.tmux.commandOutput.text, 'Latest usage');
});

test('AGY menu arrow keys and Enter follow native selection in order and leave text editing alone', async () => {
  const makeMenu = index => ({ command: '/permissions', text: ['> Project\n  User', '  Project\n> User'][index],
    kind: 'commandSelection', parsed: { heading: 'Permissions', dashboard: true, notes: [],
      items: [{ label: '↑', key: 'Up' }, { label: '↓', key: 'Down' }, { label: 'Enter', key: 'Enter' }] } });
  const state = { provider: 'agy', thread: { id: 'thread', provider: 'agy', tmux: { name: 'label' }, nativeCommand: makeMenu(0) } };
  const requests = [];
  let release;
  const first = new Promise(resolve => { release = resolve; });
  const context = vm.createContext({ state, normalizeSessionCommandOutput,
    element(tag, cls, text) {
      const node = element(tag, cls, text);
      node.addEventListener = (type, fn) => { node[type] = fn; };
      node.replaceChildren = (...children) => { node.children = children; };
      return node;
    },
    composerRequestGate: { pending: false, async run(fn) { this.pending = true; try { await fn(); } finally { this.pending = false; } } },
    agentRequest: async (_, payload) => {
      requests.push([payload.option, payload.menuText]);
      if (requests.length === 1) await first;
      if (payload.option === 'Enter') return { completed: true };
      const next = makeMenu(payload.option === '↓' ? 1 : 0);
      return { terminalOutput: next.text, commandOutput: next };
    }, scheduleThreadRender() {}, dismissCommandDialog() {}, setLiveMessage() {},
  });
  vm.runInContext('let pendingMenuNavigation = null;', context);
  load(context, 'selectionCommandDialog');
  const view = context.selectionCommandDialog(state.thread.nativeCommand);
  assert.equal(view.focusSelector, '.command-output-body');
  const press = (key, editing = false) => {
    let prevented = false;
    view.content.keydown({ key, target: { closest: () => editing }, preventDefault() { prevented = true; } });
    return prevented;
  };
  assert.equal(press('ArrowDown', true), false);
  assert.equal(press('ArrowDown'), true);
  assert.equal(press('ArrowUp'), true);
  assert.equal(press('Enter'), true);
  assert.equal(press('Enter'), true);
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(requests, [['↓', makeMenu(0).text], ['↑', makeMenu(1).text], ['Enter', makeMenu(0).text]]);
});

test('refreshing an open AGY picker keeps its search input and uses the latest pane text for actions', async () => {
  const menu = text => ({ command: '/permissions', kind: 'commandSelection', text, parsed: { dashboard: true,
    textEntry: true, heading: 'Permissions', items: [{ label: 'Enter', key: 'Enter' }], notes: [] } });
  const first = menu('> Project\n  User'), second = menu('  Project\n> User');
  const state = { provider: 'agy', thread: { id: 'thread', provider: 'agy', tmux: { name: 'label' }, nativeCommand: first } };
  const nodes = [], requests = [];
  const context = vm.createContext({ state, normalizeSessionCommandOutput,
    element(tag, cls, text) {
      const node = element(tag, cls, text);
      node.addEventListener = (type, fn) => { node[type] = fn; };
      node.replaceChildren = (...children) => { node.children = children; };
      node.setAttribute = () => {};
      nodes.push(node); return node;
    },
    composerRequestGate: { pending: false, run: fn => fn() },
    agentRequest: async (_, params) => { requests.push(params.menuText); return { completed: true }; },
    dismissCommandDialog() {},
  });
  load(context, 'selectionCommandDialog');
  const view = context.selectionCommandDialog(first);
  const input = nodes.find(n => n.tag === 'input');
  input.value = 'my draft';
  state.thread.nativeCommand = second;
  assert.equal(view.update(second), true);
  assert.deepEqual(nodes.filter(n => n.tag === 'input'), [input]);
  assert.equal(input.value, 'my draft');
  assert.equal(nodes.find(n => n.tag === 'pre').children[1].text, '> User');
  await nodes.find(n => n.tag === 'button' && n.click).click();
  assert.deepEqual(requests, [second.text]);
  assert.equal(view.update({ ...second, parsed: { ...second.parsed, heading: 'Edit Rule' } }), false);
});
