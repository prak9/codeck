import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activateTerminalWebgl,
  bindTerminalRenderWatchdog,
  clampTerminalGrid,
  createTerminalRevealGate,
  createTerminalResizeGate,
  createTerminalOutputAcknowledger,
  createTerminalWriteQueue,
  createTerminalWheelScroller,
  fitTerminalGrid,
  isTerminalCopyShortcut,
  resetTerminalInput,
  wheelScrollLines,
} from '../public/terminal-utils.js';

test('terminal WebGL acceleration activates and disposes cleanly on context loss', () => {
  let contextLost;
  let disposed = 0;
  let loaded;
  class FakeWebglAddon {
    onContextLoss(callback) { contextLost = callback; }
    dispose() { disposed += 1; }
  }
  const terminal = { loadAddon: (addon) => { loaded = addon; } };

  assert.equal(activateTerminalWebgl(terminal, FakeWebglAddon), true);
  assert.ok(loaded instanceof FakeWebglAddon);
  contextLost();
  assert.equal(disposed, 1);
});

test('terminal WebGL acceleration falls back when unavailable or activation fails', () => {
  let disposed = 0;
  class BrokenWebglAddon {
    onContextLoss() {}
    dispose() { disposed += 1; }
  }

  assert.equal(activateTerminalWebgl({ loadAddon() {} }, null), false);
  assert.equal(activateTerminalWebgl({ loadAddon() { throw new Error('WebGL disabled'); } }, BrokenWebglAddon), false);
  assert.equal(disposed, 1);
});

