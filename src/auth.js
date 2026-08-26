import crypto from 'node:crypto';

function equal(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function createShareToken(secret, session, ttlSeconds = 86400, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({
    session,
    expiresAt: now + ttlSeconds * 1000,
    canWrite: true,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `share.${payload}.${signature}`;
}

export function authenticateToken(secret, token, now = Date.now()) {
  if (typeof token !== 'string') return null;
  if (equal(token, secret)) return { owner: true, session: null, canWrite: true };

  const [prefix, payload, signature, extra] = token.split('.');
  if (prefix !== 'share' || !payload || !signature || extra) return null;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  if (!equal(signature, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof data.session !== 'string' || !Number.isFinite(data.expiresAt) || data.expiresAt <= now) return null;
    return { owner: false, session: data.session, canWrite: data.canWrite === true };
  } catch {
    return null;
  }
}

export function terminalAccessForAuth(auth) {
  if (!auth?.canWrite) return { readOnly: true };
  if (!auth.owner) return { readOnly: false, detachOtherClients: false };
  return { readOnly: false };
}
