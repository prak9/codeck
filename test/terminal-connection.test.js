import { EventEmitter } from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTerminalOutputBatcher,
  handleTerminalConnection,
  terminalAttachArgs,
} from '../src/terminal-connection.js';

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

const waitForTerminalOutput = () => new Promise((resolve) => setTimeout(resolve, 12));
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));
const inputResults = (ws) => ws.sent.filter(Buffer.isBuffer).map((data) => JSON.parse(data.toString()));
const sendFrame = (ws, message) => ws.emit('message', Buffer.from(JSON.stringify(message)), false);

test('whole terminal submissions leave copy mode without changing raw key semantics', async () => {
  const ws = new FakeSocket();
  const terminal = fakeTerminal();
  const submissions = [];
  let finish;
  await handleTerminalConnection(ws, 'work', { width: 80, height: 24 }, dependencies({
    createTerminal: () => terminal,
    submitTerminalInput: async (session, data, { isCurrent }) => {
      assert.equal(isCurrent(), true);
      submissions.push({ session, data });
      await new Promise((resolve) => { finish = resolve; });
    },
  }));
  sendFrame(ws, { type: 'input', data: 'echo 完整\r', submit: true, inputId: '1:1' });
  await nextTurn();
  sendFrame(ws, { type: 'input', data: '\r' });
  assert.deepEqual(submissions, [{ session: 'work', data: 'echo 完整\r' }]);
  assert.deepEqual(terminal.writes, [], 'later raw Enter cannot overtake the complete submission');
  assert.deepEqual(inputResults(ws), [], 'a draft is not acknowledged before tmux accepts it');
  finish();
  await nextTurn();
  assert.deepEqual(terminal.writes, ['\r'], 'raw keys retain their exact bytes');
  assert.deepEqual(inputResults(ws), [{ type: 'inputResult', inputId: '1:1', ok: true }]);
});

test('submission failure is acknowledged and does not block later raw input', async () => {
  const ws = new FakeSocket();
  const terminal = fakeTerminal();
  await handleTerminalConnection(ws, 'work', { width: 80, height: 24 }, dependencies({
    createTerminal: () => terminal,
    submitTerminalInput: async () => { throw new Error('pane changed'); },
  }));
  sendFrame(ws, { type: 'input', data: 'keep draft\r', submit: true, inputId: '1:2' });
  sendFrame(ws, { type: 'input', data: '\x1b' });
  await nextTurn();
  assert.deepEqual(terminal.writes, ['\x1b']);
  assert.deepEqual(inputResults(ws), [{ type: 'inputResult', inputId: '1:2', ok: false, error: 'pane changed' }]);
});

test('read-only and oversized submissions fail without touching tmux', async () => {
  for (const [readOnly, data, inputId] of [[true, 'id\r', 'readonly'], [false, 'x'.repeat(100_002), 'large']]) {
    const ws = new FakeSocket();
    const terminal = fakeTerminal();
    let submitted = 0;
    await handleTerminalConnection(ws, 'work', { width: 80, height: 24 }, dependencies({
      readOnly,
      createTerminal: () => terminal,
      submitTerminalInput: async () => { submitted += 1; },
    }));
    sendFrame(ws, { type: 'input', data, submit: true, inputId });
    await nextTurn();
    assert.equal(submitted, 0);
    assert.deepEqual(terminal.writes, []);
    assert.equal(inputResults(ws)[0]?.ok, false);
    assert.equal(inputResults(ws)[0]?.inputId, inputId);
  }
});

test('legacy submissions without input ids receive no binary control frames', async () => {
  const ws = new FakeSocket();
  const terminal = fakeTerminal();
  const submissions = [];
  await handleTerminalConnection(ws, 'work', { width: 80, height: 24 }, dependencies({
    createTerminal: () => terminal,
    submitTerminalInput: async (_session, data) => { submissions.push(data); },
  }));
  sendFrame(ws, { type: 'input', data: 'legacy\r', submit: true });
  await nextTurn();
  assert.deepEqual(submissions, ['legacy\r']);
  assert.deepEqual(ws.sent, []);
});

