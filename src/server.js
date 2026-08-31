import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { authenticateToken, createShareToken, terminalAccessForAuth } from './auth.js';
import { createAuthRateLimiter, requestClientAddress } from './auth-rate-limit.js';
import { createAgentBackends } from './agent-backends.js';
import { AgentHub, AgentRegistry } from './agent-connection.js';
import { createSession, detectWindowSizeSupport, interruptSession, killSession, listSessions, parseViewport, renameSession, selectSessionModel, sendSessionMessage, validateSessionName } from './tmux.js';
import { handleTerminalConnection } from './terminal-connection.js';
import { loadTlsOptions } from './tls.js';
import { createSessionSnapshotLoader } from './session-snapshot.js';
import { createSnapshotFeed } from './snapshot-feed.js';
import {
  resolveSessionStatus,
  sessionSnapshotRefreshInterval,
  threadSnapshotRefreshInterval,
} from './session-status.js';
import { AGENT_WEBSOCKET_OPTIONS } from './websocket-options.js';
import {
  WEB_SESSION_TTL_SECONDS,
  authenticateWebSession,
  clearWebSessionCookie,
  createWebSessionToken,
  readWebSessionCookie,
  safeNextPath,
  serializeWebSessionCookie,
} from './web-session.js';
import {
  resolveDownloadPath,
  saveFileUpload,
  saveImageUpload,
  uploadRoot,
} from './uploads.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const host = process.env.HOST || '0.0.0.0';
const port = Number(process.env.PORT || 4310);
const configuredAccessToken = process.env.CODECK_TOKEN;
const accessToken = configuredAccessToken || crypto.randomBytes(18).toString('base64url');
const webAuthEnabled = process.env.CODECK_WEB_AUTH === '1';
const publicDir = path.join(dirname, '../public');
const app = express();
const sessionSnapshots = createSessionSnapshotLoader(listSessions);
const protocolEpoch = crypto.randomUUID();
const sessionStatusByName = new Map();
const sessionPaneExcerpts = new Map();
let flexibleSizePromise = null;
const authRateLimiter = createAuthRateLimiter();
app.disable('x-powered-by');
app.use(setSecurityHeaders);
app.use(express.json({ limit: '16kb' }));

function setSecurityHeaders(_req, res, next) {
  res.set({
    'Content-Security-Policy': "frame-ancestors 'none'",
    'Permissions-Policy': 'microphone=(self), on-device-speech-recognition=(self)',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  });
  next();
}

function requestAuth(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return authenticateToken(accessToken, header.slice(7));
  if (webAuthEnabled && req.method === 'GET' && req.path === '/download' && requestHasWebSession(req)) {
    return { owner: true, session: null, canWrite: true };
  }
  return null;
}

function ownerOnly(req, res, next) {
  return req.auth.owner ? next() : res.status(403).json({ error: '分享链接无权管理会话' });
}

function rejectRateLimited(res, retryAfter) {
  res.set('Retry-After', String(retryAfter));
  return res.status(429).json({ error: '鉴权尝试次数过多，请稍后再试' });
}

function authenticateApiRequest(req, res, next) {
  const address = requestClientAddress(req);
  const limit = authRateLimiter.status(address);
  if (limit.blocked) return rejectRateLimited(res, limit.retryAfter);
  req.auth = requestAuth(req);
  if (req.auth) {
    if (req.auth.owner) authRateLimiter.reset(address);
    return next();
  }
  authRateLimiter.recordFailure(address);
  return res.status(401).json({ error: '访问令牌无效或分享链接已过期' });
}

function requestHasWebSession(req) {
  const token = readWebSessionCookie(req.headers.cookie);
  return authenticateWebSession(accessToken, token);
}

function requireWebSession(req, res, next) {
  if (!webAuthEnabled || req.path.startsWith('/api/') || requestHasWebSession(req)) return next();
  res.set('Cache-Control', 'no-store');
  const acceptsHtml = (req.headers.accept || '').includes('text/html');
  const navigation = req.method === 'GET' && (req.get('sec-fetch-mode') === 'navigate' || acceptsHtml);
  if (navigation) {
    const target = safeNextPath(req.originalUrl);
    return res.redirect(302, `/login.html?next=${encodeURIComponent(target)}`);
  }
  return res.status(401).json({ error: '请先登录 Codeck' });
}

