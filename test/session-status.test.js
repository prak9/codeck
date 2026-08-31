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
  }, 'done'), 1_000);
  assert.equal(threadSnapshotRefreshInterval({
    thread: { status: { type: 'idle' } },
  }, 'working'), 1_000);
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
  }, 'done', 20_000), 1_000);
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
