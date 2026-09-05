import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const styles = fs.readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');

function functionSource(name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  return source.slice(start, source.indexOf('\n}', start) + 2);
}

function creationFixture() {
  const nodes = new Map();
  const listeners = new Map();
  const requests = [];
  const connected = [];
  let refreshes = 0;
  const $ = (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, {
      value: '', textContent: '', disabled: false, open: false,
      showModal() { this.open = true; }, close() { this.open = false; }, select() {},
      addEventListener(type, listener) { listeners.set(`${selector}:${type}`, listener); },
    });
    return nodes.get(selector);
  };
  const state = { newDialogGeneration: 0 };
  const context = vm.createContext({
    state, $, Date, syncNewSessionMode() {},
    FormData: class { constructor() { return [['name', $('#nameInput').value], ['client', 'codex']]; } },
    api: () => new Promise((resolve, reject) => requests.push({ resolve, reject })),
    connect: (name) => connected.push(name), refreshSessions: async () => { refreshes += 1; },
  });
  vm.runInContext(functionSource('openNewDialog'), context);
  const start = source.indexOf("$('#newForm').addEventListener('submit'");
  vm.runInContext(source.slice(start, source.indexOf("\n$('#killButton')", start)), context);
  const submit = () => listeners.get('#newForm:submit')({ preventDefault() {}, currentTarget: {} });
  const open = (name) => { context.openNewDialog(); $('#nameInput').value = name; };
  return { $, requests, connected, submit, open, refreshes: () => refreshes };
}

test('cancelled creation refreshes the list but cannot close or navigate a reopened form', async () => {
  const f = creationFixture();
  f.open('first');
  const pending = f.submit();
  f.$('#newDialog').close();
  f.open('second');
  assert.equal(f.$('#createButton').disabled, false);
  f.requests[0].resolve({ ok: true });
  await pending;
  assert.equal(f.$('#newDialog').open, true);
  assert.equal(f.$('#nameInput').value, 'second');
  assert.deepEqual(f.connected, []);
  assert.equal(f.refreshes(), 1);
});

test('a late creation error cannot overwrite a newer pending form or enable its submit button', async () => {
  const f = creationFixture();
  f.open('first');
  const first = f.submit();
  f.$('#newDialog').close();
  f.open('second');
  const second = f.submit();
  assert.equal(f.requests.length, 2);
  f.requests[0].reject(new Error('old failure'));
  await first;
  assert.equal(f.$('#newError').textContent, '');
  assert.equal(f.$('#createButton').disabled, true);
  f.requests[1].resolve({ ok: true });
  await second;
  assert.deepEqual(f.connected, ['second']);
  assert.equal(f.$('#newDialog').open, false);
  assert.equal(f.$('#createButton').disabled, false);
});

test('closing a pending creation without reopening does not navigate on completion', async () => {
  const f = creationFixture();
  f.open('first');
  const pending = f.submit();
  f.$('#newDialog').close();
  f.requests[0].resolve({ ok: true });
  await pending;
  assert.deepEqual(f.connected, []);
  assert.equal(f.refreshes(), 1);
});

test('creation still prevents duplicate submissions and exposes current errors', async () => {
  const f = creationFixture();
  f.open('first');
  const pending = f.submit();
  await f.submit();
  assert.equal(f.requests.length, 1);
  f.requests[0].reject(new Error('current failure'));
  await pending;
  assert.equal(f.$('#newError').textContent, 'current failure');
  assert.equal(f.$('#newDialog').open, true);
  assert.equal(f.$('#createButton').disabled, false);
});

test('disconnect recovery occupies the existing header without changing the terminal grid layout', () => {
  const header = html.match(/<header class="terminal-header">([\s\S]*?)<\/header>/)?.[1] || '';
  assert.ok(header.includes('id="terminalDisconnect"'));
  assert.match(styles, /\.terminal-header\s*\{[^}]*position:\s*relative/);
  assert.match(styles, /\.terminal-disconnect\s*\{[^}]*position:\s*absolute/);
  assert.match(styles, /\.terminal-disconnect\s*\{[^}]*inset:\s*0/);
});