function setLoginPageHeaders(res) {
  res.set({
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; connect-src 'self'; form-action 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  });
}

app.get('/login.html', (req, res) => {
  if (!webAuthEnabled) return res.redirect('/');
  if (requestHasWebSession(req)) return res.redirect(safeNextPath(req.query.next));
  setLoginPageHeaders(res);
  return res.sendFile(path.join(publicDir, 'login.html'));
});

app.post('/api/web-login', (req, res) => {
  if (!webAuthEnabled) return res.status(404).json({ error: '持久登录未启用' });
  const address = requestClientAddress(req);
  const limit = authRateLimiter.status(address);
  if (limit.blocked) return rejectRateLimited(res, limit.retryAfter);
  const auth = authenticateToken(accessToken, req.body?.token);
  res.set('Cache-Control', 'no-store');
  if (!auth?.owner) {
    authRateLimiter.recordFailure(address);
    return res.status(401).json({ error: '访问令牌不正确' });
  }
  authRateLimiter.reset(address);
  const now = Date.now();
  const token = createWebSessionToken(accessToken, now);
  res.setHeader('Set-Cookie', serializeWebSessionCookie(token, now));
  return res.json({
    ok: true,
    next: safeNextPath(req.body?.next),
    expiresAt: now + WEB_SESSION_TTL_SECONDS * 1000,
  });
});

app.post('/api/web-logout', (_req, res) => {
  if (!webAuthEnabled) return res.status(404).json({ error: '持久登录未启用' });
  res.set('Cache-Control', 'no-store');
  res.setHeader('Set-Cookie', clearWebSessionCookie());
  return res.status(204).end();
});

app.use('/api', authenticateApiRequest);

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Owner-only stream accounting: how much the delta protocol actually saves, per feed.
app.get('/api/stream-stats', ownerOnly, (_req, res) => res.json({
  sessions: sessionFeed.stats(),
  threads: threadFeed.stats(),
}));

function flexibleSizeSupport() {
  if (!flexibleSizePromise) {
    flexibleSizePromise = Promise.resolve().then(() => detectWindowSizeSupport()).catch((error) => {
      flexibleSizePromise = null;
      throw error;
    });
  }
  return flexibleSizePromise;
}

async function sessionSnapshotForAuth(auth) {
  let [sessions, flexibleSize] = await Promise.all([sessionSnapshots.get(), flexibleSizeSupport()]);
  if (!auth.owner) sessions = sessions.filter((session) => session.name === auth.session);
  const enriched = sessions.map((session) => {
    // The pane excerpt is intentionally dropped here. Only the session the viewer has
    // open needs it, so it travels on that thread's stream (sessionPaneExcerpts) instead
    // of being broadcast to every client for every working session on every scan.
    const { paneId: _paneId, liveOutput: _liveOutput, ...publicSession } = session;
    return {
      ...publicSession,
      agent: session.agent ? {
        kind: session.agent.kind,
        id: session.agent.id,
        name: session.agent.name,
        activity: session.agent.activity,
      } : null,
      status: resolveSessionStatus(session),
    };
  });
  return {
    sessions: enriched,
    capabilities: {
      flexibleSize,
      canManage: auth.owner,
      canWrite: auth.canWrite,
      canSwitchSession: auth.owner,
    },
  };
}

function invalidateSessionSnapshots() {
  sessionSnapshots.invalidate();
  return sessionFeed.invalidate('sessions');
}

app.get('/api/sessions', async (req, res, next) => {
  try {
    res.json(await sessionSnapshotForAuth(req.auth));
  } catch (error) { next(error); }
});

app.post('/api/sessions', ownerOnly, async (req, res, next) => {
  try {
    await createSession(req.body || {});
    invalidateSessionSnapshots().catch(() => {});
    res.status(201).json({ ok: true });
  } catch (error) { next(error); }
});

