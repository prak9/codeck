import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthRateLimiter, requestClientAddress } from '../src/auth-rate-limit.js';

test('authentication failures block an address until the fixed window expires', () => {
  const limiter = createAuthRateLimiter({ maxFailures: 3, windowMs: 60_000 });
  const now = 1_000_000;

  assert.deepEqual(limiter.status('198.51.100.8', now), { blocked: false, retryAfter: 0 });
  limiter.recordFailure('198.51.100.8', now);
  limiter.recordFailure('198.51.100.8', now + 1);
  limiter.recordFailure('198.51.100.8', now + 2);
  assert.deepEqual(limiter.status('198.51.100.8', now + 3), { blocked: true, retryAfter: 60 });
  assert.deepEqual(limiter.status('198.51.100.8', now + 60_000), { blocked: false, retryAfter: 0 });
});

test('a successful owner login can clear earlier failures before lockout', () => {
  const limiter = createAuthRateLimiter({ maxFailures: 3, windowMs: 60_000 });
  limiter.recordFailure('198.51.100.8', 1_000);
  limiter.recordFailure('198.51.100.8', 1_001);
  limiter.reset('198.51.100.8');

  assert.deepEqual(limiter.status('198.51.100.8', 1_002), { blocked: false, retryAfter: 0 });
});

test('the direct peer wins unless a trusted loopback proxy appended the client address', () => {
  assert.equal(requestClientAddress({
    socket: { remoteAddress: '10.0.0.7' },
    headers: { 'x-forwarded-for': '203.0.113.9' },
  }), '10.0.0.7');
  assert.equal(requestClientAddress({
    socket: { remoteAddress: '127.0.0.1' },
    headers: { 'x-forwarded-for': 'spoofed, 198.51.100.8' },
  }), '198.51.100.8');
  assert.equal(requestClientAddress({
    socket: { remoteAddress: '::ffff:127.0.0.1' },
    headers: {},
  }), '::ffff:127.0.0.1');
});