test('submission permits a maximum-sized draft plus Enter but rejects oversized receipt ids', async () => {
  const ws = new FakeSocket();
  const submissions = [];
  await handleTerminalConnection(ws, 'work', { width: 80, height: 24 }, dependencies({
    submitTerminalInput: async (_session, data) => { submissions.push(data); },
  }));
  const data = `${'x'.repeat(100_000)}\r`;
  sendFrame(ws, { type: 'input', data, submit: true, inputId: 'maximum' });
  await nextTurn();
  assert.deepEqual(submissions, [data]);
  assert.equal(inputResults(ws)[0]?.ok, true);
  sendFrame(ws, { type: 'input', data: 'never sent\r', submit: true, inputId: 'x'.repeat(129) });
  await nextTurn();
  assert.equal(ws.closes[0]?.code, 1008);
  assert.equal(submissions.length, 1);
});

test('closing a socket cancels an in-flight submission and never drains its later input', async () => {
  const ws = new FakeSocket();
  const terminal = fakeTerminal();
  let finish;
  let delivered = false;
  await handleTerminalConnection(ws, 'work', { width: 80, height: 24 }, dependencies({
    createTerminal: () => terminal,
    submitTerminalInput: async (_session, _data, { isCurrent }) => {
      await new Promise((resolve) => { finish = resolve; });
      if (!isCurrent()) throw new Error('closed');
      delivered = true;
    },
  }));
  sendFrame(ws, { type: 'input', data: 'old connection\r', submit: true, inputId: 'close' });
  await nextTurn();
  sendFrame(ws, { type: 'input', data: 'queued raw' });
  ws.close(1000, 'browser left');
  finish();
  await nextTurn();
  assert.equal(delivered, false);
  assert.deepEqual(terminal.writes, []);
  assert.deepEqual(ws.sent, []);
});

test('a submission waits for earlier scroll commands before leaving copy mode', async () => {
  const ws = new FakeSocket();
  const events = [];
  let finishScroll;
  await handleTerminalConnection(ws, 'work', { width: 80, height: 24 }, dependencies({
    scrollSession: async () => {
      events.push('scroll');
      await new Promise((resolve) => { finishScroll = resolve; });
    },
    submitTerminalInput: async () => { events.push('submit'); },
  }));
  sendFrame(ws, { type: 'scroll', lines: 3 });
  sendFrame(ws, { type: 'input', data: 'pwd\r', submit: true, inputId: '2:1' });
  await nextTurn();
  assert.deepEqual(events, ['scroll']);
  finishScroll();
  await nextTurn();
  assert.deepEqual(events, ['scroll', 'submit']);
  assert.equal(inputResults(ws)[0]?.ok, true);
});

test('switch cancels pending submissions instead of sending them into another session', async () => {
  const ws = new FakeSocket();
  const created = [];
  const delivered = [];
  let finish;
  await handleTerminalConnection(ws, 'first', { width: 80, height: 24 }, dependencies({
    canSwitchSession: true,
    createTerminal: (session) => { const terminal = fakeTerminal(); created.push({ session, terminal }); return terminal; },
    submitTerminalInput: async (session, data, { isCurrent }) => {
      await new Promise((resolve) => { finish = resolve; });
      if (!isCurrent()) throw new Error('session changed');
      delivered.push({ session, data });
    },
  }));
  sendFrame(ws, { type: 'input', data: 'first\r', submit: true, inputId: '3:1' });
  await nextTurn();
  sendFrame(ws, { type: 'input', data: 'queued\r', submit: true, inputId: '3:2' });
  sendFrame(ws, { type: 'switch', session: 'second', cols: 80, rows: 24 });
  sendFrame(ws, { type: 'input', data: 'second raw' });
  await nextTurn();
  finish();
  await nextTurn();
  assert.deepEqual(delivered, []);
  assert.deepEqual(created[1].terminal.writes, ['second raw']);
  assert.deepEqual(inputResults(ws).map(({ inputId, ok }) => ({ inputId, ok })).sort((a, b) => a.inputId.localeCompare(b.inputId)), [
    { inputId: '3:1', ok: false }, { inputId: '3:2', ok: false },
  ]);
});

