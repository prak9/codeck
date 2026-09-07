// Isolated real-browser journeys: serves the actual UI and fixture WebSocket/API.
// No owner credentials, real CLI writes, or project dependency installation.
// CODECK_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node scripts/remote-browser-smoke.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { normalizeSessionCommandOutput, sessionCommandCapabilities } from '../public/remote-command-output.js';

const { chromium } = await import(process.env.CODECK_PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const artifacts = await fs.mkdtemp(path.join(os.tmpdir(), 'codeck-remote-smoke-'));
console.log(`Browser artifacts: ${artifacts}`);
const providers = ['codex', 'claude', 'qodercli'];
let fixture;
const turn = n => ({ id: `turn-${n}`, status: 'completed', items: [
  { id: `user-${n}`, type: 'userMessage', content: [{ type: 'text', text: `问题 ${n}` }] },
  { id: `answer-${n}`, type: 'agentMessage', text: `回答 ${n}\n稳定的历史输出。\n第二行结果。` },
] });
function reset(provider) {
  fixture = { provider, turns: Array.from({ length: 80 }, (_, i) => turn(i + 1)),
    status: 'done', sequence: 0, epoch: 'fixture-epoch', sent: [], receivedDeliveryIds: [] };
}
function snapshot() {
  return { capabilities: { canManage: true }, sessions: [{ name: 'fixture', status: fixture.status,
    agent: { kind: fixture.provider, id: 'fixture-thread', name: 'Remote fixture' } }] };
}
function thread() {
  return { id: 'fixture-thread', provider: fixture.provider, readOnly: true, turns: fixture.turns.slice(-20),
    truncated: fixture.turns.length > 20, oldestTurnId: fixture.turns.at(-20)?.id,
    receivedDeliveryIds: fixture.receivedDeliveryIds };
}
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fixture');
  if (url.pathname === '/api/sessions') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(snapshot()));
    return;
  }
  if (url.pathname === '/api/uploads/files') {
    for await (const chunk of req) { /* consume synthetic attachment */ }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ path: '/fixture/report.txt' }));
    return;
  }
  const relative = url.pathname === '/remote' ? 'remote.html' : url.pathname.slice(1);
  const asset = relative.startsWith('fonts/inter/')
    ? path.join(root, 'node_modules/@fontsource-variable/inter', relative.slice(12))
    : relative.startsWith('fonts/noto-sans-sc/')
      ? path.join(root, 'node_modules/@fontsource-variable/noto-sans-sc', relative.slice(19))
      : path.resolve(root, 'public', relative);
  if (!asset.startsWith(root)) { res.writeHead(403).end(); return; }
  try {
    const data = await fs.readFile(asset);
    res.setHeader('Content-Type', mime[path.extname(asset)] || 'application/octet-stream');
    res.end(data);
  } catch { res.writeHead(404).end(); }
});
const sockets = new WebSocketServer({ server });
const send = (socket, value) => socket.readyState === 1 && socket.send(JSON.stringify(value));
function publishThread() {
  for (const socket of sockets.clients) send(socket, { type: 'threadSnapshot',
    target: { provider: fixture.provider, threadId: 'fixture-thread', tmuxSession: 'fixture' },
    stream: { epoch: fixture.epoch, sequence: ++fixture.sequence }, thread: thread() });
}
function publishSessions() {
  for (const socket of sockets.clients) send(socket, { type: 'sessionsSnapshot', snapshot: snapshot(),
    stream: { epoch: fixture.epoch, sequence: ++fixture.sequence } });
}
function publishEvent(method, params) {
  for (const socket of sockets.clients) send(socket, { type: 'event', provider: fixture.provider,
    tmuxSession: 'fixture', method, params: { threadId: 'fixture-thread', ...params } });
}
sockets.on('connection', socket => {
  send(socket, { type: 'ready', hostname: 'isolated-fixture', defaultCwd: '/fixture',
    protocol: { version: 1, epoch: fixture.epoch, commandReceiptTtlMs: 600_000 },
    providers: providers.map(id => ({ id, capabilities: { attachments: true, slashCommands: true, ...sessionCommandCapabilities(id) } })) });
  socket.on('message', raw => {
    const request = JSON.parse(raw);
    const reply = result => send(socket, { id: request.id, ok: true, result });
    if (request.type === 'openThread') return reply({ thread: thread() });
    if (request.type === 'loadThreadHistory') {
      const end = fixture.turns.findIndex(turn => turn.id === request.beforeTurnId);
      const start = Math.max(0, end - 20);
      return reply({ turns: fixture.turns.slice(start, end), truncated: start > 0, oldestTurnId: fixture.turns[start]?.id });
    }
    if (request.type === 'selectSessionModel') return reply({ completed: true });
    if (request.type === 'dismissSessionCommand') return reply({ dismissed: true });
    if (request.type === 'sendSessionMessage') {
      fixture.sent.push(request);
      if (request.text.startsWith('/')) {
        const terminalOutput = request.text === '/model'
          ? 'Select Model and Effort\n› 1. model-a (current)  Fast\n2. model-b  Deep'
          : `Fixture ${request.text}\nModel: fixture-model\nUsage: 10%`;
        return reply({ terminalOutput, commandOutput: normalizeSessionCommandOutput(fixture.provider, request.text, { terminalOutput }) });
      }
      const accepted = { id: `sent-${fixture.sent.length}`, status: 'completed', items: [
        { id: `sent-user-${fixture.sent.length}`, type: 'userMessage', content: [{ type: 'text', text: request.text }] },
        { id: `sent-answer-${fixture.sent.length}`, type: 'agentMessage', text: '已处理 fixture 消息' },
      ] };
      if (request.text === 'lost response') {
        fixture.turns.push(accepted);
        fixture.epoch = 'fixture-restarted';
        socket.close();
        return;
      }
      reply({ submissionStatus: 'unconfirmed', inputWasQueued: true });
      setTimeout(() => {
        fixture.turns.push(accepted);
        fixture.receivedDeliveryIds.push(request.commandId);
        publishThread();
      }, 100);
      return;
    }
    if (request.id != null) reply({});
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const viewport of [{ width: 390, height: 844 }, { width: 1365, height: 900 }]) {
    for (const provider of providers) {
      reset(provider);
      const context = await browser.newContext({ viewport, isMobile: viewport.width < 500,
        hasTouch: viewport.width < 500, reducedMotion: 'reduce', permissions: ['clipboard-read', 'clipboard-write'] });
      await context.addInitScript(theme => {
        localStorage.setItem('codeck-token', 'fixture-token');
        localStorage.setItem('codeck-remote-theme', theme);
      }, viewport.width < 500 ? 'dark' : 'light');
      const page = await context.newPage();
      page.setDefaultTimeout(15_000);
      console.log(`Journey: ${provider} ${viewport.width}`);
      const errors = [];
      page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
      await page.goto(`http://127.0.0.1:${server.address().port}/remote?session=fixture`);
      await page.waitForSelector('[data-turn-id="turn-80"]');
      await page.locator('#transcript').evaluate(node => { node.scrollTop = 0; });
      await page.getByRole('button', { name: '加载更早的对话' }).click();
      await page.waitForSelector('[data-turn-id="turn-41"]');
      await page.locator('#transcript').evaluate(node => { node.scrollTop = 100; });
      const before = await page.locator('#transcript').evaluate(node => node.scrollTop);
      fixture.turns.push(turn(81));
      publishThread();
      await page.waitForSelector('[data-turn-id="turn-81"]');
      assert.equal(await page.locator('[data-turn-id="turn-41"]').count(), 1);
      assert.ok(Math.abs(await page.locator('#transcript').evaluate(node => node.scrollTop) - before) < 3, 'refresh preserves reading position');
      await page.getByRole('button', { name: '直达最新消息' }).click();
      await page.waitForFunction(() => { const node = document.querySelector('#transcript'); return node.scrollHeight - node.scrollTop - node.clientHeight < 3; });
      await page.locator('#transcript').evaluate(node => { node.scrollTop -= 400; });
      assert.equal(await page.locator('[data-turn-id="turn-80"]').count(), 1);
      assert.equal(await page.locator('[data-turn-id="turn-81"]').count(), 1);

      const readingTop = await page.locator('#transcript').evaluate(node => node.scrollTop);
      const running = { ...turn(82), status: 'inProgress' };
      fixture.turns.push(running);
      const eventStart = performance.now();
      publishEvent('turn/started', { turn: running });
      await page.waitForSelector('[data-turn-id="turn-82"]');
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const eventRenderMs = Math.round(performance.now() - eventStart);
      assert.ok(Math.abs(await page.locator('#transcript').evaluate(node => node.scrollTop) - readingTop) < 3, 'new turn preserves reading position');
      running.status = 'completed';
      publishEvent('turn/completed', { turn: running });
      const failed = { id: 'failure-turn', status: 'failed', error: { message: 'Fixture model error', code: 'fixture' }, items: [] };
      fixture.turns.push(failed);
      publishThread();
      await page.waitForSelector('.turn-error');
      assert.match(await page.locator('.turn-error').last().textContent(), /Fixture model error/);
      assert.equal(await page.locator('[data-turn-id="turn-81"]').count(), 1, 'failure cannot erase history');
      await page.waitForFunction(() => document.querySelector('#composerStatus').textContent.includes('失败'));
      for (const socket of sockets.clients) send(socket, { type: 'approval', provider,
        tmuxSession: 'fixture', request: { id: 'fixture-approval', params: { threadId: 'fixture-thread', title: 'Fixture approval' } } });
      await page.waitForFunction(() => document.querySelector('#composerStatus').textContent.includes('等待你的确认'));
      await page.getByRole('button', { name: '允许一次', exact: true }).click();
      await page.waitForSelector('.approval-card', { state: 'detached' });

      fixture.status = 'background'; publishSessions();
      await page.waitForFunction(() => document.querySelector('#composerStatus').textContent.includes('后台任务'));
      for (const command of ['/status', '/usage', '/model']) {
        await page.locator('#composerInput').fill(command);
        await page.locator('#sendButton').click();
        await page.waitForSelector('#commandDialog[open]');
        if (command === '/model') assert.equal(await page.locator('.model-row').count(), provider === 'codex' ? 2 : 0);
        await page.screenshot({ path: path.join(artifacts, `${provider}-${viewport.width}-${command.slice(1)}.png`) });
        if (command === '/model' && provider === 'codex') await page.locator('.model-row').last().click();
        else await page.locator('#commandDialogClose').click();
        await page.waitForSelector('#commandDialog[open]', { state: 'detached' });
      }
      await page.locator('#composerInput').fill('消息确认');
      await page.locator('#sendButton').click();
      await page.waitForFunction(() => document.querySelector('#composerInput').value === '');
      assert.equal(await page.getByText('消息确认', { exact: true }).count(), 1);
      await page.locator('#attachmentFileInput').setInputFiles({ name: 'report.txt', mimeType: 'text/plain', buffer: Buffer.from('Fixture attachment') });
      await page.locator('#composerInput').fill('附件检查');
      await page.locator('#sendButton').click();
      await page.waitForFunction(() => document.querySelector('#composerInput').value === '');
      assert.equal(await page.locator('.attachment-item').count(), 0);
      assert.match(fixture.sent.at(-1).text, /\/fixture\/report.txt/);
      await page.getByRole('button', { name: '复制本轮模型输出' }).last().click();
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '已处理 fixture 消息');
      await page.locator('#composerInput').fill('lost response');
      await page.locator('#sendButton').click();
      await page.waitForFunction(() => document.querySelector('#composerInput').value === '');
      assert.equal(fixture.sent.filter(request => request.text === 'lost response').length, 1);
      assert.equal(await page.getByText('lost response', { exact: true }).count(), 1);
      await page.locator('#transcript').evaluate(node => { node.scrollTop = 0; });
      fixture.turns.push(...Array.from({ length: 40 }, (_, i) => turn(100 + i)));
      publishThread();
      await page.waitForSelector('[data-turn-id="turn-139"]');
      const readPosition = await page.locator('[data-turn-id="turn-41"]').boundingBox();
      await page.getByRole('button', { name: '加载更早的对话' }).click();
      await page.waitForSelector('[data-turn-id="turn-100"]');
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.ok(Math.abs((await page.locator('[data-turn-id="turn-41"]').boundingBox()).y - readPosition.y) < 3,
        'filling a reconnect gap below the viewport preserves the visible history');
      await page.getByRole('button', { name: '直达最新消息' }).click();
      if (viewport.width < 500) {
        await page.setViewportSize({ width: viewport.width, height: 420 });
        await page.locator('#composerInput').focus();
      }
      const geometry = await page.evaluate(() => ({
        width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth,
        inputBottom: document.querySelector('#composerInput').getBoundingClientRect().bottom,
        height: innerHeight,
      }));
      assert.ok(geometry.scrollWidth <= geometry.width + 1, 'no horizontal viewport overflow');
      assert.ok(geometry.inputBottom <= geometry.height, 'composer remains visible');
      assert.deepEqual(errors, []);
      await page.screenshot({ path: path.join(artifacts, `${provider}-${viewport.width}-conversation.png`) });
      results.push({ provider, viewport: viewport.width, eventRenderMs,
        journeys: 'history/latest/reading-position/reconnect-gap/background/failure/approval/commands/selection/attachment/copy/receipt/lost-response/restart/geometry', errors: 0 });
      await context.close();
    }
  }
  console.log(JSON.stringify({ artifacts, results }, null, 2));
} finally {
  await browser.close();
  for (const socket of sockets.clients) socket.terminate();
  await new Promise(resolve => sockets.close(resolve));
  await new Promise(resolve => server.close(resolve));
}
