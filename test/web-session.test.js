import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WEB_SESSION_COOKIE,
  WEB_SESSION_TTL_SECONDS,
  authenticateWebSession,
  clearWebSessionCookie,
  createWebSessionToken,
  readWebSessionCookie,
  safeNextPath,
  serializeWebSessionCookie,
} from '../src/web-session.js';

test('web sessions are signed, expire after 30 days and fail closed when changed', () => {
  const now = Date.UTC(2026, 7, 24);
  const token = createWebSessionToken('owner-secret', now);

  assert.equal(WEB_SESSION_TTL_SECONDS, 30 * 24 * 60 * 60);
  assert.equal(authenticateWebSession('owner-secret', token, now + WEB_SESSION_TTL_SECONDS * 1000 - 1), true);
  assert.equal(authenticateWebSession('owner-secret', token, now + WEB_SESSION_TTL_SECONDS * 1000), false);
  assert.equal(authenticateWebSession('different-secret', token, now), false);
  assert.equal(authenticateWebSession('owner-secret', `${token}x`, now), false);
});

test('web session cookies are host-only, persistent and unavailable to JavaScript', () => {
  const now = Date.UTC(2026, 7, 24);
  const token = createWebSessionToken('owner-secret', now);
  const cookie = serializeWebSessionCookie(token, now);

  assert.match(cookie, new RegExp(`^${WEB_SESSION_COOKIE}=`));
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /Max-Age=2592000/);
  assert.match(cookie, /Expires=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  assert.doesNotMatch(cookie, /SameSite=Strict/);
  assert.doesNotMatch(cookie, /Domain=/);
  assert.equal(readWebSessionCookie(`theme=dark; ${cookie.split(';')[0]}`), token);
  assert.equal(readWebSessionCookie(`${cookie.split(';')[0]}; ${cookie.split(';')[0]}`), null);
  assert.match(clearWebSessionCookie(), new RegExp(`^${WEB_SESSION_COOKIE}=;.*Max-Age=0`));
});

test('post-login navigation stays on this Codeck origin', () => {
  assert.equal(safeNextPath('/remote.html?view=active'), '/remote.html?view=active');
  assert.equal(safeNextPath('/'), '/');
  assert.equal(safeNextPath('https://example.com/steal'), '/');
  assert.equal(safeNextPath('//example.com/steal'), '/');
  assert.equal(safeNextPath('/login.html?next=%2Fremote.html'), '/');
  assert.equal(safeNextPath('not-a-path'), '/');
});
