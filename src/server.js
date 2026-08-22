import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { authenticateToken, createShareToken } from './auth.js';
import { createAgentBackends } from './agent-backends.js';
import { AgentHub, AgentRegistry } from './agent-connection.js';
import { createSession, detectWindowSizeSupport, interruptSession, killSession, listSessions, parseViewport, renameSession, sendSessionMessage, validateSessionName } from './tmux.js';
import { handleTerminalConnection } from './terminal-connection.js';
import { loadTlsOptions } from './tls.js';
import { resolveSessionStatus } from './session-status.js';
import {
  resolveDownloadPath,
  saveFileUpload,
  saveImageUpload,
  uploadRoot,
} from './uploads.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const host = process.env.HOST || '0.0.0.0';
const port = Number(process.env.PORT || 4310);
const accessToken = process.env.CODECK_TOKEN || crypto.randomBytes(18).toString('base64url');
const app = express();
app.use(express.json({ limit: '16kb' }));
app.use('/vendor', express.static(path.join(dirname, '../node_modules/@xterm/xterm/css')));
app.use('/vendor/xterm', express.static(path.join(dirname, '../node_modules/@xterm/xterm/lib')));
app.use('/vendor/fit', express.static(path.join(dirname, '../node_modules/@xterm/addon-fit/lib')));
app.use('/fonts/inter', express.static(path.join(dirname, '../node_modules/@fontsource-variable/inter')));
app.use('/fonts/noto-sans-sc', express.static(path.join(dirname, '../node_modules/@fontsource-variable/noto-sans-sc')));
app.use('/fonts/jetbrains-mono', express.static(path.join(dirname, '../node_modules/@fontsource-variable/jetbrains-mono')));

function requestAuth(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? authenticateToken(accessToken, header.slice(7)) : null;
}

function ownerOnly(req, res, next) {
  return req.auth.owner ? next() : res.status(403).json({ error: '分享链接无权管理会话' });
}

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use('/api', (req, res, next) => {
  req.auth = requestAuth(req);
  return req.auth ? next() : res.status(401).json({ error: '访问令牌无效或分享链接已过期' });
});

app.get('/api/sessions', async (req, res, next) => {
  try {
    let [sessions, flexibleSize] = await Promise.all([listSessions(), detectWindowSizeSupport()]);
    if (!req.auth.owner) sessions = sessions.filter((session) => session.name === req.auth.session);
    const enriched = sessions.map((session) => {
      const { paneId: _paneId, liveOutput, ...publicSession } = session;
      return {
        ...publicSession,
        ...(req.auth.owner && liveOutput ? { liveOutput } : {}),
        agent: session.agent ? {
          kind: session.agent.kind,
          id: session.agent.id,
          name: session.agent.name,
          activity: session.agent.activity,
          ...(req.auth.owner && session.agent.liveOutput ? { liveOutput: session.agent.liveOutput } : {}),
        } : null,
        status: resolveSessionStatus(session),
      };
    });
    res.json({ sessions: enriched, capabilities: { flexibleSize, canManage: req.auth.owner } });
  } catch (error) { next(error); }
});

app.post('/api/sessions', ownerOnly, async (req, res, next) => {
  try {
    await createSession(req.body || {});
    res.status(201).json({ ok: true });
  } catch (error) { next(error); }
});

app.patch('/api/sessions/:name', ownerOnly, async (req, res, next) => {
  try {
    await renameSession(req.params.name, req.body?.name);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.delete('/api/sessions/:name', ownerOnly, async (req, res, next) => {
  try {
    await killSession(req.params.name);
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

app.post('/api/uploads/images', express.raw({ type: 'image/*', limit: '10mb' }), (req, res, next) => {
  try {
    const contentType = req.headers['content-type']?.split(';')[0].trim().toLowerCase();
    res.status(201).json({ path: saveImageUpload(req.body, contentType) });
  } catch (error) { next(error); }
});

app.post('/api/uploads/files', express.raw({ type: '*/*', limit: '100mb' }), (req, res, next) => {
  try {
    const fileName = req.query.name || req.get('x-file-name') || 'upload';
    const relativePath = req.query.relativePath || req.get('x-relative-path') || '';
    res.status(201).json({ path: saveFileUpload(req.body, fileName, relativePath) });
  } catch (error) { next(error); }
});

app.get('/api/download', (req, res, next) => {
  try {
    const queryToken = req.query.token;
    const tokenHeader = req.headers.authorization || '';
    const token = tokenHeader.startsWith('Bearer ') ? tokenHeader.slice(7) : queryToken;
    const auth = authenticateToken(accessToken, token);
    if (!auth) return res.status(401).json({ error: '访问令牌无效或下载凭据已过期' });
    const filePath = resolveDownloadPath(req.query.path, uploadRoot);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: '文件不存在' });
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return res.status(400).json({ error: '只能下载文件' });
    res.download(filePath, path.basename(filePath));
  } catch (error) { next(error); }
});

app.use(express.static(path.join(dirname, '../public')));
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
const agentWss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
const agentRegistry = new AgentRegistry(createAgentBackends(), {
  listTmuxSessions: listSessions,
  sendTmuxMessage: sendSessionMessage,
  interruptTmuxSession: interruptSession,
});
const agentHub = new AgentHub(agentRegistry, { defaultCwd: process.cwd(), hostname: os.hostname() });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  const protocols = (req.headers['sec-websocket-protocol'] || '').split(',').map((value) => value.trim());
  const encodedToken = protocols.find((value) => value.startsWith('codeck.'))?.slice(7);
  const credential = encodedToken ? Buffer.from(encodedToken, 'base64url').toString('utf8') : '';
  const auth = authenticateToken(accessToken, credential);
  if (url.pathname === '/agent') {
    if (!auth?.owner) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    agentWss.handleUpgrade(req, socket, head, (ws) => agentWss.emit('connection', ws));
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
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, session, viewport));
});

wss.on('connection', handleTerminalConnection);
agentWss.on('connection', (ws) => agentHub.handleConnection(ws));
server.on('close', () => agentRegistry.close());

server.listen(port, host, () => {
  console.log(`Codeck is running at https://${host}:${port}`);
  if (tls.generated) console.log('TLS: using the persistent self-signed certificate in ~/.codeck');
  console.log(`Access token: ${accessToken}`);
});
