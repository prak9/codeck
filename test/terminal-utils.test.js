import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bindTerminalRenderWatchdog,
  clampTerminalGrid,
  createTerminalRevealGate,
  createTerminalResizeGate,
  createTerminalWriteQueue,
  fitTerminalGrid,
  isTerminalCopyShortcut,
  resetTerminalInput,
} from '../public/terminal-utils.js';

function sizingHarness(width, height) {
  const sizes = [];
  const terminal = {
    cols: 80,
    rows: 24,
    options: { fontSize: 16 },
    resize(cols, rows) {
      this.cols = cols;
      this.rows = rows;
      sizes.push([cols, rows]);
    },
  };
  const fit = {
    fit() {
      terminal.resize(
        Math.max(2, Math.floor(width / (terminal.options.fontSize * 0.6))),
        Math.max(1, Math.floor(height / (terminal.options.fontSize * 1.2))),
      );
    },
  };
  return { fit, sizes, terminal };
}

test('terminal grid uses the same usable floor in the browser and server', () => {
  assert.deepEqual(clampTerminalGrid(48, 1), { cols: 48, rows: 6 });
  assert.deepEqual(clampTerminalGrid(4, 30), { cols: 20, rows: 30 });
  assert.deepEqual(clampTerminalGrid(100, 40), { cols: 100, rows: 40 });
});

test('terminal reset is ordered inside the xterm input queue', async () => {
  let finishWrite;
  const writes = [];
  let clears = 0;
  const terminal = {
    write(data, callback) {
      writes.push(data);
      finishWrite = callback;
    },
    clear() { clears += 1; },
  };

  let finished = false;
  const reset = resetTerminalInput(terminal).then(() => { finished = true; });
  await Promise.resolve();
  assert.deepEqual(writes, ['\x1bc']);
  assert.equal(finished, false, 'the reset waits behind already queued output');
  assert.equal(clears, 0);

  finishWrite();
  await reset;
  assert.equal(finished, true);
  assert.equal(clears, 1, 'old scrollback is cleared before the reset completes');
});

test('terminal reveal waits for a quiet parsed frame without delaying terminal writes', () => {
  const scheduled = [];
  let reveals = 0;
  const schedule = (callback, delay) => {
    const task = { callback, delay, cancelled: false };
    scheduled.push(task);
    return task;
  };
  const cancel = (task) => { task.cancelled = true; };
  const gate = createTerminalRevealGate(() => { reveals += 1; }, { schedule, cancel });

  gate.parsed();
  gate.parsed();
  const [staleSettle, maxWait, latestSettle] = scheduled;
  assert.equal(staleSettle.delay, 80);
  assert.equal(staleSettle.cancelled, true);
  assert.equal(maxWait.delay, 240);
  assert.equal(latestSettle.delay, 80);

  staleSettle.callback();
  assert.equal(reveals, 0, 'a superseded frame cannot reveal a partial screen');
  latestSettle.callback();
  assert.equal(reveals, 1);
  assert.equal(maxWait.cancelled, true);
  maxWait.callback();
  assert.equal(reveals, 1, 'the maximum wait cannot reveal the same screen twice');

  const cancelledTasks = [];
  const cancelledGate = createTerminalRevealGate(() => { reveals += 1; }, {
    schedule(callback) {
      const task = { callback, cancelled: false };
      cancelledTasks.push(task);
      return task;
    },
    cancel(task) { task.cancelled = true; },
  });
  cancelledGate.parsed();
  cancelledGate.cancel();
  cancelledTasks.forEach((task) => task.callback());
  assert.equal(reveals, 1, 'a superseded session cannot reveal after cancellation');
});

test('terminal writes keep one parser chunk in flight and drop superseded session frames', () => {
  const writes = [];
  const completions = [];
  const terminal = {
    write(data, callback) {
      writes.push(data);
      completions.push(callback);
    },
  };
  let oldCallbacks = 0;
  const oldSession = createTerminalWriteQueue(terminal);
  oldSession.write('old-1', () => { oldCallbacks += 1; });
  oldSession.write('old-2', () => { oldCallbacks += 1; });
  oldSession.write('old-3', () => { oldCallbacks += 1; });

  assert.deepEqual(writes, ['old-1']);
  oldSession.cancel();
  completions.shift()();
  assert.deepEqual(writes, ['old-1']);
  assert.equal(oldCallbacks, 0);

  const nextSession = createTerminalWriteQueue(terminal);
  nextSession.write('\x1bc');
  nextSession.write('new-1');
  assert.deepEqual(writes, ['old-1', '\x1bc']);
  completions.shift()();
  assert.deepEqual(writes, ['old-1', '\x1bc', 'new-1']);
});

test('terminal writes coalesce a burst waiting behind the parser', () => {
  const writes = [];
  const completions = [];
  const callbacks = [];
  const terminal = {
    write(data, callback) {
      writes.push(data);
      completions.push(callback);
    },
  };
  const queue = createTerminalWriteQueue(terminal);
  queue.write('frame-1', () => callbacks.push(1));
  queue.write('frame-2', () => callbacks.push(2));
  queue.write('frame-3', () => callbacks.push(3));

  assert.deepEqual(writes, ['frame-1']);
  completions.shift()();
  assert.deepEqual(writes, ['frame-1', 'frame-2frame-3']);
  assert.deepEqual(callbacks, [1]);
  completions.shift()();
  assert.deepEqual(callbacks, [1, 2, 3]);
});

