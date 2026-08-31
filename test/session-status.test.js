import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isSessionActive,
  resolveSessionStatus,
  sessionSnapshotRefreshInterval,
  threadSnapshotRefreshInterval,
} from '../src/session-status.js';

test('session is done when no session file mtime', () => {
  const session = {};
  assert.equal(isSessionActive(session), false);
  assert.equal(resolveSessionStatus(session), 'done');
});

test('session is working when process is running regardless of output window', () => {
  const session = {
    hasRunningProcess: true,
  };
  assert.equal(isSessionActive(session), true);
  assert.equal(resolveSessionStatus(session), 'working');
});

test('session is not ready while an Agent-owned background process is running', () => {
  const session = {
    hasRunningProcess: false,
    agent: { hasBackgroundProcess: true },
  };
  assert.equal(isSessionActive(session), false);
  assert.equal(resolveSessionStatus(session), 'background');
  session.hasRunningProcess = true;
  assert.equal(resolveSessionStatus(session), 'working');
});

test('session is done even if only file activity exists', () => {
  const session = {
    hasRunningProcess: false,
    sessionFileMtime: 123,
    activityAt: 123,
  };
  assert.equal(isSessionActive(session), false);
  assert.equal(resolveSessionStatus(session), 'done');
});

test('session snapshots stay fast while work exists and back off when every session is ready', () => {
  assert.equal(sessionSnapshotRefreshInterval({
    sessions: [{ status: 'done' }, { status: 'done' }],
  }), 5_000);
  assert.equal(sessionSnapshotRefreshInterval({
    sessions: [{ status: 'done' }, { status: 'working' }],
  }), 750);
  assert.equal(sessionSnapshotRefreshInterval({
    sessions: [{ status: 'background' }],
  }), 2_000);
});

test('thread snapshots back off only when both tmux and the structured thread are idle', () => {
  assert.equal(threadSnapshotRefreshInterval({
    thread: { status: { type: 'idle' } },
  }, 'done'), 10_000);
  assert.equal(threadSnapshotRefreshInterval({
    thread: { status: { type: 'active' } },
  }, 'done'), 350);
  assert.equal(threadSnapshotRefreshInterval({
    thread: { status: { type: 'idle' } },
  }, 'working'), 350);
});

test('thread snapshots keep following background and recently updated external turns', () => {
  assert.equal(threadSnapshotRefreshInterval({
    thread: { status: { type: 'idle' } },
  }, 'background', 20_000), 2_000);
  assert.equal(threadSnapshotRefreshInterval({
    thread: {
      status: { type: 'notLoaded' },
      updatedAt: 19,
      turns: [{ id: 'turn-1', status: 'interrupted', items: [] }],
    },
  }, 'done', 20_000), 350);
  assert.equal(threadSnapshotRefreshInterval({
    thread: {
      status: { type: 'notLoaded' },
      updatedAt: 1,
      turns: [{ id: 'turn-1', status: 'interrupted', items: [] }],
    },
  }, 'done', 20_000), 10_000);
  assert.equal(threadSnapshotRefreshInterval({
    thread: {
      status: { type: 'idle' },
      updatedAt: 19,
      turns: [{ id: 'turn-1', status: 'completed', items: [] }],
    },
  }, 'done', 20_000), 10_000);
});

test('an active thread is polled fast enough to feel live', () => {
  // 感知延迟的下限就是这个间隔。优化前每次轮询要 ~65ms (整份重读 transcript +
  // 序列化 + diff), 1Hz 已经是 6.5% 单核, 不敢再快; 现在增量读取 + 尾部窗口把
  // 它压到 ~6.3ms, 3Hz 也才 ~19ms/秒 —— 仍比优化前的 1Hz 便宜三倍多。
  assert.equal(threadSnapshotRefreshInterval({ thread: { status: { type: 'active' } } }, 'done'), 350);
  assert.equal(threadSnapshotRefreshInterval({}, 'working'), 350);
});

test('idle and background threads keep their slow cadence', () => {
  assert.equal(threadSnapshotRefreshInterval({}, 'background'), 2_000);
  assert.equal(threadSnapshotRefreshInterval({}, 'done'), 10_000);
});

test('the session scan keeps its cadence: it is the expensive one', () => {
  // listSessions 实测中位数 ~20ms, 是 thread 轮询的三倍, 而且是全局一份而不是
  // 每个打开的会话一份 —— 提速收益低、代价高, 保持不动。
  assert.equal(sessionSnapshotRefreshInterval({ sessions: [{ status: 'working' }] }), 750);
});
