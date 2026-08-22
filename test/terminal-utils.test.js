import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clampTerminalGrid,
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
  const terminal = {
    write(data, callback) {
      writes.push(data);
      finishWrite = callback;
    },
  };

  let finished = false;
  const reset = resetTerminalInput(terminal).then(() => { finished = true; });
  await Promise.resolve();
  assert.deepEqual(writes, ['\x1bc']);
  assert.equal(finished, false, 'the reset waits behind already queued output');

  finishWrite();
  await reset;
  assert.equal(finished, true);
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
