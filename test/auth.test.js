import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { authenticateToken, createShareToken } from '../src/auth.js';

const serverSource = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
const appSource = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

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

test('health checks pass through the API authentication boundary', () => {
  const authMiddleware = serverSource.indexOf("app.use('/api'");
  const healthRoute = serverSource.indexOf("app.get('/api/health'");
  assert.ok(authMiddleware >= 0 && healthRoute > authMiddleware);
});

test('optional web login runs before API auth and gates every static resource', () => {
  const webLogin = serverSource.indexOf("app.post('/api/web-login'");
  const apiAuth = serverSource.indexOf("app.use('/api'");
  const webGate = serverSource.indexOf('app.use(requireWebSession)');
  const vendorAssets = serverSource.indexOf("app.use('/vendor'");
  const publicAssets = serverSource.indexOf('app.use(express.static');

  assert.ok(webLogin >= 0 && webLogin < apiAuth);
  assert.ok(webGate > apiAuth && webGate < vendorAssets && webGate < publicAssets);
});

test('share credentials stay read-only at every mutable server boundary', () => {
  assert.match(serverSource, /app\.post\('\/api\/uploads\/images', ownerOnly,/);
  assert.match(serverSource, /app\.post\('\/api\/uploads\/files', ownerOnly,/);
  assert.match(serverSource, /app\.get\('\/api\/download', ownerOnly,/);
  assert.match(serverSource, /wss\.emit\('connection', ws, session, viewport, !auth\.owner\)/);
  assert.match(serverSource, /handleTerminalConnection\(ws, session, viewport, \{ readOnly \}\)/);
});

test('download links never expose the owner token in URLs or proxy logs', () => {
  assert.doesNotMatch(appSource, /params\.set\('token'/);
  assert.match(serverSource, /req\.method === 'GET' && req\.path === '\/download' && requestHasWebSession\(req\)/);
  assert.match(serverSource, /app\.get\('\/api\/download', ownerOnly,/);
});

test('all responses receive baseline browser security headers', () => {
  const headers = serverSource.indexOf('app.use(setSecurityHeaders)');
  const login = serverSource.indexOf("app.get('/login.html'");
  const staticFiles = serverSource.indexOf('app.use(express.static');

  assert.ok(headers >= 0 && headers < login && headers < staticFiles);
  assert.match(serverSource, /app\.disable\('x-powered-by'\)/);
  assert.match(serverSource, /'X-Frame-Options': 'DENY'/);
  assert.match(serverSource, /frame-ancestors 'none'/);
  assert.match(serverSource, /'Permissions-Policy': 'microphone=\(self\)'/);
});

test('a configured owner token is never written to process logs', () => {
  assert.match(serverSource, /if \(configuredAccessToken\) console\.log\('Access token: configured through CODECK_TOKEN'\);\s*else console\.log\(`Access token: \$\{accessToken\}`\);/);
});

test('the shared terminal UI disables every input path while preserving viewing', () => {
  assert.match(appSource, /state\.terminal\.options\.disableStdin = !state\.canManage/);
  assert.match(appSource, /data-terminal-action="paste"/);
  assert.match(appSource, /control\.disabled = !state\.canManage/);
  assert.match(appSource, /if \(!state\.canManage\) return false;/);
  assert.match(appSource, /state\.canManage && state\.socket\?\.readyState === WebSocket\.OPEN/);
  assert.match(appSource, /state\.canManage \? '已连接' : '已连接（只读）'/);
});
