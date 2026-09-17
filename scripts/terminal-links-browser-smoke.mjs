// Real xterm and addon, isolated tmux server; never attaches to user sessions.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pty from 'node-pty';
import { createTerminalHistoryLinkReader } from '../src/terminal-history-links.js';

const { chromium } = await import(process.env.CODECK_PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
let readHistoryLinks = async () => ({ urls: [] });
const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://fixture').pathname;
  if (pathname === '/history') {
    res.setHeader('Content-Type', 'application/json');
    try { return res.end(JSON.stringify(await readHistoryLinks('links'))); }
    catch { return res.writeHead(500).end('{}'); }
  }
  if (pathname === '/') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end('<link rel="stylesheet" href="/xterm.css"><div id="terminal"></div><script src="/xterm.js"></script><script src="/links.js"></script>');
  }
  const assets = {
    '/xterm.css': 'node_modules/@xterm/xterm/css/xterm.css',
    '/xterm.js': 'node_modules/@xterm/xterm/lib/xterm.js',
    '/links.js': 'node_modules/@xterm/addon-web-links/lib/addon-web-links.js',
    '/terminal-links.js': 'public/terminal-links.js',
    '/terminal-history-links.js': 'public/terminal-history-links.js',
  };
  if (!assets[pathname]) return res.writeHead(404).end();
  try {
    res.setHeader('Content-Type', pathname.endsWith('.css') ? 'text/css' : 'text/javascript');
    res.end(await fs.readFile(path.join(root, assets[pathname])));
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true });
const socket = `codeck-links-test-${process.pid}`;
let attached;
try {
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  await context.route('https://example.com/**', route => route.fulfill({ body: 'link target' }));
  await context.route('http://example.com/**', route => route.fulfill({ body: 'link target' }));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.evaluate(async () => {
    const { enableTerminalLinks } = await import('/terminal-links.js');
    window.term = new Terminal({ cols: 60, rows: 12, fontSize: 16 });
    term.open(document.querySelector('#terminal'));
    enableTerminalLinks(term, {
      getContext: () => ({ session: 'links' }),
      readHistoryLinks: () => fetch('/history').then(response => response.json()),
    });
    window.input = [];
    term.onData(data => input.push(data));
  });
  const write = data => page.evaluate(data => new Promise(resolve => term.write(data, resolve)), data);
  const point = (col, row) => page.evaluate(({ col, row }) => {
    const rect = document.querySelector('.xterm-screen').getBoundingClientRect();
    return { x: rect.x + (col + 0.5) * rect.width / term.cols, y: rect.y + (row + 0.5) * rect.height / term.rows };
  }, { col, row });
  async function clickLink(col, row, expected) {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const pos = await point(col, row);
    const outsideLink = await point(50, 10);
    await page.mouse.move(outsideLink.x, outsideLink.y);
    await page.mouse.move(pos.x, pos.y);
    await page.waitForFunction(() => document.querySelector('.xterm-cursor-pointer'), null, { timeout: 5000 });
    const popupPromise = page.waitForEvent('popup');
    await page.mouse.click(pos.x, pos.y);
    const popup = await popupPromise;
    await popup.waitForURL(expected);
    assert.equal(await popup.evaluate(() => window.opener), null);
    await popup.close();
  }
  const long = 'https://example.com/path/' + 'segment/'.repeat(12) + '?a=1&b=two%20words#details';
  await write(`http://example.com/plain?q=one#part\r\n[查看详情](https://example.com/detail?a=1&b=2#section)\r\n${long}\r\n`);
  await clickLink(5, 0, 'http://example.com/plain?q=one#part');
  await clickLink(16, 1, 'https://example.com/detail?a=1&b=2#section');
  await clickLink(5, 3, long);
  assert.deepEqual(await page.evaluate(() => input), [], 'clicks must not send terminal input');

  // A drag across a URL must select text, not activate a new tab.
  const start = await point(0, 0);
  const end = await point(25, 0);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 12 });
  await page.mouse.up();
  assert.match(await page.evaluate(() => term.getSelection()), /^http:\/\/example/);
  assert.equal(context.pages().length, 1);
  await page.keyboard.press('Control+c');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), await page.evaluate(() => term.getSelection()));
  await page.evaluate(() => { term.clearSelection(); term.focus(); input.length = 0; });
  await page.keyboard.type('test');
  assert.equal(await page.evaluate(() => input.join('')), 'test');
  await write('\r\n'.repeat(20));
  await page.evaluate(() => term.scrollToTop());
  await clickLink(5, 0, 'http://example.com/plain?q=one#part');
  console.log('PASS plain/Markdown/wrapped/history links, no-Ctrl click, selection/copy/input');

  // Test the actual tmux redraw stream, not only xterm soft-wrap fixtures.
  const env = { ...process.env }; delete env.TMUX; delete env.TMUX_PANE;
  readHistoryLinks = createTerminalHistoryLinkReader({
    execTmux: args => promisify(execFile)('tmux', ['-L', socket, ...args], { env }),
  });
  let output = '';
  attached = pty.spawn('tmux', ['-L', socket, '-f', '/dev/null', 'new-session', '-s', 'links',
    process.execPath, '-e', `console.log('http://example.com/old'); console.log(${JSON.stringify(long)}); process.stdin.on('data', () => console.log(String.fromCharCode(10).repeat(20))); setInterval(() => {}, 1000)`],
  { name: 'xterm-256color', cols: 60, rows: 12, env });
  attached.onData(data => { output += data; });
  const deadline = Date.now() + 5000;
  while (!output.includes('example.com') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(output.includes('example.com'), 'isolated tmux fixture started');
  await page.evaluate(() => term.reset());
  await write(output);
  await clickLink(5, 2, long);
  output = '';
  execFileSync('tmux', ['-L', socket, 'refresh-client', '-S'], { env });
  await new Promise(resolve => setTimeout(resolve, 100));
  await write(output);
  await clickLink(5, 2, long);
  output = '';
  execFileSync('tmux', ['-L', socket, 'send-keys', '-t', 'links', 'Enter'], { env });
  await new Promise(resolve => setTimeout(resolve, 150));
  await write(output);
  output = '';
  execFileSync('tmux', ['-L', socket, 'copy-mode', '-t', 'links', ';', 'send-keys', '-t', 'links', '-X', 'history-top'], { env });
  await new Promise(resolve => setTimeout(resolve, 100));
  await write(output);
  await clickLink(5, 0, 'http://example.com/old');
  await clickLink(5, 2, long);
  assert.deepEqual(errors, []);
  console.log('PASS isolated tmux wrapped URL, redraw and multi-row copy-mode history');
} finally {
  if (attached) {
    execFileSync('tmux', ['-L', socket, 'kill-server']);
    attached.kill();
  }
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
