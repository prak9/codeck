import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSessionStatus, isSessionActive, SESSION_STATUS_WINDOW_MS } from '../src/session-status.js';

test('session is working while running process exists', () => {
  const session = { hasRunningProcess: true, activityAt: 0 };
  assert.equal(isSessionActive(session, 100_000), true);
  assert.equal(resolveSessionStatus(session, 100_000), 'working');
});

test('session is working if output activity is within 30 seconds', () => {
  const now = 200_000;
  const session = { hasRunningProcess: false, activityAt: now - (SESSION_STATUS_WINDOW_MS - 1) };
  assert.equal(resolveSessionStatus(session, now), 'working');
});

test('session is done when output activity is older than 30 seconds', () => {
  const now = 200_000;
  const session = { hasRunningProcess: false, activityAt: now - (SESSION_STATUS_WINDOW_MS + 1) };
  assert.equal(resolveSessionStatus(session, now), 'done');
});

test('session status boundary at exactly 30 seconds is working', () => {
  const now = 300_000;
  const session = { hasRunningProcess: false, activityAt: now - SESSION_STATUS_WINDOW_MS };
  assert.equal(resolveSessionStatus(session, now), 'working');
});