test('submissions queued during setup or flow recovery are delivered exactly once', async () => {
  const ws = new FakeSocket();
  const created = [];
  const submitted = [];
  let releaseLinks;
  const setup = handleTerminalConnection(ws, 'work', { width: 80, height: 24 }, dependencies({
    outputFlowControl: true, outputFlowId: '1', outputHighWaterMark: 5,
    getLinkedWindowSessions: () => created.length ? Promise.resolve([]) : new Promise((resolve) => { releaseLinks = resolve; }),
    createTerminal: () => { const terminal = fakeTerminal(); created.push(terminal); return terminal; },
    submitTerminalInput: async (_session, data) => { submitted.push(data); },
  }));
  sendFrame(ws, { type: 'input', data: 'setup\r', submit: true, inputId: '4:1' });
  releaseLinks([]);
  await setup;
  await nextTurn();
  created[0].dataCallback('123456');
  await waitForTerminalOutput();
  sendFrame(ws, { type: 'input', data: 'recovery\r', submit: true, inputId: '4:2' });
  sendFrame(ws, { type: 'outputAck', flowId: '1', chars: 6 });
  await nextTurn();
  assert.deepEqual(submitted, ['setup\r', 'recovery\r']);
  assert.deepEqual(inputResults(ws).map(({ inputId, ok }) => ({ inputId, ok })), [
    { inputId: '4:1', ok: true }, { inputId: '4:2', ok: true },
  ]);
});

test('read-only clients attach without detaching the session owner', () => {
  assert.deepEqual(terminalAttachArgs('shared', { readOnly: true }), ['attach-session', '-r', '-t', 'shared']);
  assert.deepEqual(terminalAttachArgs('owner'), ['attach-session', '-d', '-t', 'owner']);
  assert.deepEqual(terminalAttachArgs('collaborator', { detachOtherClients: false }), ['attach-session', '-t', 'collaborator']);
});

test('terminal output batches adjacent pty fragments into one repaint', () => {
  const scheduled = [];
  const sent = [];
  const batcher = createTerminalOutputBatcher((data) => sent.push(data), {
    schedule: (callback, delay) => {
      const task = { callback, delay, cancelled: false };
      scheduled.push(task);
      return task;
    },
    cancel: (task) => { task.cancelled = true; },
  });

  batcher.write('frame-a');
  batcher.write('frame-b');
  assert.deepEqual(sent, [], 'a split terminal frame is not exposed half-drawn');
  assert.equal(scheduled.length, 3);
  assert.equal(scheduled[0].delay, 2);
  assert.equal(scheduled[0].cancelled, true, 'the second fragment extends the quiet deadline');
  assert.equal(scheduled[1].delay, 8, 'continuous output cannot hold an interactive repaint for a full display frame');
  assert.equal(scheduled[2].delay, 2);
  scheduled[2].callback();
  assert.deepEqual(sent, ['frame-aframe-b']);
  assert.equal(scheduled[1].cancelled, true);
});

