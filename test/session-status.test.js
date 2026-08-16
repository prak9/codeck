import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSessionStatus, isSessionActive, SESSION_ACTIVITY_WINDOW_MS } from '../src/session-status.js';

test('session is working while session file updated', () => {
  const now = 200_000;
  const session = { sessionFileMtime: now - 1_000 };
  assert.equal(isSessionActive(session, now), true);
  assert.equal(resolveSessionStatus(session, now), 'working');
});

test('session is working if session file updated within activity window', () => {
  const now = 200_000;
  const session = { sessionFileMtime: now - (SESSION_ACTIVITY_WINDOW_MS - 1) };
  assert.equal(isSessionActive(session, now), true);
  assert.equal(resolveSessionStatus(session, now), 'working');
});

test('session is done when session file update is older than activity window', () => {
  const now = 200_000;
  const session = { sessionFileMtime: now - (SESSION_ACTIVITY_WINDOW_MS + 1) };
  assert.equal(isSessionActive(session, now), false);
  assert.equal(resolveSessionStatus(session, now), 'done');
});

test('session status boundary at exactly window limit is working', () => {
  const now = 200_000;
  const session = { sessionFileMtime: now - SESSION_ACTIVITY_WINDOW_MS };
  assert.equal(isSessionActive(session, now), true);
  assert.equal(resolveSessionStatus(session, now), 'working');
});

test('session is done when no session file mtime', () => {
  const now = 200_000;
  const session = {};
  assert.equal(isSessionActive(session, now), false);
  assert.equal(resolveSessionStatus(session, now), 'done');
});

test('session is working when process is running regardless of output window', () => {
  const now = 200_000;
  const session = {
    sessionFileMtime: now - 60_000,
    hasRunningProcess: true,
    activityAt: now - 60_000,
  };
  assert.equal(isSessionActive(session, now), true);
  assert.equal(resolveSessionStatus(session, now), 'working');
});
