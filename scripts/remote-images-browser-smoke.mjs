// Actual Remote UI, isolated API/WebSocket fixtures; no real CLI messages.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { WebSocketServer } from 'ws';
import { createAgentImages } from '../src/agent-images.js';

const { chromium } = await import(process.env.CODECK_PLAYWRIGHT_MODULE || 'playwright');
const artifacts = await fs.mkdtemp(path.join(os.tmpdir(), 'codeck-remote-images-'));
const imagePath = process.env.CODECK_TEST_IMAGE || path.join(artifacts, 'chart.png');
if (!process.env.CODECK_TEST_IMAGE) await fs.writeFile(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4h8AAAAASUVORK5CYII=', 'base64'));
const images = createAgentImages('fixture-secret');
const oldImagePath = path.join(artifacts, 'history.png');
await fs.copyFile(imagePath, oldImagePath);
const app = express();
const sessions = { capabilities: { canManage: true }, sessions: [{ name: 'fixture', status: 'done', agent: { kind: 'codex', id: 'thread', name: '图片展示测试' } }] };
let imageRequests = 0;
let oldImageRequests = 0;
let failImage = false;
const authorized = (req, res, next) => req.headers.authorization === 'Bearer fixture-token' ? next() : res.sendStatus(401);
app.get('/api/sessions', (_req, res) => res.json(sessions));
app.get('/api/agent-images/:token', authorized, (req, res) => {
  imageRequests += 1;
  if (Buffer.from(req.params.token.split('.')[0], 'base64url').toString() === oldImagePath) oldImageRequests += 1;
  return failImage ? res.sendStatus(404) : images.serve(req, res);
});
app.get('/api/agent-turn-images', authorized, async (req, res) => {
  await new Promise(resolve => setTimeout(resolve, 400));
  res.json({ images: req.query.turnId === 'view-only' ? images.describe([{ path: imagePath, alt: 'MC模拟次数与盈利估计误差曲线' }]) : [] });
});
app.use('/fonts/inter', express.static('node_modules/@fontsource-variable/inter'));
app.use('/fonts/noto-sans-sc', express.static('node_modules/@fontsource-variable/noto-sans-sc'));
app.get('/remote', (_req, res) => res.sendFile(path.resolve('public/remote.html')));
app.use(express.static('public'));
const server = http.createServer(app);
const sockets = new WebSocketServer({ server });
let turns;
const thread = () => images.decorate({ id: 'thread', readOnly: true, turns });
sockets.on('connection', socket => {
  socket.send(JSON.stringify({ type: 'ready', hostname: '图片回归测试', protocol: { version: 1, epoch: 'images' }, providers: [{ id: 'codex', capabilities: { turnImages: true } }] }));
  socket.on('message', raw => {
    const request = JSON.parse(raw);
    assert.notEqual(request.type, 'sendSessionMessage', 'image interaction must not send CLI input');
    socket.send(JSON.stringify({ id: request.id, ok: true, result: { thread: thread() } }));
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [390, 1365]) for (const theme of ['light', 'dark']) {
    turns = [
      { id: 'old-image', status: 'completed', items: [{ type: 'agentMessage', id: 'old', text: `![历史图表](${oldImagePath})` }] },
      { id: 'spacer', status: 'completed', items: [{ type: 'agentMessage', id: 'text', text: '历史文字内容\n'.repeat(100) }] },
      { id: 'markdown', status: 'completed', items: [{ type: 'agentMessage', id: 'markdown-image', text: `蓝线：固定前N次模拟的盈利估计误差。\n![MC次数与盈利估计误差](${imagePath})\n橙线：各组误差的平均值。` }] },
      { id: 'view-only', status: 'completed', items: [{ type: 'userMessage', id: 'user', content: [{ type: 'text', text: '直接渲染出来' }] }, { type: 'agentMessage', id: 'empty', text: '' }] },
    ];
    const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 500, hasTouch: width < 500 });
    await context.addInitScript(theme => {
      localStorage.setItem('codeck-token', 'fixture-token');
      localStorage.setItem('codeck-remote-theme', theme);
    }, theme);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    imageRequests = 0;
    oldImageRequests = 0;
    await page.goto(`${origin}/remote?session=fixture`);
    await page.locator('#composerInput').fill('图片加载时仍可输入');
    await page.waitForFunction(() => {
      const image = document.querySelector('[data-turn-id="view-only"] .remote-image img');
      return image?.naturalWidth > 0 && !image.hidden;
    });
    assert.equal(await page.inputValue('#composerInput'), '图片加载时仍可输入');
    assert.equal(oldImageRequests, 0, 'offscreen history images remain unloaded');
    const bounds = await page.locator('[data-turn-id="view-only"] .remote-image-stage').boundingBox();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width);
    await page.screenshot({ path: path.join(artifacts, `${width}-${theme}.png`) });
    await page.locator('[data-turn-id="view-only"] .remote-image-stage').click();
    await page.locator('.remote-image-dialog').waitFor({ state: 'visible' });
    assert.ok(await page.locator('.remote-image-full').evaluate(image => image.naturalWidth > 0));
    await page.screenshot({ path: path.join(artifacts, `${width}-${theme}-zoom.png`) });
    await page.keyboard.press('Escape');
    await page.locator('.remote-image-dialog').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('.remote-image-stage:focus').count(), 1, 'focus returns to thumbnail');
    // Historical image lazily loads, without losing its message text.
    await page.locator('#transcript').evaluate(node => { node.scrollTop = 0; });
    await page.waitForFunction(() => document.querySelector('[data-turn-id="old-image"] img')?.naturalWidth > 0);
    await page.locator('#transcript').evaluate(node => { node.scrollTop = 800; });
    await page.waitForTimeout(200);
    assert.equal(await page.locator('[data-turn-id="old-image"] img').getAttribute('src'), null, 'offscreen resources are released');
    // Failure is recoverable via the same control; no blank broken image.
    failImage = true;
    await page.locator('#transcript').evaluate(node => { node.scrollTop = 0; });
    await page.waitForFunction(() => document.querySelector('[data-turn-id="old-image"] .remote-image-status')?.textContent.includes('重试'));
    failImage = false;
    await page.locator('[data-turn-id="old-image"] .remote-image-stage').click();
    await page.waitForFunction(() => document.querySelector('[data-turn-id="old-image"] img')?.naturalWidth > 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`PASS ${width} ${theme}: inline/tool-only/history/lazy/retry/zoom/focus/composer`);
  }
  console.log(`Screenshots: ${artifacts}`);
} finally {
  await browser.close();
  for (const socket of sockets.clients) socket.terminate();
  await new Promise(resolve => sockets.close(resolve));
  await new Promise(resolve => server.close(resolve));
}
