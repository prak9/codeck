import { EventEmitter } from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleTerminalConnection } from '../src/terminal-connection.js';

class FakeSocket extends EventEmitter {
  OPEN = 1;
  readyState = this.OPEN;
  closes = [];
  sent = [];

  close(code, reason) {
    this.closes.push({ code, reason });
    this.readyState = 3;
    this.emit('close');
  }

  send(data) { this.sent.push(data); }
}

function fakeTerminal() {
  return {
    killed: false,
    writes: [],
    sizes: [],
    onData(callback) { this.dataCallback = callback; },
    onExit(callback) { this.exitCallback = callback; },
    write(data) { this.writes.push(data); },
    resize(cols, rows) { this.sizes.push([cols, rows]); },
    kill() { this.killed = true; },
  };
}

function dependencies(overrides = {}) {
  return {
    getSessionSize: async () => ({ width: 80, height: 24 }),
    getLinkedWindowSessions: async () => [],
    preferLatestClientSize: async () => true,
    clampViewport: (cols, rows) => [Math.max(20, cols), Math.max(6, rows)],
    scrollSession: async () => {},
    createTerminal: () => fakeTerminal(),
    ...overrides,
  };
}

test('a socket closed during setup never creates a terminal', async () => {
  const ws = new FakeSocket();
  let releaseLinks;
  let creates = 0;
  const setup = handleTerminalConnection(ws, 'phone', { width: 48, height: 20 }, dependencies({
    getLinkedWindowSessions: () => new Promise((resolve) => { releaseLinks = resolve; }),
    createTerminal: () => { creates += 1; return fakeTerminal(); },
  }));
  await Promise.resolve();

  ws.readyState = 3;
  ws.emit('close');
  releaseLinks([]);
  await setup;
  assert.equal(creates, 0);
});

test('a linked active window is rejected before tmux attach', async () => {
  const ws = new FakeSocket();
  let configures = 0;
  let creates = 0;
  await handleTerminalConnection(ws, 'phone', { width: 48, height: 20 }, dependencies({
    getLinkedWindowSessions: async () => ['desktop-peer'],
    preferLatestClientSize: async () => { configures += 1; },
    createTerminal: () => { creates += 1; return fakeTerminal(); },
  }));

  assert.equal(configures, 0);
  assert.equal(creates, 0);
  assert.equal(ws.closes[0].code, 1008);
  assert.match(ws.closes[0].reason, /共享/);
});

test('messages received during setup are applied after an exact-size attach', async () => {
  const ws = new FakeSocket();
  const terminal = fakeTerminal();
  let releaseLinks;
  const setup = handleTerminalConnection(ws, 'phone', { width: 48, height: 1 }, dependencies({
    getLinkedWindowSessions: () => new Promise((resolve) => { releaseLinks = resolve; }),
    createTerminal: () => terminal,
  }));
  await Promise.resolve();
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'input', data: 'x' })), false);
  releaseLinks([]);
  await setup;

  assert.deepEqual(terminal.sizes, [[48, 6]]);
  assert.deepEqual(terminal.writes, ['x']);
  ws.emit('close');
  assert.equal(terminal.killed, true);
});

test('a supplied browser viewport skips the redundant tmux size lookup', async () => {
  const ws = new FakeSocket();
  const terminal = fakeTerminal();
  let sizeLookups = 0;
  await handleTerminalConnection(ws, 'desktop', { width: 120, height: 36 }, dependencies({
    getSessionSize: async () => { sizeLookups += 1; return { width: 80, height: 24 }; },
    createTerminal: () => terminal,
  }));

  assert.equal(sizeLookups, 0);
  assert.deepEqual(terminal.sizes, [[120, 36]]);
});

test('a client without a viewport still attaches at the current tmux size', async () => {
  const ws = new FakeSocket();
  const terminal = fakeTerminal();
  await handleTerminalConnection(ws, 'legacy', null, dependencies({
    getSessionSize: async () => ({ width: 92, height: 28 }),
    createTerminal: () => terminal,
  }));

  assert.deepEqual(terminal.sizes, [[92, 28]]);
});