app.patch('/api/sessions/:name', ownerOnly, async (req, res, next) => {
  try {
    await renameSession(req.params.name, req.body?.name);
    invalidateSessionSnapshots().catch(() => {});
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.delete('/api/sessions/:name', ownerOnly, async (req, res, next) => {
  try {
    await killSession(req.params.name);
    invalidateSessionSnapshots().catch(() => {});
    res.status(204).end();
  } catch (error) { next(error); }
});

app.post('/api/sessions/:name/share', ownerOnly, async (req, res, next) => {
  try {
    const session = (await listSessions()).find((item) => item.name === req.params.name);
    if (!session) return res.status(404).json({ error: '会话不存在' });
    const token = createShareToken(accessToken, session.name);
    const url = new URL('/', 'https://codeck.local');
    url.hash = new URLSearchParams({ share: token });
    res.status(201).json({ url: `${url.pathname}${url.hash}`, expiresAt: Date.now() + 86400 * 1000 });
  } catch (error) { next(error); }
});

app.post('/api/uploads/images', ownerOnly, express.raw({ type: 'image/*', limit: '10mb' }), (req, res, next) => {
  try {
    const contentType = req.headers['content-type']?.split(';')[0].trim().toLowerCase();
    res.status(201).json({ path: saveImageUpload(req.body, contentType) });
  } catch (error) { next(error); }
});

app.post('/api/uploads/files', ownerOnly, express.raw({ type: '*/*', limit: '100mb' }), (req, res, next) => {
  try {
    const fileName = req.query.name || req.get('x-file-name') || 'upload';
    const relativePath = req.query.relativePath || req.get('x-relative-path') || '';
    res.status(201).json({ path: saveFileUpload(req.body, fileName, relativePath) });
  } catch (error) { next(error); }
});

app.get('/api/download', ownerOnly, (req, res, next) => {
  try {
    const filePath = resolveDownloadPath(req.query.path, uploadRoot);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: '文件不存在' });
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return res.status(400).json({ error: '只能下载文件' });
    res.download(filePath, path.basename(filePath));
  } catch (error) { next(error); }
});

app.use(requireWebSession);
app.use('/vendor', express.static(path.join(dirname, '../node_modules/@xterm/xterm/css')));
app.use('/vendor/xterm', express.static(path.join(dirname, '../node_modules/@xterm/xterm/lib')));
app.use('/vendor/fit', express.static(path.join(dirname, '../node_modules/@xterm/addon-fit/lib')));
app.use('/fonts/inter', express.static(path.join(dirname, '../node_modules/@fontsource-variable/inter')));
app.use('/fonts/noto-sans-sc', express.static(path.join(dirname, '../node_modules/@fontsource-variable/noto-sans-sc')));
app.use('/fonts/jetbrains-mono', express.static(path.join(dirname, '../node_modules/@fontsource-variable/jetbrains-mono')));
app.use(express.static(publicDir));
app.use((error, _req, res, _next) => {
  const status = error.type === 'entity.too.large'
    ? 413
    : /无效|只能|未知|格式|为空|非法|上传/.test(error.message)
      ? 400
      : 500;
  res.status(status).json({ error: error.message || '服务器操作失败' });
});

const tls = loadTlsOptions();
const server = https.createServer({ cert: tls.cert, key: tls.key }, app);
const wss = new WebSocketServer({ noServer: true });
const agentWss = new WebSocketServer({ noServer: true, ...AGENT_WEBSOCKET_OPTIONS });
const agentRegistry = new AgentRegistry(createAgentBackends(), {
  listTmuxSessions: listSessions,
  sendTmuxMessage: sendSessionMessage,
  selectTmuxModel: selectSessionModel,
  interruptTmuxSession: interruptSession,
});
const sessionFeed = createSnapshotFeed(
  async () => {
    const raw = await sessionSnapshots.get();
    const snapshot = await sessionSnapshotForAuth({ owner: true, session: null, canWrite: true });
    sessionStatusByName.clear();
    for (const session of snapshot.sessions) sessionStatusByName.set(session.name, session.status);
    sessionPaneExcerpts.clear();
    for (const session of raw) {
      const excerpt = session.agent?.liveOutput || session.liveOutput || '';
      if (excerpt) sessionPaneExcerpts.set(session.name, excerpt);
    }
    return snapshot;
  },
  { epoch: protocolEpoch, intervalMs: sessionSnapshotRefreshInterval },
);
function withPaneExcerpt(result, tmuxSession) {
  const excerpt = sessionPaneExcerpts.get(tmuxSession);
  if (!excerpt || !result?.thread) return result;
  return { ...result, thread: { ...result.thread, liveOutput: excerpt } };
}

// 轮询流只需要携带尾部: 新内容永远追加在末尾, 更早的 turn 已经在客户端手里
// (openThread 首帧返回完整 transcript)。整份重推每秒要为 890KB 付出序列化、
// permessage-deflate 和客户端解析的代价, 而真正会变的只有最后一两个 turn。
// truncated 标记让客户端知道窗口之前的历史是"已有"而不是"被删"。
const THREAD_STREAM_TURN_WINDOW = 20;

function windowedThread(result, limit = THREAD_STREAM_TURN_WINDOW) {
  const turns = result?.thread?.turns;
  if (!Array.isArray(turns) || turns.length <= limit) return result;
  return {
    ...result,
    thread: { ...result.thread, truncated: true, turns: turns.slice(-limit) },
  };
}

const threadFeed = createSnapshotFeed(
  async ({ provider, threadId, tmuxSession }) => windowedThread(withPaneExcerpt(
    await agentRegistry.openThread(provider, threadId, { readOnly: true }), tmuxSession,
  )),
  {
    epoch: protocolEpoch,
    intervalMs: (snapshot, target) => threadSnapshotRefreshInterval(
      snapshot, sessionStatusByName.get(target.tmuxSession),
    ),
    resourceKey: ({ provider, threadId, tmuxSession }) => `${provider}:${threadId}:${tmuxSession || ''}`,
  },
);
const agentHub = new AgentHub(agentRegistry, {
  defaultCwd: process.cwd(),
  hostname: os.hostname(),
  protocolEpoch,
  sessionFeed,
  threadFeed,
  invalidateSessions: invalidateSessionSnapshots,
  paneExcerpt: (tmuxSession) => sessionPaneExcerpts.get(tmuxSession) || '',
});

server.on('upgrade', (req, socket, head) => {
  const address = requestClientAddress(req);
  const limit = authRateLimiter.status(address);
  if (limit.blocked) {
    socket.write(`HTTP/1.1 429 Too Many Requests\r\nRetry-After: ${limit.retryAfter}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
    return;
  }
  const url = new URL(req.url, 'http://localhost');
  const protocols = (req.headers['sec-websocket-protocol'] || '').split(',').map((value) => value.trim());
  const encodedToken = protocols.find((value) => value.startsWith('codeck.'))?.slice(7);
  const credential = encodedToken ? Buffer.from(encodedToken, 'base64url').toString('utf8') : '';
  const auth = authenticateToken(accessToken, credential);
  if (!auth) authRateLimiter.recordFailure(address);
  else if (auth.owner) authRateLimiter.reset(address);
  if (url.pathname === '/agent') {
    if (!auth?.owner) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    const streamVersion = url.searchParams.get('streamVersion') === '2' ? 2 : 1;
    agentWss.handleUpgrade(req, socket, head, (ws) => agentWss.emit('connection', ws, { streamVersion }));
    return;
  }
  const session = url.searchParams.get('session');
  if (url.pathname !== '/ws' || !auth || (!auth.owner && auth.session !== session)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  if (!validateSessionName(session)) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }
  const viewport = parseViewport(url.searchParams);
  const terminalAccess = {
    ...terminalAccessForAuth(auth),
    canSwitchSession: auth.owner,
    onSessionActivity: () => invalidateSessionSnapshots().catch(() => {}),
  };
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, session, viewport, terminalAccess));
});

wss.on('connection', (ws, session, viewport, terminalAccess) => handleTerminalConnection(ws, session, viewport, terminalAccess));
agentWss.on('connection', (ws, options) => agentHub.handleConnection(ws, options));
server.on('close', () => {
  sessionFeed.close();
  threadFeed.close();
  agentRegistry.close();
});

server.listen(port, host, () => {
  console.log(`Codeck is running at https://${host}:${port}`);
  if (tls.generated) console.log('TLS: using the persistent self-signed certificate in ~/.codeck');
  if (configuredAccessToken) console.log('Access token: configured through CODECK_TOKEN');
  else console.log(`Access token: ${accessToken}`);
});