test('terminal output discards an old pending batch when the session changes', () => {
  const scheduled = [];
  const sent = [];
  const batcher = createTerminalOutputBatcher((data) => sent.push(data), {
    schedule: (callback) => {
      const task = { callback, cancelled: false };
      scheduled.push(task);
      return task;
    },
    cancel: (task) => { task.cancelled = true; },
  });

  batcher.write('stale half-frame');
  batcher.cancel();
  scheduled.forEach((task) => task.callback());
  assert.deepEqual(sent, []);
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

  assert.deepEqual(terminal.sizes, [], 'modern tmux receives the exact pty size at spawn');
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
  await waitForTerminalOutput();

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

test('a natural terminal exit flushes its final batch before closing the socket', async () => {
  for (const outputFlowControl of [false, true]) {
    const ws = new FakeSocket();
    const terminal = fakeTerminal();
    let sentAtClose;
    ws.on('close', () => { sentAtClose = [...ws.sent]; });
    await handleTerminalConnection(ws, 'shared', { width: 80, height: 24 }, dependencies({
      outputFlowControl,
      outputFlowId: '1',
      outputHighWaterMark: 5,
      createTerminal: () => terminal,
    }));

    terminal.dataCallback('final ');
    terminal.dataCallback('output');
    terminal.exitCallback({ exitCode: 0 });

    assert.deepEqual(sentAtClose, ['final output']);
    assert.deepEqual(ws.closes, [{ code: 1000, reason: 'terminal exited (0)' }]);
    await waitForTerminalOutput();
    assert.deepEqual(ws.sent, ['final output'], 'cancelled timers cannot duplicate the flushed batch');
  }
});

test('a closed socket discards pending terminal output instead of flushing it', async () => {
  const ws = new FakeSocket();
  const terminal = fakeTerminal();
  await handleTerminalConnection(ws, 'shared', { width: 80, height: 24 }, dependencies({
    createTerminal: () => terminal,
  }));

  terminal.dataCallback('stale final output');
  ws.close(1000, 'browser left');
  terminal.exitCallback({ exitCode: 0 });
  await waitForTerminalOutput();

  assert.deepEqual(ws.sent, []);
  assert.deepEqual(ws.closes, [{ code: 1000, reason: 'browser left' }]);
});

test('a slow browser bounds stale output and reattaches at the current tmux screen', async () => {
  const ws = new FakeSocket();
  const created = [];
  await handleTerminalConnection(ws, 'shared', { width: 80, height: 24 }, dependencies({
    outputFlowControl: true,
    outputFlowId: '1',
    outputHighWaterMark: 5,
    createTerminal: (session, size) => {
      const terminal = fakeTerminal();
      created.push({ session, size, terminal });
      return terminal;
    },
  }));

  created[0].terminal.dataCallback('123456');
  await waitForTerminalOutput();
  assert.equal(created[0].terminal.killed, true, 'the stale attach stops producing an unbounded backlog');
  assert.deepEqual(ws.sent, ['123456']);

  ws.emit('message', Buffer.from(JSON.stringify({ type: 'input', data: 'kept input' })), false);
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'outputAck', flowId: 'stale', chars: 6 })), false);
  await Promise.resolve();
  assert.equal(created.length, 1, 'an acknowledgement from another screen cannot release this stream');

  ws.emit('message', Buffer.from(JSON.stringify({ type: 'outputAck', flowId: '1', chars: 6 })), false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(created.map(({ session, size }) => ({ session, size })), [
    { session: 'shared', size: { width: 80, height: 24 } },
    { session: 'shared', size: { width: 80, height: 24 } },
  ]);
  assert.deepEqual(ws.sent, ['123456', '\x1bc'], 'the replacement attach starts at an explicit screen reset');
  assert.deepEqual(created[1].terminal.writes, ['kept input'], 'input received during recovery is delivered once');
});

