// Actual terminal page + AgentHub/controller, simulated CLI only. No live input.
import assert from 'node:assert/strict';
import { CONTINUE_PROMPT } from '../public/continue-prompt.js';
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
import { AUTONOMY_PROGRESS_PROMPT, AUTONOMY_PLANNING_PROMPT, AUTONOMY_CONFIRM_PROMPT } from '../public/remote-autonomy.js';
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
  sessions[0].checkpoint = { text: '已建立基线', updatedAt: '2026-11-10T10:00:00Z', taskId: 'demo', progress: { goal: '修复断线后的输入与翻页', verified: '基线已复现', current: '浏览器回归中', next: '通过后部署', needsUser: '是否接受较高计算成本验证候选？', evidence: [{ label: '验证页面', url: '/pages/example', version: 'fixture' }] } };
  const f = fixture = { target, sessions, sent: [], inputs: [], requests: [], turns: [], stops: 0, manualStops: [], agents: [], terminals: [], grids: [] };
  if (simpleMode) sessions[0].width = 37;
  const thread = () => ({ thread: { id: target.threadId, turns: f.turns } });
  const backend = new EventEmitter(); backend.openThread = async () => thread();
  f.autonomy = new AutonomyController({ schedule: () => 1, cancel() {},
    readSession: async t => sessions.find(s => s.name === t.tmuxSession),
    stop: async () => { f.stops++; sessions[0].hasRunningProcess = false; },
    send: async (_target, text) => {
      f.sent.push(text);
      const run = [...f.autonomy.runs.values()][0];
      if (run?.cleanupPending) writeReceipt(['--receipt', run.cleanupFile, '--status', 'stopped', '--summary', 'cleaned', '--evidence', 'verified resources', '--next', 'none']);
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
async function readyPlan() {
  const run = [...fixture.autonomy.runs.values()][0];
  writeReceipt(['--receipt', run.observation.planFile, '--status', 'planned', '--goal', '修复输入', '--summary', '验证输入']);
  await fixture.autonomy.tick();
}
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
      if (m.type === 'ping' && !f.dropPongs) socket.send(Buffer.from(JSON.stringify({ type: 'pong', id: m.id })));
      if (m.type === 'scroll') f.scrolls = (f.scrolls || 0) + 1;
      if (m.type === 'transcriptClick') (f.transcriptClicks ||= []).push(m);
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
    await page.locator('#terminalProgressButton').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#terminalAutonomyButton').count(), 0);
    await page.locator('#sessionProgress summary').click();
    assert.equal(await page.locator('#sessionProgress details').evaluate(el => el.open), true);
    await page.getByRole('button', { name: '回到对话回答', exact: true }).click();
    assert.equal(await page.locator('#sessionProgress a').getAttribute('href'), '/pages/example');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.locator('#terminalVoiceDraft').fill('保留我的草稿');
    await page.locator('#terminalProgressButton').click();
    await page.waitForFunction(() => document.querySelector('#terminalProgressButton').getAttribute('aria-busy') === 'false');
    assert.equal(fixture.inputs.at(-1).text, AUTONOMY_PROGRESS_PROMPT);
    await page.locator('#terminalContinueButton').click();
    await page.waitForFunction(() => document.querySelector('#terminalContinueButton').getAttribute('aria-busy') === 'false');
    assert.equal(fixture.inputs.at(-1).text, CONTINUE_PROMPT);
    assert.equal(await page.locator('#terminalVoiceDraft').inputValue(), '保留我的草稿');
    assert.equal(fixture.stops, 0);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(artifacts, provider + '-' + width + '-progress-shortcuts.png') });
    await context.close();
    console.log('PASS progress/continue/no-A ' + provider + ' ' + width);

  }
} finally {
  fixture?.autonomy.close(); await browser.close();
  for (const socket of sockets.clients) socket.terminate();
  await new Promise(resolve => sockets.close(resolve)); await new Promise(resolve => server.close(resolve));
}
