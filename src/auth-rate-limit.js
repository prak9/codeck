import { isIP } from 'node:net';

const DEFAULT_MAX_FAILURES = 10;
const DEFAULT_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 4096;

function isLoopback(address) {
  return address === '127.0.0.1'
    || address === '::1'
    || address.startsWith('::ffff:127.');
}

export function requestClientAddress(req) {
  const remote = String(req?.socket?.remoteAddress || 'unknown').trim();
  const forwarded = req?.headers?.['x-forwarded-for'];
  if (isLoopback(remote) && typeof forwarded === 'string') {
    const candidate = forwarded.split(',').map((value) => value.trim()).filter(Boolean).at(-1);
    if (candidate && isIP(candidate)) return candidate;
  }
  return remote;
}

export function createAuthRateLimiter({
  maxFailures = DEFAULT_MAX_FAILURES,
  windowMs = DEFAULT_WINDOW_MS,
  maxEntries = DEFAULT_MAX_ENTRIES,
} = {}) {
  const failures = new Map();

  function removeExpired(now) {
    for (const [key, entry] of failures) {
      if (entry.resetAt <= now) failures.delete(key);
    }
  }

  function status(key, now = Date.now()) {
    const entry = failures.get(key);
    if (!entry || entry.resetAt <= now) {
      if (entry) failures.delete(key);
      return { blocked: false, retryAfter: 0 };
    }
    if (entry.count < maxFailures) return { blocked: false, retryAfter: 0 };
    return { blocked: true, retryAfter: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) };
  }

  function recordFailure(key, now = Date.now()) {
    const current = failures.get(key);
    if (!current || current.resetAt <= now) {
      removeExpired(now);
      while (failures.size >= maxEntries) failures.delete(failures.keys().next().value);
      failures.set(key, { count: 1, resetAt: now + windowMs });
      return;
    }
    current.count += 1;
  }

  function reset(key) {
    failures.delete(key);
  }

  return { recordFailure, reset, status };
}
