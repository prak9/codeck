// Actual terminal page + AgentHub/controller, simulated CLI only. No live input.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { AgentHub, AgentRegistry } from '../src/agent-connection.js';
import { AutonomyController } from '../src/autonomy.js';
import { writeReceipt } from '../src/autonomy-receipt.js';
import { AUTONOMY_PLANNING_PROMPT, AUTONOMY_PROGRESS_PROMPT } from '../public/remote-autonomy.js';
const { chromium } = await import(process.env.CODECK_PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const artifacts = await fs.mkdtemp(path.join(os.tmpdir(), 'codeck-terminal-autonomy-'));
const simpleMode = true;
console.log(`Artifacts: ${artifacts}`);
let fixture;
function reset(provider) {
  fixture?.autonomy.close();
  const target = { provider, threadId: 'fixture-thread', tmuxSession: 'fixture' };
  const sessions = ['fixture', 'other'].map(name => ({ name, width: 100, height: 24, activityAt: Date.now(),
    agent: { kind: provider, id: name === 'fixture' ? target.threadId : 'other-thread', paneId: '%7' } }));
  const f = fixture = { target, sessions, sent: [], inputs: [], requests: [], turns: [], stops: 0, manualStops: [], agents: [], terminals: [], grids: [] };
  if (simpleMode) sessions[0].width = 37;
  const thread = () => ({ thread: { id: target.threadId, turns: f.turns } });
  const backend = new EventEmitter(); backend.openThread = async () => thread();
  f.autonomy = new AutonomyController({ schedule: () => 1, cancel() {},
    readSession: async t => sessions.find(s => s.name === t.tmuxSession),
    stop: async () => { f.stops++; sessions[0].hasRunningProcess = false; },
    send: async (_target, text) => {
      f.sent.push(text);
      const turn = { status: 'inProgress', items: [{ type: 'userMessage', content: text }] };
      f.turns.push(turn);
      return { submissionStatus: 'submitted' };
    },
  });
  f.hub = new AgentHub(new AgentRegistry({ [provider]: backend }, {
    sendTmuxMessage: async params => { f.inputs.push(params); return { submissionStatus: 'submitted' }; },
    interruptTmuxSession: async params => {
      f.manualStops.push(params);
      if (f.holdStop) await new Promise(resolve => { f.finishStop = resolve; });
      if (params.stopBackground && provider === 'claude') throw new Error('后台停止尚不支持，请在终端处理');
      sessions[0].hasRunningProcess = false;
      if (params.stopBackground) sessions[0].agent.hasBackgroundProcess = false;
    },
  }), { autonomy: f.autonomy });
}
const snapshot = () => ({ sessions: fixture.sessions, capabilities: { canManage: true, canWrite: !fixture.readOnly, terminalSubmit: true } });
const vendor = { '/vendor/xterm/xterm.js': '@xterm/xterm/lib/xterm.js', '/vendor/xterm.css': '@xterm/xterm/css/xterm.css',
  '/vendor/fit/addon-fit.js': '@xterm/addon-fit/lib/addon-fit.js',
  '/vendor/web-links/addon-web-links.js': '@xterm/addon-web-links/lib/addon-web-links.js',
  '/vendor/webgl/addon-webgl.js': '@xterm/addon-webgl/lib/addon-webgl.js' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fixture');
  if (url.pathname === '/api/sessions') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(snapshot())); }
  if (url.pathname.endsWith('/terminal-links')) { res.setHeader('Content-Type', 'application/json'); return res.end('{}'); }
  let asset = path.join(root, 'public', url.pathname === '/' ? 'index.html' : url.pathname);
  if (vendor[url.pathname]) asset = path.join(root, 'node_modules', vendor[url.pathname]);
  if (url.pathname.startsWith('/fonts/inter/')) asset = path.join(root, 'node_modules/@fontsource-variable/inter', url.pathname.slice(13));
  if (url.pathname.startsWith('/fonts/noto-sans-sc/')) asset = path.join(root, 'node_modules/@fontsource-variable/noto-sans-sc', url.pathname.slice(20));
  try { res.setHeader('Content-Type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[path.extname(asset)] || 'application/octet-stream'); res.end(await fs.readFile(asset)); }
  catch { res.writeHead(404).end(); }
});
const sockets = new WebSocketServer({ server });
sockets.on('connection', (socket, req) => {
  const f = fixture;
  if (req.url.startsWith('/agent')) {
    f.agents.push(socket);
    socket.on('message', raw => f.requests.push(JSON.parse(raw)));
    f.hub.handleConnection(socket, { streamVersion: 2 });
  } else {
    f.terminals.push(socket);
    const query = new URL(req.url, 'http://fixture').searchParams;
    f.grids.push(Number(query.get('cols')));
    socket.send('› fixture terminal\r\n');
    socket.on('message', raw => {
      const m = JSON.parse(raw);
      if (m.type === 'input') { f.inputs.push(m); if (m.inputId) socket.send(Buffer.from(JSON.stringify({ type: 'inputResult', inputId: m.inputId, ok: true }))); }
    });
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true });
try {
  for (const provider of ['codex', 'claude', 'qodercli']) for (const width of [390, 1365]) {
    reset(provider);
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.addInitScript(() => { localStorage.setItem('codeck-token', 'fixture'); localStorage.setItem('codeck-local-input', '1'); });
    const page = await context.newPage(); const errors = [];
    page.on('pageerror', e => { errors.push(e.message); console.error(e.message); });
    page.on('response', r => { if (r.status() >= 400) console.error(r.status(), r.url()); });
    page.setDefaultTimeout(5000);
    await page.goto(`http://127.0.0.1:${server.address().port}/?session=fixture${simpleMode ? '&view=readable' : ''}`);
    const a = page.locator('#terminalAutonomyButton');
    try { await a.waitFor({ state: 'visible' }); }
    catch (error) { console.error(await page.locator('body').innerText(), fixture.requests); throw error; }
    if (simpleMode) {
      fixture.sessions[0].hasRunningProcess = true;
      await page.locator('#terminalVoiceDraft').fill('尚未发送的草稿');
      await a.click();
      await page.waitForFunction(() => document.querySelector('#terminalAutonomyButton').getAttribute('aria-busy') === 'false');
      const planned = fixture.inputs.filter(input => input.text?.startsWith(AUTONOMY_PLANNING_PROMPT));
      assert.equal(planned.length, 1); assert.equal(planned[0].nonInterrupting, true);
      assert.equal(fixture.stops, 0); assert.equal(fixture.sent.length, 0);
      assert.equal(fixture.autonomy.snapshot(fixture.target).status, 'planning');
      assert.equal(await page.locator('#terminalAutonomyDialog').count(), 0);
      assert.equal(await page.locator('#terminalVoiceDraft').inputValue(), '尚未发送的草稿');
      assert.ok(width > 720 ? fixture.grids[0] > 80 : fixture.grids[0] < 60, 'grid follows the viewport');
      assert.equal(await a.getAttribute('aria-pressed'), 'false', 'planning is not execution');
      await page.locator('#terminalProgressButton').click();
      await page.waitForFunction(() => document.querySelector('#terminalProgressButton').getAttribute('aria-busy') === 'false');
      assert.ok(fixture.inputs.some(input => input.text === AUTONOMY_PROGRESS_PROMPT));
      const confirm = page.locator('#terminalConfirmButton');
      await confirm.focus(); await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('#terminalConfirmButton').getAttribute('aria-busy') === 'false');
      assert.equal(fixture.inputs.filter(input => input.text === 'OK').length, 1);
      assert.equal(await page.locator('#terminalVoiceDraft').inputValue(), '尚未发送的草稿');
      const confirmBox = await confirm.boundingBox();
      assert.ok(confirmBox.width >= 44 && confirmBox.height >= 44 && confirmBox.x + confirmBox.width <= width);
      await page.locator('#terminalVoiceDraft').fill('按此计划开始');
      await page.locator('#sendTerminalVoiceButton').click();
      await page.waitForFunction(() => document.querySelector('#terminalVoiceDraft').value === '');
      assert.ok(fixture.inputs.some(input => input.text === '按此计划开始'));
      assert.equal(fixture.autonomy.snapshot(fixture.target).status, 'planning', 'confirmation text alone does not turn A yellow');
      const observed = fixture.autonomy.runs.values().next().value;
      writeReceipt(['--receipt', observed.observation.startFile, '--status', 'started', '--goal', '修复输入', '--summary', '用户确认开始']);
      await fixture.autonomy.tick();
      await page.waitForFunction(() => document.querySelector('#terminalAutonomyButton').dataset.tone === 'running');
      assert.equal(await a.locator('.terminal-autonomy-symbol').evaluate(el => getComputedStyle(el).borderTopColor), 'rgb(234, 179, 8)');
      writeReceipt(['--receipt', observed.observation.endFile, '--status', 'completed', '--summary', '目标已验证完成', '--next', '无需后续工作', '--evidence', 'fixture.log 回归通过', '--version', 'abc123', '--verification', '回归通过']);
      await fixture.autonomy.tick();
      await page.waitForFunction(() => document.querySelector('#terminalAutonomyButton').dataset.tone === 'completed');
      assert.equal(await a.evaluate(el => el.parentElement.nextElementSibling.id), 'shareButton');
      assert.deepEqual(await a.evaluate(el => [...el.parentElement.children].map(button => button.id)),
        ['terminalProgressButton', 'terminalConfirmButton', 'terminalAutonomyButton']);
      const groupBox = await a.locator('..').boundingBox();
      const titleBox = await page.locator('#terminalTitle').boundingBox();
      assert.ok(groupBox.x > titleBox.x && groupBox.x + groupBox.width <= width, 'shortcut group is right-aligned without clipping');
      await page.screenshot({ path: path.join(artifacts, provider + '-' + width + '-planning-shortcut.png') });
      await page.reload(); await a.waitFor({ state: 'visible' });
      await page.waitForFunction(() => !document.querySelector('#terminalAutonomyButton').disabled);
      assert.equal(fixture.inputs.filter(input => input.text?.startsWith(AUTONOMY_PLANNING_PROMPT)).length, 1, 'reconnect never resends');
      assert.equal(await a.getAttribute('data-tone'), 'completed', 'green survives reconnect');
      await a.click(); await page.waitForFunction(() => document.querySelector('#terminalAutonomyButton').dataset.tone === 'idle');
      assert.equal(fixture.inputs.filter(input => input.text?.startsWith(AUTONOMY_PLANNING_PROMPT)).length, 1, 'first click only resets');
      await a.click(); await page.waitForFunction(() => document.querySelector('#terminalAutonomyButton').getAttribute('aria-busy') === 'false');
      assert.equal(fixture.inputs.filter(input => input.text?.startsWith(AUTONOMY_PLANNING_PROMPT)).length, 2, 'next click plans again');
      assert.equal(await page.locator('dialog[open]').count(), 0);
      assert.equal(fixture.requests.some(request => ['startAutonomy', 'answerAutonomy'].includes(request.type)), false);
      assert.deepEqual(errors, []); await context.close();
      console.log('PASS planning shortcut ' + provider + ' ' + width + ': send once, draft, confirmation, progress, reconnect');
      continue;
    }

  }
} finally {
  fixture?.autonomy.close(); await browser.close();
  for (const socket of sockets.clients) socket.terminate();
  await new Promise(resolve => sockets.close(resolve)); await new Promise(resolve => server.close(resolve));
}
