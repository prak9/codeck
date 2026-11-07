// Real settings UI with isolated HTTP/terminal fixtures; no real session input.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
const { chromium } = await import(process.env.CODECK_PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const artifacts = await fs.mkdtemp(path.join(os.tmpdir(), 'codeck-services-browser-'));
let enabled = true;
const vendors = { '/vendor/xterm/xterm.js': '@xterm/xterm/lib/xterm.js', '/vendor/xterm.css': '@xterm/xterm/css/xterm.css',
  '/vendor/fit/addon-fit.js': '@xterm/addon-fit/lib/addon-fit.js', '/vendor/webgl/addon-webgl.js': '@xterm/addon-webgl/lib/addon-webgl.js',
  '/vendor/web-links/addon-web-links.js': '@xterm/addon-web-links/lib/addon-web-links.js' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fixture');
  if (url.pathname === '/api/services/telegram') {
    let body = ''; for await (const chunk of req) body += chunk;
    enabled = JSON.parse(body).enabled; res.setHeader('Content-Type', 'application/json'); return res.end('{}');
  }
  if (url.pathname === '/api/services') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ telegram: { configured: true, status: enabled ? 'connected' : 'disabled' } })); }
  if (url.pathname === '/api/sessions') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ sessions: [], capabilities: { canManage: true, canWrite: true } })); }
  let file = path.join(root, 'public', url.pathname === '/' ? 'index.html' : url.pathname);
  if (vendors[url.pathname]) file = path.join(root, 'node_modules', vendors[url.pathname]);
  if (url.pathname.startsWith('/fonts/inter/')) file = path.join(root, 'node_modules/@fontsource-variable/inter', url.pathname.slice(13));
  if (url.pathname.startsWith('/fonts/noto-sans-sc/')) file = path.join(root, 'node_modules/@fontsource-variable/noto-sans-sc', url.pathname.slice(20));
  try { res.setHeader('Content-Type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[path.extname(file)] || 'application/octet-stream'); res.end(await fs.readFile(file)); }
  catch { res.writeHead(404).end(); }
});
const wss = new WebSocketServer({ server });
wss.on('connection', ws => ws.send(JSON.stringify({ type: 'ready', providers: [] })));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [390, 1365]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.addInitScript(() => localStorage.setItem('codeck-token', 'fixture'));
    const page = await context.newPage(); const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.locator('#settingsButton').evaluate(el => el.click());
    await page.locator('#backgroundServices summary').click();
    await page.waitForFunction(() => document.querySelector('#telegramServiceStatus').textContent === '已连接');
    await page.locator('#telegramServiceToggle').uncheck();
    await page.waitForFunction(() => document.querySelector('#telegramServiceStatus').textContent === '已关闭');
    assert.equal(enabled, false);
    await page.locator('#telegramServiceToggle').check();
    await page.waitForFunction(() => document.querySelector('#telegramServiceStatus').textContent === '已连接');
    assert.equal(await page.locator('#controlEntry').count(), 0);
    assert.ok(await page.locator('#settingsDialog').evaluate(e => e.scrollWidth <= e.clientWidth));
    await page.screenshot({ path: path.join(artifacts, `${width}-services.png`) });
    assert.deepEqual(errors, []); await context.close();
    console.log(`PASS ${width}: service status, off/on, no control entry, no overflow/errors`);
  }
  console.log(`Artifacts: ${artifacts}`);
} finally { await browser.close(); for (const client of wss.clients) client.terminate(); wss.close(); await new Promise(resolve => server.close(resolve)); }
