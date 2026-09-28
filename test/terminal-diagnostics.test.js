import test from 'node:test';
import assert from 'node:assert/strict';
import { createTerminalDiagnostics } from '../src/terminal-diagnostics.js';

test('terminal diagnostic history is bounded by session and event count', () => {
  const trace = createTerminalDiagnostics({ maxSessions: 2, maxEvents: 2 });
  trace.record('a', 'attached', { grid: '80x24' });
  trace.record('a', 'resize', { to: '100x40' });
  trace.record('a', 'disconnected');
  assert.deepEqual(trace.read('a').map(e => e.event), ['resize', 'disconnected']);
  trace.record('b', 'attached');
  trace.record('c', 'attached');
  assert.deepEqual(trace.read('a'), []);
  const read = trace.read('b'); read[0].event = 'changed';
  assert.equal(trace.read('b')[0].event, 'attached');
});
