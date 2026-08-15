import crypto from 'node:crypto';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import pty from 'node-pty';
import { WebSocketServer } from 'ws';
import { createSession, killSession, listSessions, renameSession, validateSessionName } from './tmux.js';
import { loadTlsOptions } from './tls.js';
import { saveImageUpload } from './uploads.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const host = process.env.HOST || '0.0.0.0';
const port = Number(process.env.PORT || 4310);
const accessToken = process.env.CODECK_TOKEN || crypto.randomBytes(18).toString('base64url');
const websocketToken = Buffer.from(accessToken, 'utf8').toString('base64url');
const app = express();

app.use(express.json({ limit: '16kb' }));
app.use('/vendor', express.static(path.join(dirname, '../node_modules/@xterm/xterm/css')));
app.use('/vendor/xterm', express.static(path.join(dirname, '../node_modules/@xterm/xterm/lib')));
app.use('/vendor/fit', express.static(path.join(dirname, '../node_modules/@xterm/addon-fit/lib')));
app.use('/fonts/inter', express.static(path.join(dirname, '../node_modules/@fontsource-variable/inter')));
app.use('/fonts/noto-sans-sc', express.static(path.join(dirname, '../node_modules/@fontsource-variable/noto-sans-sc')));
app.use('/fonts/jetbrains-mono', express.static(path.join(dirname, '../node_modules/@fontsource-variable/jetbrains-mono')));

function authorized(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return false;
  const candidate = Buffer.from(header.slice(7));
  const expected = Buffer.from(accessToken);
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use('/api', (req, res, next) => authorized(req) ? next() : res.status(401).json({ error: '访问令牌无效' }));

app.get('/api/sessions', async (_req, res, next) => {
  try { res.json({ sessions: await listSessions() }); } catch (error) { next(error); }
});

app.post('/api/sessions', async (req, res, next) => {
  try {
    await createSession(req.body || {});
    res.status(201).json({ ok: true });
  } catch (error) { next(error); }
});

app.patch('/api/sessions/:name', async (req, res, next) => {
  try {
    await renameSession(req.params.name, req.body?.name);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.delete('/api/sessions/:name', async (req, res, next) => {
  try {
    await killSession(req.params.name);
    res.status(204).end();
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
  if (url.pathname !== '/ws' || !protocols.includes(`codeck.${websocketToken}`)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  const session = url.searchParams.get('session');
  if (!validateSessionName(session)) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, session));
});

wss.on('connection', (ws, session) => {
  const terminal = pty.spawn('tmux', ['attach-session', '-t', session], {
    name: 'xterm-256color', cols: 100, rows: 30, cwd: process.cwd(), env: process.env,
  });
  terminal.onData((data) => ws.readyState === ws.OPEN && ws.send(data));
  terminal.onExit(({ exitCode }) => ws.close(1000, `terminal exited (${exitCode})`));
  ws.on('message', (raw, binary) => {
    if (binary) return;
    try {
      const message = JSON.parse(raw.toString());
      if (message.type === 'input' && typeof message.data === 'string') terminal.write(message.data);
      if (message.type === 'resize' && Number.isInteger(message.cols) && Number.isInteger(message.rows)) {
        terminal.resize(Math.max(20, message.cols), Math.max(5, message.rows));
      }
    } catch { /* Ignore malformed terminal frames. */ }
  });
  ws.on('close', () => terminal.kill());
});

server.listen(port, host, () => {
  console.log(`Codeck is running at https://${host}:${port}`);
  if (tls.generated) console.log('TLS: using the persistent self-signed certificate in ~/.codeck');
  console.log(`Access token: ${accessToken}`);
});
