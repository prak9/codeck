import crypto from 'node:crypto';

export const WEB_SESSION_COOKIE = '__Host-codeck-web';
export const WEB_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

function equal(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function signature(secret, payload) {
  return crypto.createHmac('sha256', secret).update(`web.${payload}`).digest('base64url');
}

export function createWebSessionToken(secret, now = Date.now(), ttlSeconds = WEB_SESSION_TTL_SECONDS) {
  const expiresAt = now + ttlSeconds * 1000;
  const payload = Buffer.from(JSON.stringify({ expiresAt })).toString('base64url');
  return `web.${payload}.${signature(secret, payload)}`;
}

export function authenticateWebSession(secret, token, now = Date.now()) {
  if (typeof token !== 'string') return false;
  const [prefix, payload, signed, extra] = token.split('.');
  if (prefix !== 'web' || !payload || !signed || extra || !equal(signed, signature(secret, payload))) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return Number.isSafeInteger(data.expiresAt) && data.expiresAt > now;
  } catch {
    return false;
  }
}

export function readWebSessionCookie(header) {
  if (typeof header !== 'string') return null;
  let found = null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== WEB_SESSION_COOKIE) continue;
    if (found !== null) return null;
    found = part.slice(separator + 1).trim() || null;
  }
  return found;
}

export function serializeWebSessionCookie(token, now = Date.now(), ttlSeconds = WEB_SESSION_TTL_SECONDS) {
  const expires = new Date(now + ttlSeconds * 1000).toUTCString();
  return `${WEB_SESSION_COOKIE}=${token}; Path=/; Max-Age=${ttlSeconds}; Expires=${expires}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearWebSessionCookie() {
  return `${WEB_SESSION_COOKIE}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax`;
}

export function safeNextPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return '/';
  try {
    const target = new URL(value, 'https://codeck.local');
    if (target.origin !== 'https://codeck.local' || target.pathname === '/login.html') return '/';
    return `${target.pathname}${target.search}`;
  } catch {
    return '/';
  }
}
