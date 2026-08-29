import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptStreamCursor, matchesThreadStreamTarget } from '../public/stream-state.js';

test('stream cursors reject stale snapshots and reset on a server epoch change', () => {
  const first = acceptStreamCursor(null, { epoch: 'server-a', sequence: 4 });
  assert.deepEqual(first, { accepted: true, cursor: { epoch: 'server-a', sequence: 4 } });
  assert.equal(acceptStreamCursor(first.cursor, { epoch: 'server-a', sequence: 4 }).accepted, false);
  assert.equal(acceptStreamCursor(first.cursor, { epoch: 'server-a', sequence: 3 }).accepted, false);
  assert.deepEqual(acceptStreamCursor(first.cursor, { epoch: 'server-b', sequence: 1 }), {
    accepted: true,
    cursor: { epoch: 'server-b', sequence: 1 },
  });
});

test('thread streams require provider, thread id and tmux session identity', () => {
  const current = { provider: 'codex', id: 'shared-thread', tmux: { name: 'skills' } };
  assert.equal(matchesThreadStreamTarget(current, {
    provider: 'codex', threadId: 'shared-thread', tmuxSession: 'skills',
  }), true);
  assert.equal(matchesThreadStreamTarget(current, {
    provider: 'codex', threadId: 'shared-thread', tmuxSession: 'codeck',
  }), false);
  assert.equal(matchesThreadStreamTarget(current, {
    provider: 'claude', threadId: 'shared-thread', tmuxSession: 'skills',
  }), false);
});
