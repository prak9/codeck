import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptStreamCursor,
  acceptStreamFrame,
  matchesThreadStreamTarget,
} from '../public/stream-state.js';

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

test('V2 patches advance only from an exact contiguous base', () => {
  const current = { epoch: 'server-a', sequence: 4 };
  assert.deepEqual(acceptStreamFrame(current, {
    epoch: 'server-a', baseSequence: 4, sequence: 5,
  }, 'delta'), {
    accepted: true, gap: false, cursor: { epoch: 'server-a', sequence: 5 },
  });
  assert.equal(acceptStreamFrame(current, {
    epoch: 'server-a', baseSequence: 5, sequence: 6,
  }, 'delta').gap, true);
  assert.equal(acceptStreamFrame(current, {
    epoch: 'server-b', baseSequence: 4, sequence: 5,
  }, 'delta').gap, true);
  assert.deepEqual(acceptStreamFrame(current, {
    epoch: 'server-a', baseSequence: 3, sequence: 4,
  }, 'delta'), { accepted: false, gap: false, cursor: current });
});

test('V2 full frames can repair an equal cursor while synchronization cannot jump a gap', () => {
  const current = { epoch: 'server-a', sequence: 4 };
  assert.deepEqual(acceptStreamFrame(current, {
    epoch: 'server-a', sequence: 4,
  }, 'snapshot'), {
    accepted: true, gap: false, cursor: current,
  });
  assert.deepEqual(acceptStreamFrame(current, {
    epoch: 'server-b', sequence: 1,
  }, 'snapshot'), {
    accepted: true, gap: false, cursor: { epoch: 'server-b', sequence: 1 },
  });
  assert.equal(acceptStreamFrame(current, {
    epoch: 'server-a', sequence: 5,
  }, 'synchronized').gap, true);
});

test('a synchronized frame at the current sequence confirms the stream', () => {
  // resumeFrames 在客户端已对齐时只发一帧 synchronized; 它必须被接受,
  // 否则 resyncing 标志清不掉, 后续真出现空洞也不会再重同步。
  const current = { epoch: 'e1', sequence: 7 };
  const result = acceptStreamFrame(current, { epoch: 'e1', sequence: 7 }, 'synchronized');
  assert.equal(result.accepted, true);
  assert.equal(result.gap, false);
});

test('a stale synchronized frame is dropped without forcing a resync', () => {
  const current = { epoch: 'e1', sequence: 7 };
  const result = acceptStreamFrame(current, { epoch: 'e1', sequence: 6 }, 'synchronized');
  assert.equal(result.accepted, false);
  assert.equal(result.gap, false);
});