function sizingHarness(width, height) {
  const sizes = [];
  const repaints = [];
  const terminal = {
    cols: 80,
    rows: 24,
    options: { fontSize: 16 },
    resize(cols, rows) {
      this.cols = cols;
      this.rows = rows;
      sizes.push([cols, rows]);
    },
    refresh(start, end) {
      repaints.push([start, end]);
    },
  };
  const fit = {
    proposeDimensions() {
      return {
        cols: Math.max(2, Math.floor(width / (terminal.options.fontSize * 0.6))),
        rows: Math.max(1, Math.floor(height / (terminal.options.fontSize * 1.2))),
      };
    },
    fit() {
      throw new Error('fitTerminalGrid must measure, not resize, while searching');
    },
  };
  return { fit, repaints, sizes, terminal };
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

test('terminal output acknowledgements coalesce parser callbacks and flush large frames immediately', () => {
  const scheduled = [];
  const sent = [];
  const acknowledgements = createTerminalOutputAcknowledger((message) => sent.push(message), '7', {
    immediateChars: 10,
    schedule: (callback, delay) => {
      const task = { callback, delay, cancelled: false };
      scheduled.push(task);
      return task;
    },
    cancel: (task) => { task.cancelled = true; },
  });

  acknowledgements.acknowledge(3);
  acknowledgements.acknowledge(4);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 16);
  scheduled[0].callback();
  assert.deepEqual(sent, [{ type: 'outputAck', flowId: '7', chars: 7 }]);

  acknowledgements.acknowledge(10);
  assert.deepEqual(sent.at(-1), { type: 'outputAck', flowId: '7', chars: 10 });
  acknowledgements.acknowledge(2);
  acknowledgements.cancel();
  scheduled.at(-1).callback();
  assert.equal(sent.length, 2, 'a superseded screen cannot acknowledge its replacement');
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

test('fitting resizes the terminal at most once, whatever the font search costs', () => {
  // 每次 resize 都会让 xterm 重排并重新折行, 而重新折行是有损的: 先变宽再变窄,
  // 原来的断行就找不回来了。搜索字号期间反复 resize, 最后又可能落回服务端已知的
  // 同一个网格 —— 那样不会发出 resize, tmux 不重绘, 损坏就永久留在屏幕上。
  const harness = sizingHarness(460, 18);
  fitTerminalGrid(harness.terminal, harness.fit, { baseFontSize: 16, overviewSize: { cols: 180, rows: 40 } });
  assert.equal(harness.sizes.length, 1, `搜索期间发生了额外的 resize: ${JSON.stringify(harness.sizes)}`);
});

test('a fit that lands on the current grid does not touch the buffer at all', () => {
  const harness = sizingHarness(460, 64);
  harness.terminal.cols = 80;
  harness.terminal.rows = 20;
  fitTerminalGrid(harness.terminal, harness.fit, { baseFontSize: 16, overviewSize: { cols: 80, rows: 20 } });
  assert.deepEqual(harness.sizes, [], '网格没变就不该 resize —— 那正是不重绘却已损坏的来源');
});

test('fitting always repaints, since the font size can change without the grid moving', () => {
  // FitAddon 的 fit() 会在 resize 前清一次渲染缓存; 我们不再走 fit() 就少了那一步。
  // 而全览模式下调整的是字号、网格不动, 那条路径上根本没有 resize 来触发重绘。
  const harness = sizingHarness(460, 64);
  harness.terminal.cols = 80;
  harness.terminal.rows = 20;
  fitTerminalGrid(harness.terminal, harness.fit, { baseFontSize: 16, overviewSize: { cols: 80, rows: 20 } });
  assert.deepEqual(harness.sizes, [], '网格没变就不该 resize');
  assert.deepEqual(harness.repaints, [[0, 19]], '但仍然要重绘, 否则字号变了而屏幕没跟上');
});

test('a terminal without refresh() still fits', () => {
  const harness = sizingHarness(460, 18);
  delete harness.terminal.refresh;
  assert.doesNotThrow(() => fitTerminalGrid(harness.terminal, harness.fit, { baseFontSize: 16 }));
});

test('wheel deltas become tmux scroll amounts, in tmux\'s direction', () => {
  // tmux 那边 lines > 0 表示往历史里翻。滚轮向上 deltaY 为负, 所以要反号。
  assert.equal(wheelScrollLines({ deltaY: -100, deltaMode: 0 }, 20), 5);
  assert.equal(wheelScrollLines({ deltaY: 100, deltaMode: 0 }, 20), -5);
  // deltaMode 1 是行、2 是页。
  assert.equal(wheelScrollLines({ deltaY: -3, deltaMode: 1 }, 20), 3);
  assert.equal(wheelScrollLines({ deltaY: 1, deltaMode: 2 }, 20), -24);
  // 极小的抖动不该产生指令, 否则触控板会刷屏。
  assert.equal(wheelScrollLines({ deltaY: -4, deltaMode: 0 }, 20), 0);
  // 单次手势也要有上限, 一甩不该请求上千行。
  assert.equal(wheelScrollLines({ deltaY: -100000, deltaMode: 0 }, 20), 60);
});

function wheelHarness() {
  const scheduled = [];
  const sent = [];
  const scroller = createTerminalWheelScroller((lines) => sent.push(lines), {
    schedule(callback) {
      const task = { callback, cancelled: false };
      scheduled.push(task);
      return task;
    },
    cancel(task) { task.cancelled = true; },
  });
  return { scroller, sent, scheduled };
}

test('wheel scrolling accumulates small pixel deltas and batches one display frame', () => {
  const { scroller, sent, scheduled } = wheelHarness();
  for (let index = 0; index < 20; index += 1) {
    assert.equal(scroller.scroll({ deltaY: -4, deltaMode: 0 }, 20), true);
  }
  assert.equal(scheduled.length, 1);
  assert.deepEqual(sent, []);
  scheduled[0].callback();
  assert.deepEqual(sent, [4], '80px of continuous movement must scroll four 20px rows');
});

test('wheel scrolling retains line and page units and caps extreme single events', () => {
  const { scroller, sent, scheduled } = wheelHarness();
  scroller.scroll({ deltaY: -3, deltaMode: 1 }, 20, 40);
  scroller.scroll({ deltaY: -1, deltaMode: 2 }, 20, 40);
  scheduled.at(-1).callback();
  assert.deepEqual(sent, [43]);
  scroller.scroll({ deltaY: -100000, deltaMode: 0 }, 20);
  scheduled.at(-1).callback();
  assert.deepEqual(sent, [43, 60]);
});

test('wheel reversal preserves ordered scrolls without carrying the old fractional direction', () => {
  const { scroller, sent, scheduled } = wheelHarness();
  scroller.scroll({ deltaY: 30 }, 20);
  scroller.scroll({ deltaY: -12 }, 20);
  scroller.scroll({ deltaY: -8 }, 20);
  scheduled.at(-1).callback();
  assert.deepEqual(sent, [-1, 1], 'down then up cannot cancel before tmux sees the copy-mode transitions');
});

test('wheel cancellation drops pending frames and partial rows before another session', () => {
  const { scroller, sent, scheduled } = wheelHarness();
  scroller.scroll({ deltaY: -30 }, 20);
  const stale = scheduled[0];
  scroller.cancel();
  assert.equal(stale.cancelled, true);
  stale.callback();
  scroller.scroll({ deltaY: -10 }, 20);
  assert.equal(scheduled.length, 1, 'half of an old session row must not carry to the next session');
  scroller.scroll({ deltaY: -10 }, 20);
  scheduled.at(-1).callback();
  assert.deepEqual(sent, [1]);
});

test('wheel zoom and horizontal gestures stay with the browser', () => {
  const { scroller, sent, scheduled } = wheelHarness();
  for (const event of [
    { deltaY: -100, ctrlKey: true },
    { deltaY: -100, metaKey: true },
    { deltaY: -100, shiftKey: true },
    { deltaY: 0, deltaX: 100 },
    { deltaY: Number.NaN },
    { deltaY: Infinity },
  ]) assert.equal(scroller.scroll(event, 20), false);
  assert.deepEqual(sent, []);
  assert.deepEqual(scheduled, []);
});

test('unchanged explicit fit layout reuses the grid without remeasuring or changing fonts', () => {
  const harness = sizingHarness(390, 600);
  harness.terminal._core = { _renderService: { dimensions: { css: { cell: {
    get width() { return harness.terminal.options.fontSize * 0.6; },
    get height() { return harness.terminal.options.fontSize * 1.2; },
  } } } } };
  const options = { baseFontSize: 16, overviewSize: { cols: 160, rows: 50 }, layout: { width: 390, height: 600, dpr: 1, fontRevision: 0 } };
  const first = fitTerminalGrid(harness.terminal, harness.fit, options);
  const firstFontSize = harness.terminal.options.fontSize;
  harness.fit.proposeDimensions = () => { throw new Error('unchanged layout was measured again'); };
  assert.deepEqual(fitTerminalGrid(harness.terminal, harness.fit, options), first);
  assert.equal(harness.terminal.options.fontSize, firstFontSize);
  assert.equal(harness.repaints.length, 1);
  assert.equal(harness.sizes.length, 1);
});

test('fit cache remeasures changed renderer cells after WebGL falls back to DOM', () => {
  const harness = sizingHarness(1000, 600);
  const cell = { width: 9, height: 21 };
  harness.terminal._core = { _renderService: { dimensions: { css: { cell } } } };
  let measures = 0;
  harness.fit.proposeDimensions = () => {
    measures += 1;
    return { cols: Math.floor(983 / cell.width), rows: Math.floor(600 / cell.height) };
  };
  const options = { baseFontSize: 16, layout: { width: 1000, height: 600, dpr: 1, fontRevision: 0 } };
  assert.deepEqual(fitTerminalGrid(harness.terminal, harness.fit, options), { cols: 109, rows: 28, overview: false });

  // The DOM renderer keeps fractional character widths that WebGL floors.
  cell.width = 9.6055;
  assert.deepEqual(fitTerminalGrid(harness.terminal, harness.fit, options), { cols: 102, rows: 28, overview: false });
  assert.ok(harness.terminal.cols * cell.width <= 1000, 'the fallback grid must stay inside its container');
  fitTerminalGrid(harness.terminal, harness.fit, options);
  assert.equal(measures, 2, 'unchanged fallback metrics can still reuse the cache');
});

test('fit cache invalidates size, scale, loaded fonts, target grid and font settings', () => {
  const changes = [
    (options) => { options.layout.width += 1; },
    (options) => { options.layout.height += 1; },
    (options) => { options.layout.dpr = 2; },
    (options) => { options.layout.fontRevision += 1; },
    (options) => { options.baseFontSize = 18; },
    (options) => { options.overviewSize.cols += 1; },
    (options) => { options.overviewSize.rows += 1; },
    (options, terminal) => { terminal.options.fontFamily = 'different font'; },
    (options, terminal) => { terminal.options.lineHeight = 1.4; },
    (options, terminal) => { terminal.options.letterSpacing = 1; },
    (options, terminal) => { terminal.options.fontSize = 10; },
    (options, terminal) => { terminal.resize(80, 24); },
  ];
  for (const change of changes) {
    const harness = sizingHarness(390, 600);
    const options = { baseFontSize: 16, overviewSize: { cols: 160, rows: 50 }, layout: { width: 390, height: 600, dpr: 1, fontRevision: 0 } };
    fitTerminalGrid(harness.terminal, harness.fit, options);
    const propose = harness.fit.proposeDimensions;
    let measures = 0;
    harness.fit.proposeDimensions = () => { measures += 1; return propose(); };
    change(options, harness.terminal);
    fitTerminalGrid(harness.terminal, harness.fit, options);
    assert.ok(measures > 0, String(change));
    assert.equal(harness.repaints.length, 2, String(change));
  }
});

test('fit cache never reuses unmeasured, hidden, or unspecified layouts', () => {
  for (const layout of [undefined, { width: 0, height: 600, dpr: 1, fontRevision: 0 }]) {
    const harness = sizingHarness(390, 600);
    const options = { baseFontSize: 16, overviewSize: { cols: 160, rows: 50 }, layout };
    fitTerminalGrid(harness.terminal, harness.fit, options);
    fitTerminalGrid(harness.terminal, harness.fit, options);
    assert.equal(harness.repaints.length, 2);
  }
  const harness = sizingHarness(390, 600);
  const options = { baseFontSize: 16, layout: { width: 390, height: 600, dpr: 1, fontRevision: 0 } };
  const propose = harness.fit.proposeDimensions;
  harness.fit.proposeDimensions = () => undefined;
  fitTerminalGrid(harness.terminal, harness.fit, options);
  harness.fit.proposeDimensions = propose;
  fitTerminalGrid(harness.terminal, harness.fit, options);
  assert.equal(harness.repaints.length, 2, 'fallback dimensions before font measurement cannot seed a cache');
});
