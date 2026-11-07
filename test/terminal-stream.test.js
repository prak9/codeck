import test from 'node:test';
import assert from 'node:assert/strict';
import { createTerminalStream } from '../public/terminal-stream.js';

test('switch ignores delayed old output including a reset, and a gap requires a fresh snapshot', () => {
  const stream = createTerminalStream('2');
  const frame = (flowId, epoch, seq, data, reset = false) => ({ type: 'terminalOutput', flowId, epoch, seq, data, reset });
  assert.equal(stream.accept(frame('1', 1, 2, '\x1bc', true)), null);
  assert.equal(stream.accept(frame('2', 2, 2, '\x1bc', true)).reset, true);
  assert.equal(stream.accept(frame('2', 2, 5, 'abc')).data, 'abc');
  assert.equal(stream.accept(frame('2', 2, 5, 'abc')), null);
  assert.throws(() => stream.accept(frame('2', 2, 9, 'gap')), /同步/);
  assert.equal(stream.accept(frame('2', 3, 2, '\x1bc', true)).reset, true);
  assert.equal(stream.accept(frame('2', 2, 8, 'old')), null);
  assert.equal(stream.accept(frame('2', 3, 5, 'new')).data, 'new');
});