test('flow recovery retains the latest resize including one queued during recovery', async () => {
  const ws = new FakeSocket();
  const created = [];
  await handleTerminalConnection(ws, 'shared', { width: 80, height: 24 }, dependencies({
    outputFlowControl: true,
    outputFlowId: '1',
    outputHighWaterMark: 5,
    createTerminal: (_session, size) => {
      const terminal = fakeTerminal();
      created.push({ size, terminal });
      return terminal;
    },
  }));

  ws.emit('message', Buffer.from(JSON.stringify({ type: 'resize', cols: 120, rows: 40 })), false);
  created[0].terminal.dataCallback('123456');
  await waitForTerminalOutput();
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'input', data: 'queued input' })), false);
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'resize', cols: 132, rows: 44 })), false);
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'outputAck', flowId: '1', chars: 6 })), false);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(created[1].size, { width: 120, height: 40 });
  assert.deepEqual(created[1].terminal.sizes, [[132, 44]]);
  assert.deepEqual(created[1].terminal.writes, ['queued input']);

  created[1].terminal.dataCallback('123456');
  await waitForTerminalOutput();
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'outputAck', flowId: '1', chars: 8 })), false);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(created[2].size, { width: 132, height: 44 });
  assert.deepEqual(created[2].terminal.writes, [], 'recovery does not replay input from an earlier attach');
  ws.close(1000, 'done');
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

  created[0].terminal.dataCallback('stale pending output');
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'switch', session: 'second', cols: 120, rows: 36 })), false);
  await waitForTerminalOutput();

  assert.equal(created[0].terminal.killed, true);
  assert.deepEqual(created.map(({ session, size }) => ({ session, size })), [
    { session: 'first', size: { width: 80, height: 24 } },
    { session: 'second', size: { width: 120, height: 36 } },
  ]);
  assert.deepEqual(ws.sent, ['\x1bc']);
  created[0].terminal.dataCallback('stale output');
  created[0].terminal.exitCallback({ exitCode: 0 });
  created[1].terminal.dataCallback('current output');
  await waitForTerminalOutput();
  assert.deepEqual(ws.sent, ['\x1bc', 'current output']);
  assert.deepEqual(ws.closes, []);
});

test('a session switch forwards terminal protocol queries within the bounded output batch', async () => {
  const ws = new FakeSocket();
  const created = [];
  await handleTerminalConnection(ws, 'first', { width: 80, height: 24 }, dependencies({
    canSwitchSession: true,
    createTerminal: (session) => {
      const terminal = fakeTerminal();
      created.push({ session, terminal });
      return terminal;
    },
  }));

  ws.emit('message', Buffer.from(JSON.stringify({
    type: 'switch', session: 'second', cols: 120, rows: 36,
  })), false);
  await waitForTerminalOutput();
  created[1].terminal.dataCallback('\x1b[>c');
  await waitForTerminalOutput();

  assert.deepEqual(ws.sent, ['\x1bc', '\x1b[>c']);
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
  assert.deepEqual(terminal.sizes, []);
});

test('a legacy tmux server still receives one explicit initial resize', async () => {
  const ws = new FakeSocket();
  const terminal = fakeTerminal();
  await handleTerminalConnection(ws, 'legacy', { width: 92, height: 28 }, dependencies({
    preferLatestClientSize: async () => false,
    createTerminal: () => terminal,
  }));

  assert.deepEqual(terminal.sizes, [[92, 28]]);
});

test('terminal resize messages are ignored until the browser grid changes', async () => {
  const ws = new FakeSocket();
  const terminal = fakeTerminal();
  await handleTerminalConnection(ws, 'desktop', { width: 120, height: 36 }, dependencies({
    createTerminal: () => terminal,
  }));

  ws.emit('message', Buffer.from(JSON.stringify({ type: 'resize', cols: 120, rows: 36 })), false);
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'resize', cols: 121, rows: 36 })), false);
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'resize', cols: 121, rows: 36 })), false);
  assert.deepEqual(terminal.sizes, [[121, 36]]);
});

test('a client without a viewport still attaches at the current tmux size', async () => {
  const ws = new FakeSocket();
  const terminal = fakeTerminal();
  await handleTerminalConnection(ws, 'legacy', null, dependencies({
    getSessionSize: async () => ({ width: 92, height: 28 }),
    createTerminal: () => terminal,
  }));

  assert.deepEqual(terminal.sizes, []);
});
