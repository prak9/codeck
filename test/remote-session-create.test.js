import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRemoteSessionPayload } from '../public/remote-session.js';

const source = fs.readFileSync(new URL('../public/remote.js', import.meta.url), 'utf8');

function functionSource(name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  return start < 0 ? '' : source.slice(start, source.indexOf('\n}', start) + 2);
}

function fixture() {
  const nodes = new Map();
  const node = () => ({
    value: '', textContent: '', hidden: false, disabled: false, open: false, children: [],
    listeners: new Map(), dataset: {},
    append() {}, focus() {},
    addEventListener(type, handler) { this.listeners.set(type, handler); },
    replaceChildren(...children) { this.children = children; },
    close() { this.open = false; }, showModal() { this.open = true; },
  });
  const $ = (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, node());
    return nodes.get(selector);
  };
  const controls = ['#sessionNameInput', '#sessionProvider', '#sessionMode', '#sessionCwdInput', '#createSessionButton'].map($);
  $('#newSessionForm').querySelectorAll = () => controls;
  $('#sessionNameInput').value = 'work';
  $('#sessionProvider').value = 'codex';
  $('#sessionMode').value = 'new';
  $('#sessionCwdInput').value = '/srv/project';
  $('#newSessionDialog').open = true;
  const state = { provider: 'codex', providers: ['codex', 'claude', 'qodercli'], defaultCwd: '/srv', threads: [], sessionCreationPending: false };
  const created = [], opened = [], navigated = [], saved = [];
  let waited = 0;
  const context = vm.createContext({
    $, state, createRemoteSessionPayload,
    element: (_tag, _className, text) => Object.assign(node(), { textContent: text }),
    providerDetails: (provider) => ({ name: provider }),
    preferredAgentProvider: () => 'codex', preferredNewSessionProvider: () => 'codex',
    renderHeader() {}, updateSuggestedSessionName() {}, setLiveMessage() {}, startNewThread() {},
    localStorage: { setItem: (...args) => saved.push(args) },
    location: { assign: (url) => navigated.push(url) },
    encodeURIComponent, setTimeout() {},
    requestSessionCreation: async (payload) => created.push(payload),
    waitForCreatedSession: async (name, provider) => {
      waited += 1;
      return { id: `${provider}-id`, provider, readOnly: true, tmux: { name, available: true } };
    },
    openThread: async (_id, { provider }) => opened.push(`agent:${provider}`),
    openShellThread: (thread) => opened.push(`shell:${thread.tmux.name}`),
    openPendingThread: (thread) => opened.push(`pending:${thread.provider}`),
  });
  for (const name of ['syncNewSessionMode', 'renderProviderControls', 'openListedThread', 'openNewSession']) {
    vm.runInContext(functionSource(name), context);
  }
  const start = source.indexOf("$('#newSessionForm').addEventListener('submit'");
  vm.runInContext(source.slice(start, source.indexOf("\n$('#settingsForm')", start)), context);
  const submit = (value = 'default') => $('#newSessionForm').listeners.get('submit')({
    preventDefault() {}, submitter: { value },
  });
  return { $, context, state, created, opened, navigated, saved, submit, get waited() { return waited; } };
}

test('Remote offers Shell only for session creation and preserves an open form across provider refreshes', () => {
  const f = fixture();
  f.$('#sessionProvider').value = 'shell';
  f.context.renderProviderControls();
  assert.deepEqual(f.$('#sessionProvider').children.map(option => option.value), ['codex', 'claude', 'qodercli', 'shell']);
  assert.equal(f.$('#sessionProvider').value, 'shell');
  assert.deepEqual(f.$('#settingsProvider').children.map(option => option.value), ['codex', 'claude', 'qodercli']);
});

test('Remote resume enters the terminal picker without waiting for Agent identity', async () => {
  const f = fixture();
  f.$('#sessionMode').value = 'resume';
  await f.submit();
  assert.equal(f.created[0].mode, 'resume');
  assert.deepEqual(f.navigated, ['/?session=work']);
  assert.equal(f.waited, 0);
  assert.deepEqual(f.opened, []);
});

test('Remote Shell creation opens the local Shell view without an Agent backend', async () => {
  const f = fixture();
  f.$('#sessionProvider').value = 'shell';
  await f.submit();
  assert.equal(f.created[0].client, 'shell');
  assert.deepEqual(f.opened, ['shell:work']);
  assert.deepEqual(f.navigated, []);
  assert.ok(!f.saved.some(([key, value]) => key === 'codeck-remote-provider' && value === 'shell'));
  assert.equal(f.$('#sessionMode').disabled, true);
});

test('Remote new Agent creation still opens the requested structured conversation', async () => {
  const f = fixture();
  await f.submit();
  assert.deepEqual(f.opened, ['agent:codex']);
  assert.deepEqual(f.navigated, []);
});

test('Shell clears resume and reopening the creation form resets to a fresh session', () => {
  const f = fixture();
  f.$('#sessionMode').value = 'resume';
  f.$('#sessionProvider').value = 'shell';
  f.context.syncNewSessionMode();
  assert.equal(f.$('#sessionMode').value, 'new');
  assert.equal(f.$('#sessionMode').disabled, true);
  assert.equal(f.$('#sessionModeFields').hidden, true);
  f.$('#sessionProvider').value = 'codex';
  f.context.syncNewSessionMode();
  assert.equal(f.$('#sessionMode').disabled, false);
  assert.equal(f.$('#sessionMode').value, 'new');
  f.$('#sessionMode').value = 'resume';
  f.context.openNewSession();
  assert.equal(f.$('#sessionMode').value, 'new');
});

test('failed resume creation preserves the form, permits retry, and never navigates', async () => {
  const f = fixture();
  f.$('#sessionMode').value = 'resume';
  f.context.requestSessionCreation = async () => { throw new Error('name already exists'); };
  await f.submit();
  assert.equal(f.$('#newSessionDialog').open, true);
  assert.equal(f.$('#sessionMode').value, 'resume');
  assert.equal(f.$('#createSessionButton').disabled, false);
  assert.equal(f.$('#sessionError').textContent, 'name already exists');
  assert.deepEqual(f.navigated, []);
});

test('cancel and repeated submissions cannot create extra sessions', async () => {
  const f = fixture();
  await f.submit('cancel');
  assert.deepEqual(f.created, []);
  let finish;
  f.context.requestSessionCreation = (payload) => {
    f.created.push(payload);
    return new Promise(resolve => { finish = resolve; });
  };
  const pending = f.submit();
  await f.submit();
  assert.equal(f.created.length, 1);
  finish();
  await pending;
});
