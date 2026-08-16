import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSessionStatus, isSessionActive } from '../src/session-status.js';

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

test('session is done even if only file activity exists', () => {
  const session = {
    hasRunningProcess: false,
    sessionFileMtime: 123,
    activityAt: 123,
  };
  assert.equal(isSessionActive(session), false);
  assert.equal(resolveSessionStatus(session), 'done');
});
