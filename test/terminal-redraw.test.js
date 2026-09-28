import test from 'node:test';
import assert from 'node:assert/strict';
import { redrawTerminalPane } from '../src/terminal-redraw.js';

function fixture() {
  const f = { rows: 46, cols: 227, paneRows: 46, writes: [], waits: 0 };
  f.options = {
    execTmux: async () => ({ stdout: `%7\t/dev/pts/7\t${f.paneRows}\t${f.cols}\n` }),
    execStty: async args => {
      if (args[2] === 'size') return { stdout: `${f.rows} ${f.cols}\n` };
      f.rows = Number(args[3]); f.writes.push(f.rows); return { stdout: '' };
    },
    wait: async () => { f.waits++; },
  };
  return f;
}

test('redraw changes one row and restores the original grid without terminal input', async () => {
  const f = fixture();
  assert.equal(await redrawTerminalPane('%7', f.options), true);
  assert.deepEqual(f.writes, [45, 46]);
  assert.equal(f.rows, 46);
});

test('redraw restores dimensions even when waiting fails', async () => {
  const f = fixture();
  f.options.wait = async () => { throw new Error('cancelled'); };
  await assert.rejects(redrawTerminalPane('%7', f.options), /cancelled/);
  assert.equal(f.rows, 46);
});

test('redraw never overwrites a concurrent real resize', async () => {
  const f = fixture();
  f.options.wait = async () => { f.rows = 50; f.paneRows = 50; };
  await redrawTerminalPane('%7', f.options);
  assert.deepEqual(f.writes, [45]);
  assert.equal(f.rows, 50);
});

test('redraw refuses mismatched dimensions or an unverified tty', async () => {
  for (const invalidTty of [false, true]) {
    const f = fixture();
    if (invalidTty) f.options.execTmux = async () => ({ stdout: '%7\t/tmp/tty\t46\t227' });
    else f.rows = 40;
    assert.equal(await redrawTerminalPane('%7', f.options), false);
    assert.deepEqual(f.writes, []);
  }
});
