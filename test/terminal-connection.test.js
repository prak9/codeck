import { EventEmitter } from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleTerminalConnection, terminalAttachArgs } from '../src/terminal-connection.js';

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
    terminalOutputSettleMs: 0,
    getSessionSize: async () => ({ width: 80, height: 24 }),
    getLinkedWindowSessions: async () => [],
    preferLatestClientSize: async () => true,
    clampViewport: (cols, rows) => [Math.max(20, cols), Math.max(6, rows)],
    scrollSession: async () => {},
    createTerminal: () => fakeTerminal(),
    ...overrides,
  };
}

test('read-only clients attach without detaching the session owner', () => {
  assert.deepEqual(terminalAttachArgs('shared', { readOnly: true }), ['attach-session', '-r', '-t', 'shared']);
  assert.deepEqual(terminalAttachArgs('owner'), ['attach-session', '-d', '-t', 'owner']);
  assert.deepEqual(terminalAttachArgs('collaborator', { detachOtherClients: false }), ['attach-session', '-t', 'collaborator']);
});

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

test('a read-only terminal never forwards client input to tmux', async () => {
  const ws = new FakeSocket();
  const terminal = fakeTerminal();
  let releaseLinks;
  let terminalOptions;
  const setup = handleTerminalConnection(ws, 'shared', { width: 80, height: 24 }, dependencies({
    readOnly: true,
    getLinkedWindowSessions: () => new Promise((resolve) => { releaseLinks = resolve; }),
    createTerminal: (_session, _size, options) => { terminalOptions = options; return terminal; },
  }));
  await Promise.resolve();
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'input', data: 'sudo id\r' })), false);
  releaseLinks([]);
  await setup;
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'input', data: 'whoami\r' })), false);
  terminal.dataCallback('visible output');

  assert.deepEqual(terminal.writes, []);
  assert.deepEqual(terminalOptions, { readOnly: true });
  assert.deepEqual(ws.sent, ['visible output']);
});

test('a writable collaborator forwards input without detaching another tmux client', async () => {
  const ws = new FakeSocket();
  const terminal = fakeTerminal();
  let terminalOptions;
  await handleTerminalConnection(ws, 'shared', { width: 80, height: 24 }, dependencies({
    readOnly: false,
    detachOtherClients: false,
    createTerminal: (_session, _size, options) => { terminalOptions = options; return terminal; },
  }));
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'input', data: '继续\r' })), false);

  assert.deepEqual(terminal.writes, ['继续\r']);
  assert.deepEqual(terminalOptions, { readOnly: false, detachOtherClients: false });
});

test('a submitted terminal prompt wakes session detection once when output begins', async () => {
  const ws = new FakeSocket();
  const terminal = fakeTerminal();
  const activity = [];
  await handleTerminalConnection(ws, 'shared', { width: 80, height: 24 }, dependencies({
    createTerminal: () => terminal,
    onSessionActivity: (session) => activity.push(session),
  }));

  ws.emit('message', Buffer.from(JSON.stringify({ type: 'input', data: '继续\r' })), false);
  terminal.dataCallback('spinner');
  terminal.dataCallback('more output');
  assert.deepEqual(activity, ['shared']);

  ws.emit('message', Buffer.from(JSON.stringify({ type: 'input', data: '再检查\r' })), false);
  terminal.dataCallback('next spinner');
  assert.deepEqual(activity, ['shared', 'shared']);
});

test('an owner can switch the attached tmux session without replacing the socket', async () => {
  const ws = new FakeSocket();
  const created = [];
  await handleTerminalConnection(ws, 'first', { width: 80, height: 24 }, dependencies({
    canSwitchSession: true,
    createTerminal: (session, size) => {
      const terminal = fakeTerminal();
      created.push({ session, size, terminal });
      return terminal;
    },
  }));

  ws.emit('message', Buffer.from(JSON.stringify({ type: 'switch', session: 'second', cols: 120, rows: 36 })), false);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(created[0].terminal.killed, true);
  assert.deepEqual(created.map(({ session, size }) => ({ session, size })), [
    { session: 'first', size: { width: 80, height: 24 } },
    { session: 'second', size: { width: 120, height: 36 } },
  ]);
  assert.deepEqual(ws.sent, ['\x1bc']);
  created[0].terminal.dataCallback('stale output');
  created[0].terminal.exitCallback({ exitCode: 0 });
  created[1].terminal.dataCallback('current output');
  assert.deepEqual(ws.sent, ['\x1bc', 'current output']);
  assert.deepEqual(ws.closes, []);
});

test('a session switch settles the initial tmux redraw into one terminal frame', async () => {
  const ws = new FakeSocket();
  const created = [];
  const timers = [];
  const setTerminalOutputTimeout = (callback, delay) => {
    const timer = { callback, delay, cancelled: false };
    timers.push(timer);
    return timer;
  };
  const clearTerminalOutputTimeout = (timer) => { timer.cancelled = true; };
  await handleTerminalConnection(ws, 'first', { width: 80, height: 24 }, dependencies({
    canSwitchSession: true,
    terminalOutputSettleMs: 60,
    terminalOutputMaxWaitMs: 240,
    setTerminalOutputTimeout,
    clearTerminalOutputTimeout,
    createTerminal: (session) => {
      const terminal = fakeTerminal();
      created.push({ session, terminal });
      return terminal;
    },
  }));

  ws.emit('message', Buffer.from(JSON.stringify({
    type: 'switch', session: 'second', cols: 120, rows: 36,
  })), false);
  await new Promise((resolve) => setImmediate(resolve));
  created[1].terminal.dataCallback('first redraw');
  created[1].terminal.dataCallback(' + final redraw');

  assert.deepEqual(ws.sent, []);
  const settleTimer = timers.findLast((timer) => timer.delay === 60 && !timer.cancelled);
  assert.ok(settleTimer, 'the latest redraw schedules a quiet-period flush');
  settleTimer.callback();
  assert.deepEqual(ws.sent, ['\x1bcfirst redraw + final redraw']);

  created[1].terminal.dataCallback('live output');
  assert.deepEqual(ws.sent, ['\x1bcfirst redraw + final redraw', 'live output']);
});

test('a rapid owner switch discards pending input and setup from the superseded session', async () => {
  const ws = new FakeSocket();
  const created = [];
  const links = new Map();
  await handleTerminalConnection(ws, 'first', { width: 80, height: 24 }, dependencies({
    canSwitchSession: true,
    getLinkedWindowSessions: (session) => {
      if (session === 'first') return Promise.resolve([]);
      return new Promise((resolve) => links.set(session, resolve));
    },
    createTerminal: (session) => {
      const terminal = fakeTerminal();
      created.push({ session, terminal });
      return terminal;
    },
  }));

  ws.emit('message', Buffer.from(JSON.stringify({ type: 'switch', session: 'second', cols: 100, rows: 30 })), false);
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'input', data: 'wrong target' })), false);
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'switch', session: 'third', cols: 120, rows: 36 })), false);
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'input', data: 'right target' })), false);
  links.get('second')([]);
  links.get('third')([]);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(created.map(({ session }) => session), ['first', 'third']);
  assert.deepEqual(created[1].terminal.writes, ['right target']);
});

test('a session-scoped share socket cannot switch to another tmux session', async () => {
  const ws = new FakeSocket();
  await handleTerminalConnection(ws, 'shared', { width: 80, height: 24 }, dependencies());

  ws.emit('message', Buffer.from(JSON.stringify({ type: 'switch', session: 'private', cols: 120, rows: 36 })), false);

  assert.equal(ws.closes[0]?.code, 1008);
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
