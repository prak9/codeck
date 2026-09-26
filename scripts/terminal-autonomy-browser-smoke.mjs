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
    suggestDefinition: async () => ({ fieldsVersion: 5, goal: '修复终端宽度恢复并验证回归。先复现切换，再修复尺寸同步，在手机和桌面间验证；不重启真实会话。' }),
    readSession: async t => sessions.find(s => s.name === t.tmuxSession), readThread: async () => thread(),
    stop: async () => { f.stops++; sessions[0].hasRunningProcess = false; },
    send: async (_target, text) => {
      f.sent.push(text);
      const nonce = /"nonce":"([^"]+)"/.exec(text)[1];
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
      const dialog = page.locator('#terminalAutonomyDialog');
      fixture.sessions[0].hasRunningProcess = true;
      fixture.turns.push({ status: 'completed', items: [
        { type: 'userMessage', content: '制定下一阶段目标' },
        { type: 'agentMessage', text: '## 问题定义\n桌面保留了手机宽度。\n## 下一阶段目标\n\n修复终端宽度恢复并验证回归。\n\n### 策略\n先复现切换，再修复尺寸同步。\n### 验收方法\n在手机和桌面间切换，宽度恢复。\n### 预算轮次\n5轮 / 30分钟\n### 其他\n不重启真实会话。' },
      ] });
      await a.click(); await dialog.getByRole('heading', { name: '确认自主任务' }).waitFor();
      assert.equal(await dialog.getByRole('textbox').count(), 1);
      await page.waitForFunction(() => document.querySelector('.autonomy-definition textarea')?.value.includes('修复终端宽度恢复'));
      assert.equal(fixture.sent.length, 0); assert.equal(fixture.stops, 1);
      assert.ok(width > 720 ? fixture.grids[0] > 80 : fixture.grids[0] < 60, 'grid follows this viewport, not saved mobile width');
      await dialog.getByRole('textbox', { name: '任务描述', exact: true }).fill('修复终端宽度，37列到140列恢复，回归通过；最多5轮，不部署。');
      const draftRun = fixture.autonomy.runs.values().next().value;
      Object.assign(draftRun.definition, { goal: '迟到描述不得覆盖' }); fixture.autonomy.changed(draftRun);
      assert.equal(await dialog.getByRole('textbox', { name: '任务描述' }).inputValue(), '修复终端宽度，37列到140列恢复，回归通过；最多5轮，不部署。');
      assert.equal(await dialog.locator('form').evaluate(el => el.checkValidity()), true, 'one description is sufficient');
      assert.equal(await dialog.getByRole('button', { name: '确认开始', exact: true }).evaluate(el => {
        const probe = document.createElement('span'); probe.style.color = 'var(--accent)'; el.append(probe);
        const matches = getComputedStyle(el).backgroundColor === getComputedStyle(probe).color; probe.remove(); return matches;
      }), true, 'start uses the current Codeck theme accent');
      assert.equal(await dialog.locator('form').evaluate(el => el.scrollWidth <= el.clientWidth), true);
      await page.screenshot({ path: path.join(artifacts, `${provider}-${width}-simple-setup.png`) });
      await dialog.getByRole('button', { name: '取消', exact: true }).click(); assert.equal(fixture.sent.length, 0);
      assert.equal(await dialog.isVisible(), false);
      await a.click(); assert.equal(await dialog.getByRole('textbox', { name: '任务描述', exact: true }).inputValue(), '修复终端宽度，37列到140列恢复，回归通过；最多5轮，不部署。');
      await dialog.getByRole('button', { name: '确认开始', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('#terminalAutonomyButton').dataset.state === 'running');
      await fixture.autonomy.tick(); assert.equal(fixture.sent.length, 1);
      assert.equal(await page.locator('#terminalStopButton').isVisible(), false);
      assert.equal(await a.locator('.terminal-autonomy-symbol').evaluate(el => getComputedStyle(el).borderTopColor), 'rgb(234, 179, 8)');
      assert.deepEqual(await a.locator('.terminal-autonomy-symbol').evaluate(el => [getComputedStyle(el).backgroundColor, getComputedStyle(el).boxShadow]), ['rgba(0, 0, 0, 0)', 'none']);
      await page.screenshot({ path: path.join(artifacts, `${provider}-${width}-simple-active.png`) });
      await page.locator('#terminalProgressButton').click();
      await page.waitForFunction(() => document.querySelector('#terminalProgressButton').getAttribute('aria-busy') === 'false');
      await page.locator('#terminalVoiceDraft').fill('请补充说明当前缓存证据');
      await page.locator('#sendTerminalVoiceButton').click();
      await page.waitForFunction(() => document.querySelector('#terminalVoiceDraft').value === '');
      assert.equal(fixture.autonomy.snapshot(fixture.target).status, 'running');
      assert.equal(fixture.sent.length, 1, 'normal conversation cannot reset or exit A');
      const id = fixture.autonomy.snapshot(fixture.target).id;
      const old = fixture.autonomy.runs.values().next().value;
      fixture.sessions[0].hasRunningProcess = true;
      await a.click(); await page.waitForFunction(() => document.querySelector('#terminalAutonomyButton').dataset.state === 'exiting');
      assert.equal(await dialog.isVisible(), false, 'exit must not open another choice dialog');
      await fixture.autonomy.tick(); assert.equal(fixture.sent.length, 2);
      assert.match(fixture.sent[1], /"phase":"summary"/);
      const nonce = /"nonce":"([^"]+)"/.exec(fixture.sent[1])[1];
      const turn = fixture.turns.at(-1); turn.status = 'completed';
      writeReceipt(['--receipt', old.exchange.receiptFile, '--status', 'summary', '--summary', '已完成宽度修复，验证待补。', '--next', '补手机与桌面切换回归。']);
      turn.items.push({ type: 'agentMessage', text: '已完成宽度修复，验证待补。下一步：补手机与桌面切换回归。' });
      await fixture.autonomy.tick();
      await page.waitForFunction(() => document.querySelector('#terminalAutonomyButton').dataset.state === 'off');
      const handoff = page.locator('#terminalAutonomySummary');
      await handoff.waitFor({ state: 'visible' });
      assert.equal(await handoff.evaluate(el => el.open), true);
      assert.match(await handoff.innerText(), /已完成宽度修复.*补手机与桌面切换回归/s);
      assert.doesNotMatch(await handoff.innerText(), /codeck-autonomy|nonce|"status"/);
      assert.equal(await page.locator('#terminal').isVisible(), true);
      assert.equal(await dialog.isVisible(), false);
      await page.screenshot({ path: path.join(artifacts, `${provider}-${width}-simple-handoff.png`) });
      await handoff.locator('summary').click();
      fixture.autonomy.changed(old);
      assert.equal(await handoff.evaluate(el => el.open), false, 'updates preserve manual collapse');
      assert.equal(await page.locator('#terminalAutonomyStatus').textContent(), '1');
      assert.equal(await a.evaluate(el => el.nextElementSibling.id), 'shareButton');
      await a.click(); await dialog.getByRole('heading', { name: '确认自主任务' }).waitFor();
      assert.notEqual(fixture.autonomy.snapshot(fixture.target).id, id);
      assert.equal(fixture.autonomy.snapshot(fixture.target).round, 0); assert.equal(fixture.sent.length, 2);
      assert.equal(fixture.stops, 4);
      await page.screenshot({ path: path.join(artifacts, `${provider}-${width}-simple-reenter.png`) });
      await page.reload(); await a.waitFor({ state: 'visible' });
      await page.waitForFunction(() => !document.querySelector('#terminalAutonomyButton').disabled);
      assert.equal(await dialog.isVisible(), false, 'enter/reconnect must not open saved setup');
      assert.equal(await a.getAttribute('aria-pressed'), 'false');
      await a.click(); await dialog.waitFor({ state: 'visible' });
      assert.equal(fixture.sent.length, 2, 'opening saved setup cannot start work');
      assert.deepEqual(errors, []); await context.close();
      console.log(`PASS simple ${provider} ${width}: viewport, interrupt/setup, approval, interrupt/summary/exit, fresh setup`);
      continue;
    }

  }
} finally {
  fixture?.autonomy.close(); await browser.close();
  for (const socket of sockets.clients) socket.terminate();
  await new Promise(resolve => sockets.close(resolve)); await new Promise(resolve => server.close(resolve));
}
