// Real terminal UI with isolated PTYs: switch, stale frames and network recovery; no real session input.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { handleTerminalConnection } from '../src/terminal-connection.js';
const { chromium } = await import(process.env.CODECK_PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const artifacts = await fs.mkdtemp(path.join(os.tmpdir(), 'codeck-services-browser-'));
let enabled = true;
const readNotices = [];
const vendors = { '/vendor/xterm/xterm.js': '@xterm/xterm/lib/xterm.js', '/vendor/xterm.css': '@xterm/xterm/css/xterm.css',
  '/vendor/fit/addon-fit.js': '@xterm/addon-fit/lib/addon-fit.js', '/vendor/webgl/addon-webgl.js': '@xterm/addon-webgl/lib/addon-webgl.js',
  '/vendor/web-links/addon-web-links.js': '@xterm/addon-web-links/lib/addon-web-links.js' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fixture');
  if (url.pathname.endsWith('/attention/read')) { let body = ''; for await (const part of req) body += part; readNotices.push(JSON.parse(body)); res.writeHead(204).end(); return; }
  if (url.pathname === '/api/services/telegram') {
    let body = ''; for await (const chunk of req) body += chunk;
    enabled = JSON.parse(body).enabled; res.setHeader('Content-Type', 'application/json'); return res.end('{}');
  }
  if (url.pathname === '/api/services') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ telegram: { configured: true, status: enabled ? 'connected' : 'disabled' } })); }
  if (url.pathname === '/api/sessions') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ sessions: [{ name: 'first', status: 'done', activityAt: Date.now(), checkpoint: { text: '已复现，正在验证', updatedAt: '2026-11-07T10:00:00Z', attention: { id: 'notice-1', kind: 'ended' } } }, { name: 'second', status: 'done', activityAt: Date.now() }], capabilities: { canManage: true, canWrite: true, canSwitchSession: true } })); }
  let file = path.join(root, 'public', url.pathname === '/' ? 'index.html' : url.pathname);
  if (vendors[url.pathname]) file = path.join(root, 'node_modules', vendors[url.pathname]);
  if (url.pathname.startsWith('/fonts/inter/')) file = path.join(root, 'node_modules/@fontsource-variable/inter', url.pathname.slice(13));
  if (url.pathname.startsWith('/fonts/noto-sans-sc/')) file = path.join(root, 'node_modules/@fontsource-variable/noto-sans-sc', url.pathname.slice(20));
  try { res.setHeader('Content-Type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[path.extname(file)] || 'application/octet-stream'); res.end(await fs.readFile(file)); }
  catch { res.writeHead(404).end(); }
});
const wss = new WebSocketServer({ server });
const terminalSockets = [], input = [];
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://fixture');
  if (url.pathname !== '/ws') { ws.send(JSON.stringify({ type: 'ready', providers: [] })); return; }
  terminalSockets.push(ws);
  void handleTerminalConnection(ws, url.searchParams.get('session'), { width: Number(url.searchParams.get('cols')), height: Number(url.searchParams.get('rows')) }, {
    canSwitchSession: true, outputFlowControl: true, outputFlowId: url.searchParams.get('flowId'), outputProtocol: 1,
    getLinkedWindowSessions: async () => [], preferLatestClientSize: async () => true,
    clampViewport: (cols, rows) => [cols, rows],
    submitTerminalInput: async (name, data) => input.push({ name, data }),
    writeTerminalInput: async (name, data) => input.push({ name, data }),
    scrollSession: async () => {},
    createTerminal: name => {
      let timer;
      return { onData(callback) { timer = setTimeout(() => callback('SCREEN:' + name + '\r\n$ '), 20); },
        onExit() {}, write() {}, resize() {}, kill() { clearTimeout(timer); } };
    },
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [390, 1365]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.addInitScript(() => {
      localStorage.setItem('codeck-token', 'fixture');
      let constructor;
      Object.defineProperty(window, 'Terminal', { configurable: true,
        get() { return constructor; },
        set(value) { constructor = new Proxy(value, { construct(target, args) {
          const terminal = new target(...args); window.fixtureTerminal = terminal; return terminal;
        } }); },
      });
    });
    const page = await context.newPage(); const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const screen = async name => page.waitForFunction(name => {
      const terminal = window.fixtureTerminal;
      if (!terminal) return false;
      return Array.from({ length: terminal.buffer.active.length }, (_, i) => terminal.buffer.active.getLine(i)?.translateToString(true)).join('\n').includes('SCREEN:' + name);
    }, name);
    await page.getByText('● 本轮有新结果 · 已复现，正在验证', { exact: true }).waitFor({ state: 'attached' });
    await page.locator('[data-session="first"]').evaluate(el => el.click());
    await screen('first');
    assert.equal(readNotices.at(-1)?.id, 'notice-1');
    const socket = terminalSockets.at(-1);
    await page.locator('[data-session="second"]').evaluate(el => el.click());
    await screen('second');
    // An old clear-screen frame must not unlock an old stream after switching.
    socket.send(Buffer.from(JSON.stringify({ type: 'terminalOutput', flowId: '1', epoch: 999, seq: 2, data: '\x1bc', reset: true })));
    socket.send(Buffer.from(JSON.stringify({ type: 'terminalOutput', flowId: '1', epoch: 999, seq: 7, data: 'STALE' })));
    const before = terminalSockets.length;
    socket.terminate();
    await new Promise(resolve => { const poll = setInterval(() => { if (terminalSockets.length > before) { clearInterval(poll); resolve(); } }, 50); setTimeout(() => { clearInterval(poll); resolve(); }, 5000).unref(); });
    await page.waitForFunction(() => document.querySelector('#terminalDisconnect').hidden, null, { timeout: 15000 });
    await screen('second');
    assert.ok(terminalSockets.length > before, 'new transport established');
    const text = await page.evaluate(() => Array.from({ length: fixtureTerminal.buffer.active.length }, (_, i) => fixtureTerminal.buffer.active.getLine(i)?.translateToString(true)).join('\n'));
    assert.ok(!text.includes('STALE'));
    assert.equal(input.length, 0, 'recovery never injects user input');
    await page.screenshot({ path: path.join(artifacts, `${width}-recovery.png`) });
    assert.deepEqual(errors, []); await context.close();
    console.log(`PASS ${width}: identified output, session switch, stale reset rejected, disconnect recovery without input replay`);
  }
  console.log(`Artifacts: ${artifacts}`);
} finally { await browser.close(); for (const client of wss.clients) client.terminate(); wss.close(); await new Promise(resolve => server.close(resolve)); }
