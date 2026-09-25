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
const { chromium } = await import(process.env.CODECK_PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const artifacts = await fs.mkdtemp(path.join(os.tmpdir(), 'codeck-terminal-autonomy-'));
console.log(`Artifacts: ${artifacts}`);
let fixture;
function reset(provider) {
  fixture?.autonomy.close();
  const target = { provider, threadId: 'fixture-thread', tmuxSession: 'fixture' };
  const sessions = ['fixture', 'other'].map(name => ({ name, width: 100, height: 24, activityAt: Date.now(),
    agent: { kind: provider, id: name === 'fixture' ? target.threadId : 'other-thread', paneId: '%7' } }));
  const f = fixture = { target, sessions, sent: [], inputs: [], requests: [], turns: [], stops: 0, manualStops: [], agents: [] };
  const thread = () => ({ thread: { id: target.threadId, turns: f.turns } });
  const backend = new EventEmitter(); backend.openThread = async () => thread();
  f.autonomy = new AutonomyController({ schedule: () => 1, cancel() {},
    readSession: async t => sessions.find(s => s.name === t.tmuxSession), readThread: async () => thread(),
    stop: async () => { f.stops++; },
    send: async (_target, text) => {
      f.sent.push(text);
      const nonce = /"nonce":"([^"]+)"/.exec(text)[1];
      const turn = { status: 'inProgress', items: [{ type: 'userMessage', content: text }] };
      f.turns.push(turn);
      if (text.includes('"phase":"config"')) {
        const record = f.plan ? { status: 'ready', plan: f.plan } : { status: 'ask', questions: [
          { id: 'goal', header: '目标', question: '推进哪个目标？', options: ['修复选择器', '只定位原因'] },
          { id: 'budget', header: '预算', question: '最多执行多少轮？', options: ['3 轮 / 30 分钟', '5 轮 / 60 分钟'] },
          { id: 'preferences', header: '偏好', question: '执行边界？', options: ['最小修改，不部署', '先给设计'] },
        ] };
        turn.status = 'completed';
        turn.items.push({ type: 'agentMessage', text: '请选择\n\n```codeck-autonomy\n' + JSON.stringify({ nonce, ...record }) + '\n```' });
      }
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
    await page.goto(`http://127.0.0.1:${server.address().port}/?session=fixture`);
    const a = page.locator('#terminalAutonomyButton');
    try { await a.waitFor({ state: 'visible' }); }
    catch (error) { console.error(await page.locator('body').innerText(), fixture.requests); throw error; }
    await page.locator('#terminalVoiceDraft').fill('尚未发送的草稿');
    await page.click('#terminalProgressButton');
    await page.waitForFunction(() => document.querySelector('#terminalProgressButton').getAttribute('aria-busy') === 'false');
    assert.equal(fixture.inputs.at(-1).nonInterrupting, true);
    assert.equal(fixture.sent.length, 0);
    await a.click(); await fixture.autonomy.tick(); await fixture.autonomy.tick();
    await page.locator('#terminalAutonomyDialog[open]').waitFor();
    assert.equal(await page.getByRole('radio', { name: '修复选择器' }).count(), 1);
    assert.equal(await page.getByRole('radio', { name: '3 轮 / 30 分钟' }).count(), 1);
    await page.click('#terminalAutonomyDialog button[type=submit]');
    assert.match(await page.textContent('#terminalAutonomyDialog .form-error'), /目标/);
    const custom = page.getByRole('textbox', { name: '目标：自定义回答' });
    await custom.fill('修复当前回归');
    await page.click('#closeTerminalAutonomy');
    await a.click(); assert.equal(await custom.inputValue(), '修复当前回归');
    for (const id of ['budget', 'preferences']) await page.locator(`fieldset[data-question-id=${id}] input[type=radio]`).first().check();
    await page.screenshot({ path: path.join(artifacts, `${provider}-${width}-choices.png`) });
    fixture.plan = { goal: '修复当前回归', acceptance: '回归测试通过', preferences: '最小修改，不部署', maxRounds: 3, minutes: 30 };
    const respond = fixture.autonomy.respond.bind(fixture.autonomy);
    fixture.autonomy.respond = async () => { throw new Error('暂时无法处理，请重试'); };
    await page.click('#terminalAutonomyDialog button[type=submit]');
    await page.waitForFunction(() => document.querySelector('#terminalAutonomyDialog .form-error').textContent.includes('请重试'));
    assert.equal(await custom.inputValue(), '修复当前回归');
    fixture.autonomy.respond = respond;
    await page.click('#terminalAutonomyDialog button[type=submit]');
    await page.waitForFunction(() => !document.querySelector('#terminalAutonomyDialog').open);
    await fixture.autonomy.tick(); await fixture.autonomy.tick();
    await page.getByRole('heading', { name: '确认自主目标' }).waitFor();
    assert.match(fixture.sent.at(-1), /预算：3 轮 \/ 30 分钟/);
    assert.match(fixture.sent.at(-1), /偏好：最小修改，不部署/);
    assert.equal(fixture.stops, 0);
    const setup = fixture.autonomy.runs.values().next().value;
    const finite = setup.proposal;
    setup.proposal = { ...finite, maxRounds: null, minutes: null };
    setup.requestId += '-unlimited'; fixture.autonomy.changed(setup);
    await page.getByText('不设预算上限（已用 0 轮）', { exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('#terminalAutonomyStatus').textContent === '0/∞ 待确认');
    assert.equal(fixture.stops, 0, 'showing unlimited configuration cannot authorize work');
    setup.proposal = finite; setup.requestId += '-finite'; fixture.autonomy.changed(setup);
    await page.getByText('3 轮 · 30 分钟（已用 0 轮）', { exact: true }).waitFor();
    await page.click('#closeTerminalAutonomy'); await a.click();
    await page.waitForFunction(() => !document.querySelector('#terminalAutonomyDialog').open);
    await fixture.autonomy.tick();
    assert.equal(fixture.stops, 1); assert.equal(fixture.autonomy.snapshot(fixture.target).round, 1);
    await page.waitForFunction(() => document.querySelector('#terminalAutonomyStatus').textContent.includes('1/3'));
    assert.equal(await page.inputValue('#terminalVoiceDraft'), '尚未发送的草稿');
    assert.equal(await page.locator('.terminal-header').evaluate(el => el.scrollWidth <= el.clientWidth), true);
    for (const id of ['terminalAutonomyButton', 'terminalProgressButton']) {
      const box = await page.locator('#'+id).boundingBox(); assert.ok(box.width >= 44 && box.height >= 44);
    }
    await page.screenshot({ path: path.join(artifacts, `${provider}-${width}-running.png`) });
    await a.click(); await page.waitForFunction(() => document.querySelector('#terminalAutonomyStatus').textContent.includes('已暂停'));
    await page.reload();
    await a.waitFor({ state: 'visible' });
    assert.match(await page.textContent('#terminalAutonomyStatus'), /1\/3.*已暂停/);
    assert.equal(fixture.stops, 1);
    await page.evaluate(() => document.documentElement.dataset.terminalTheme = 'mac');
    await page.screenshot({ path: path.join(artifacts, `${provider}-${width}-paused-light.png`) });
    const start = fixture.autonomy.start.bind(fixture.autonomy);
    fixture.autonomy.start = async () => { throw new Error('继续请求未确认，请核对终端'); };
    await a.click();
    await page.waitForFunction(() => document.querySelector('#terminalAutonomyNotice').textContent.includes('继续请求未确认'));
    fixture.autonomy.start = start;
    fixture.sessions[0].hasRunningProcess = true;
    fixture.sessions[0].agent.hasBackgroundProcess = true;
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#terminalAutonomyStatus').textContent.includes('执行中 · 续跑关闭'));
    const sendsBeforeResume = fixture.sent.length;
    await a.click(); await fixture.autonomy.tick();
    assert.equal(fixture.sent.length, sendsBeforeResume); assert.equal(fixture.stops, 1);
    await a.click();
    await page.click('#terminalStopButton');
    await page.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(fixture.manualStops.length, 0);
    await page.click('#terminalStopButton');
    await page.screenshot({ path: path.join(artifacts, `${provider}-${width}-stop-scope.png`) });
    fixture.holdStop = true;
    await page.getByRole('button', { name: '仅停止当前执行', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#terminalAutonomyStatus').textContent.includes('停止中'));
    assert.equal(await a.isDisabled(), true);
    fixture.holdStop = false; fixture.finishStop();
    await page.waitForFunction(() => document.querySelector('#terminalAutonomyStatus').textContent.includes('续跑关闭'));
    assert.equal(fixture.manualStops[0].allowBackground, true);
    assert.equal(fixture.sessions[0].agent.hasBackgroundProcess, true);
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#terminalAutonomyStatus').textContent.includes('后台执行中 · 续跑关闭'));
    assert.equal(await page.locator('.terminal-header').evaluate(el => el.scrollWidth <= el.clientWidth), true);
    await page.screenshot({ path: path.join(artifacts, `${provider}-${width}-background-paused.png`) });
    await page.click('#terminalStopButton');
    await page.getByRole('button', { name: '全部停止', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('#terminalAutonomyButton').disabled);
    assert.equal(fixture.manualStops.at(-1).stopBackground, true);
    if (provider === 'claude') assert.match(await page.textContent('#terminalAutonomyNotice'), /后台停止尚不支持/);
    fixture.sessions[0].agent.hasBackgroundProcess = false;
    // Manual direction goes through the same controller and preserves spent rounds.
    fixture.plan = null;
    await page.locator('#terminalVoiceDraft').fill('只修改后端，先重新确认目标');
    await page.click('#sendTerminalVoiceButton');
    await page.waitForFunction(() => document.querySelector('#terminalVoiceDraft').value === '');
    assert.equal(fixture.autonomy.snapshot(fixture.target).status, 'configuring');
    assert.equal(fixture.autonomy.snapshot(fixture.target).round, 1);
    assert.equal(fixture.inputs.length, 1, 'direction must not use raw terminal input');
    await fixture.autonomy.tick(); await fixture.autonomy.tick();
    await page.locator('#terminalAutonomyDialog[open]').waitFor();
    // Closing keeps choices; switching invalidates the old form even if it is submitted late.
    await page.evaluate(() => { window.staleAutonomyForm = document.querySelector('#terminalAutonomyContent form'); });
    await page.click('#closeTerminalAutonomy');
    if (width < 720) await page.click('#menuButton');
    await page.click('[data-session="other"]');
    await page.waitForFunction(() => document.querySelector('#terminalTitle').textContent === 'other' && !document.querySelector('#terminalAutonomyButton').disabled);
    const answersBefore = fixture.requests.filter(r => r.type === 'answerAutonomy').length;
    await page.evaluate(() => window.staleAutonomyForm.requestSubmit());
    assert.equal(fixture.requests.filter(r => r.type === 'answerAutonomy').length, answersBefore);
    assert.equal(await page.locator('#terminalAutonomyDialog').evaluate(el => el.open), false);
    if (width < 720) await page.click('#menuButton');
    await page.click('[data-session="fixture"]');
    await page.locator('#terminalAutonomyDialog[open]').waitFor();
    await page.click('#closeTerminalAutonomy');
    await page.locator('#terminalVoiceDraft').fill('断线仍保留的草稿');
    for (const socket of fixture.agents) socket.close();
    await page.waitForFunction(() => document.querySelector('#terminalAutonomyButton').disabled);
    assert.equal(await page.inputValue('#terminalVoiceDraft'), '断线仍保留的草稿');
    await page.locator('#terminalAutonomyDialog[open]').waitFor();
    assert.equal(fixture.stops, 1, 'reconnect must never approve a goal');
    // Native CLI questions retain control of the terminal; A cannot answer them.
    fixture.sessions[0].agent.question = { id: 'native-approval' };
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#terminalAutonomyButton').getAttribute('aria-label') === '处理 Agent 等待的问题' && !document.querySelector('#terminalAutonomyButton').disabled);
    const commandsBefore = fixture.requests.filter(r => /^(start|pause|answer)Autonomy$/.test(r.type)).length;
    await a.click();
    assert.match(await page.textContent('#terminalAutonomyNotice'), /终端中处理/);
    assert.equal(fixture.requests.filter(r => /^(start|pause|answer)Autonomy$/.test(r.type)).length, commandsBefore);
    assert.equal(await page.locator('#terminalAutonomyDialog').evaluate(el => el.open), false);
    if (provider === 'codex' && width === 390) {
      fixture.readOnly = true; await page.reload();
      await page.locator('#terminalView:not([hidden])').waitFor();
      assert.equal(await a.isVisible(), false);
      fixture.readOnly = false; fixture.sessions[0].agent.kind = 'shell'; await page.reload();
      await page.locator('#terminalView:not([hidden])').waitFor();
      assert.equal(await a.isVisible(), false);
      fixture.sessions[0].agent.kind = provider;
      fixture.hub.autonomy = null; await page.reload();
      await page.locator('#terminalView:not([hidden])').waitFor();
      assert.equal(await a.isVisible(), false, 'old backend must not expose unsupported controls');
    }
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`PASS ${provider} ${width}: progress, choices/custom, approval, rounds, pause/reload, direction, stale form, reconnect, native question, drafts, layout`);
  }
} finally {
  fixture?.autonomy.close(); await browser.close();
  for (const socket of sockets.clients) socket.terminate();
  await new Promise(resolve => sockets.close(resolve)); await new Promise(resolve => server.close(resolve));
}
