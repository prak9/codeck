import test from 'node:test';
import assert from 'node:assert/strict';
import { authenticateToken, createShareToken } from '../src/auth.js';

test('authenticates the owner token', () => {
  assert.deepEqual(authenticateToken('owner-secret', 'owner-secret'), { owner: true, session: null });
});

test('share tokens are scoped, signed and expiring', () => {
  const now = 1_000_000;
  const token = createShareToken('owner-secret', 'research', 60, now);
  assert.deepEqual(authenticateToken('owner-secret', token, now + 59_000), { owner: false, session: 'research' });
  assert.equal(authenticateToken('owner-secret', token, now + 60_000), null);
  assert.equal(authenticateToken('different-secret', token, now), null);
  assert.equal(authenticateToken('owner-secret', `${token}x`, now), null);
});