test('terminal render watchdog debounces parser bursts and forces at most one redraw per outage', () => {
  const scheduled = [];
  const refreshes = [];
  let onParsed;
  let onRender;
  const terminal = {
    rows: 24,
    onWriteParsed(listener) { onParsed = listener; return { dispose() {} }; },
    onRender(listener) { onRender = listener; return { dispose() {} }; },
    refresh(start, end) { refreshes.push([start, end]); },
  };
  const schedule = (callback, delay) => {
    const task = { callback, delay, cancelled: false };
    scheduled.push(task);
    return task;
  };
  const cancel = (task) => { task.cancelled = true; };
  bindTerminalRenderWatchdog(terminal, {
    schedule, cancel, settleMs: 120, maxWaitMs: 500,
  });

  onParsed();
  onParsed();
  assert.equal(scheduled.length, 3, 'a burst keeps one max deadline and replaces its settle deadline');
  assert.equal(scheduled[0].delay, 120);
  assert.equal(scheduled[0].cancelled, true);
  assert.equal(scheduled[1].delay, 500);
  assert.equal(scheduled[2].delay, 120);
  scheduled[1].callback();
  assert.deepEqual(refreshes, [[0, 23]], 'stale parsed output gets one full viewport redraw');

  onParsed();
  assert.equal(scheduled.length, 3, 'more parser events cannot repeatedly flash before a real render');

  onRender();
  onParsed();
  const healthySettle = scheduled.at(-2);
  const healthyMax = scheduled.at(-1);
  onRender();
  assert.equal(healthySettle.cancelled, true);
  assert.equal(healthyMax.cancelled, true);
  healthySettle.callback();
  healthyMax.callback();
  assert.deepEqual(refreshes, [[0, 23]], 'a normal xterm render needs no duplicate redraw');
});

test('terminal resize gate sends only changed grids and can mark an attach size as synchronized', () => {
  const sent = [];
  const gate = createTerminalResizeGate((cols, rows) => sent.push([cols, rows]));

  gate.mark(120, 36);
  assert.equal(gate.send(120, 36), false);
  assert.equal(gate.send(121, 36), true);
  assert.equal(gate.send(121, 36), false);
  assert.equal(gate.send(121, 37), true);
  assert.deepEqual(sent, [[121, 36], [121, 37]]);
});

test('terminal resize gate retries a grid that the transport could not send yet', () => {
  let ready = false;
  const sent = [];
  const gate = createTerminalResizeGate((cols, rows) => {
    if (!ready) return false;
    sent.push([cols, rows]);
    return true;
  });

  assert.equal(gate.send(100, 30), false);
  ready = true;
  assert.equal(gate.send(100, 30), true);
  assert.deepEqual(sent, [[100, 30]]);
});

test('copy shortcuts leave Ctrl+C as SIGINT when the terminal has no selection', () => {
  assert.equal(isTerminalCopyShortcut({ type: 'keydown', key: 'c', ctrlKey: true }, true), true);
  assert.equal(isTerminalCopyShortcut({ type: 'keydown', key: 'C', metaKey: true }, true), true);
  assert.equal(isTerminalCopyShortcut({ type: 'keydown', key: 'c', ctrlKey: true }, false), false);
  assert.equal(isTerminalCopyShortcut({ type: 'keyup', key: 'c', ctrlKey: true }, true), false);
  assert.equal(isTerminalCopyShortcut({ type: 'keydown', key: 'v', ctrlKey: true }, true), false);
});

test('a short readable viewport adds rows without exploding its column count', () => {
  const harness = sizingHarness(460, 18);
  const result = fitTerminalGrid(harness.terminal, harness.fit, { baseFontSize: 16 });
  assert.deepEqual(result, { cols: 47, rows: 6, overview: false });
  assert.deepEqual(harness.sizes.at(-1), [47, 6]);
});

test('an overview that cannot fit falls back to the readable grid', () => {
  const harness = sizingHarness(460, 18);
  const result = fitTerminalGrid(harness.terminal, harness.fit, {
    baseFontSize: 16,
    overviewSize: { cols: 180, rows: 40 },
  });
  assert.deepEqual(result, { cols: 47, rows: 6, overview: false });
  assert.deepEqual(harness.sizes.at(-1), [47, 6]);
});

test('an overview that fits keeps the requested grid exactly', () => {
  const harness = sizingHarness(460, 64);
  const result = fitTerminalGrid(harness.terminal, harness.fit, {
    baseFontSize: 16,
    overviewSize: { cols: 80, rows: 20 },
  });
  assert.deepEqual(result, { cols: 80, rows: 20, overview: true });
  assert.deepEqual(harness.sizes.at(-1), [80, 20]);
});
