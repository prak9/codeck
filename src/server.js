import crypto from 'node:crypto';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import pty from 'node-pty';
import { WebSocketServer } from 'ws';
import { authenticateToken, createShareToken } from './auth.js';
import { createSession, getSessionSize, killSession, listSessions, preferLargestClientSize, renameSession, supportsLargestClientSize, validateSessionName, withoutTmuxEnvironment } from './tmux.js';
import { loadTlsOptions } from './tls.js';
import { saveImageUpload } from './uploads.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const host = process.env.HOST || '0.0.0.0';
const port = Number(process.env.PORT || 4310);
const accessToken = process.env.CODECK_TOKEN || crypto.randomBytes(18).toString('base64url');
const app = express();
const SESSION_STATUS_POLL_MS = 5_000;
const sessionStatusByName = new Map();

function resolveTrackedStatus(session) {
  if (!session.agent) return 'done';
  return session.hasRunningProcess ? 'working' : 'done';
}

async function refreshSessionStatuses() {
  try {
    const sessions = await listSessions();
    const next = new Map();
    for (const session of sessions) next.set(session.name, resolveTrackedStatus(session));
    sessionStatusByName.clear();
    for (const [name, status] of next) sessionStatusByName.set(name, status);
  } catch {
    // keep stale cache when tmux is temporarily unavailable
  }
}

setInterval(() => {
  void refreshSessionStatuses();
}, SESSION_STATUS_POLL_MS);
void refreshSessionStatuses();


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
    let [sessions, largestSize] = await Promise.all([listSessions(), supportsLargestClientSize()]);
    if (!req.auth.owner) sessions = sessions.filter((session) => session.name === req.auth.session);
    const enriched = sessions.map((session) => ({
      ...session,
      status: session.agent ? sessionStatusByName.get(session.name) || 'done' : 'done',
    }));
    res.json({ sessions: enriched, capabilities: { largestSize, canManage: req.auth.owner } });
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

app.use(express.static(path.join(dirname, '../public')));
app.use((error, _req, res, _next) => {
  const status = error.type === 'entity.too.large' ? 413 : /无效|只能|未知|格式|为空/.test(error.message) ? 400 : 500;
  res.status(status).json({ error: error.message || '服务器操作失败' });
});

const tls = loadTlsOptions();
const server = https.createServer({ cert: tls.cert, key: tls.key }, app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  const protocols = (req.headers['sec-websocket-protocol'] || '').split(',').map((value) => value.trim());
  const encodedToken = protocols.find((value) => value.startsWith('codeck.'))?.slice(7);
  const credential = encodedToken ? Buffer.from(encodedToken, 'base64url').toString('utf8') : '';
  const auth = authenticateToken(accessToken, credential);
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
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, session));
});

wss.on('connection', async (ws, session) => {
  let largestSize;
  let initialSize;
  try {
    [largestSize, initialSize] = await Promise.all([preferLargestClientSize(), getSessionSize(session)]);
  } catch (error) {
    ws.close(1011, error.message || 'tmux size configuration failed');
    return;
  }
  const terminal = pty.spawn('tmux', ['attach-session', '-t', session], {
    name: 'xterm-256color', cols: initialSize.width, rows: initialSize.height, cwd: process.cwd(), env: withoutTmuxEnvironment(process.env),
  });
  terminal.onData((data) => ws.readyState === ws.OPEN && ws.send(data));
  terminal.onExit(({ exitCode }) => ws.close(1000, `terminal exited (${exitCode})`));
  ws.on('message', (raw, binary) => {
    if (binary) return;
    try {
      const message = JSON.parse(raw.toString());
      if (message.type === 'input' && typeof message.data === 'string') terminal.write(message.data);
      if (message.type === 'resize' && Number.isInteger(message.cols) && Number.isInteger(message.rows)) {
        const minCols = largestSize ? 20 : initialSize.width;
        const minRows = largestSize ? 5 : initialSize.height;
        terminal.resize(Math.max(minCols, message.cols), Math.max(minRows, message.rows));
      }
    } catch { /* Ignore malformed terminal frames. */ }
  });
  ws.on('close', () => {
    terminal.kill();
  });
});

server.listen(port, host, () => {
  console.log(`Codeck is running at https://${host}:${port}`);
  if (tls.generated) console.log('TLS: using the persistent self-signed certificate in ~/.codeck');
  console.log(`Access token: ${accessToken}`);
});
