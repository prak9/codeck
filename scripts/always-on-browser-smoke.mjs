#!/usr/bin/env node
/**
 * Isolated dual-mode (普通模式 index.html + Remote 模式 remote.html) × dual-viewport (390px / 1365px)
 * Playwright browser smoke test for the Always-On Super Agent panel.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { WebSocketServer } from 'ws';
import { handleTerminalConnection } from '../src/terminal-connection.js';
import { WorkstationStore } from '../src/workstation-store.js';
import { mountWorkstationRoutes } from '../src/workstation-routes.js';
import { mountWorkstationActions } from '../src/workstation-actions.js';
import { createConditionalTasks } from '../src/conditional-tasks.js';
import { createWorkstationAutomations } from '../src/workstation-automations.js';
import { createTelegramSessionAdapter } from '../src/telegram-session-adapter.js';
import { createWorkfiles, mountWorkfiles, workfileDownloadAuthorized } from '../src/workfiles.js';
import { AlwaysOnStore } from '../src/always-on-store.js';
import { createAlwaysOnRuntime } from '../src/always-on-runtime.js';
import { createMemoryStore } from '../src/always-on-memory.js';
import { createOutboxDispatcher } from '../src/always-on-outbox.js';
import { createButlerOrchestrator } from '../src/always-on-butler.js';
import { createApprovalGate, createCredentialProxy } from '../src/always-on-permissions.js';
import { mountAlwaysOnRoutes } from '../src/always-on-routes.js';

const playwrightModule = process.env.CODECK_PLAYWRIGHT_MODULE || '/data/tmp/codeck-playwright/node_modules/playwright/index.mjs';
const { chromium } = await import(playwrightModule);

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codeck-ao-browser-'));
const store = new AlwaysOnStore(':memory:');
const memory = createMemoryStore({ directory: path.join(dir, 'memory') });
const outboxDispatcher = createOutboxDispatcher({ store, memory });
const butler = createButlerOrchestrator({ store, memory, outboxDispatcher });
const runtime = createAlwaysOnRuntime({
  store,
  handleScope: async (scopeKey, batch, helpers) => (scopeKey === 'butler' ? butler.handleBatch(batch, helpers) : { status: 'done' }),
});
const approvalGate = createApprovalGate({ store, runtime });
const credentialProxy = createCredentialProxy({ secretsDir: path.join(dir, 'secrets') });

// Seed one pending deferred approval and one digest item
const { approval } = approvalGate.requestApproval({
  scopeKey: 'session:demo',
  sessionName: 'demo',
  summary: '分享演示报告页面',
  action: { kind: 'page_share', pageId: 'demo-1' },
});
store.enqueueOutbox({ scopeKey: 'butler', priority: 'digest', channel: 'web', title: '夜间巡检摘要', contentMd: '全部健康' });

const app = express();
app.use(express.json());
app.use('/api', (req, _res, next) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/, '');
  req.auth = { owner: token === 'owner-token' || workfileDownloadAuthorized(req), canWrite: token === 'owner-token' };
  next();
});
const ownerOnly = (req, res, next) => (req.auth.owner ? next() : res.status(403).json({ error: 'forbidden' }));
const session = { name: 'demo', cwd: dir, windows: 1, attached: 0, createdAt: Date.now(), activityAt: Date.now(), status: 'done',
  executionState: 'idle', agent: { kind: 'codex', id: 'thr-demo', name: 'Demo', cwd: dir } };
const sessions = async () => [session];
app.get('/api/sessions', (req, res) => res.json({ sessions: [session], capabilities: { flexibleSize: true, canManage: req.auth.owner,
  canWrite: req.auth.canWrite, canSwitchSession: req.auth.owner, terminalSubmit: true } }));
app.get('/api/pages', ownerOnly, (_req, res) => res.json({ pages: [{ id: 'weekly', title: '周报' }] }));
const tracking = new WorkstationStore(store.db);
const taskTarget = { session: session.name, createdAt: session.createdAt, provider: session.agent.kind, threadId: session.agent.id };
const analyst = tracking.createBot({ name: '投研助手', purpose: '季报核验', target: taskTarget });
const original = tracking.trackTask({ title: '核对原消息', botId: analyst.id, target: taskTarget, anchor: 'turn:turn-1' });
const workfiles = createWorkfiles(path.join(dir, 'files'));
await fs.writeFile(path.join(dir, 'filing.txt'), 'Q3-v1');
await workfiles.put(session, { key: 'filing', title: '季报对照', kind: 'result', revision: 'v1', path: path.join(dir, 'filing.txt') });
mountWorkfiles(app, { store: workfiles, pages: { list: async () => [] }, sessions, ownerOnly });
mountWorkstationRoutes(app, { store: tracking, workfiles, sessions, ownerOnly,
  telegramChannels: () => [{ id: '12', username: 'demo_research_bot', status: 'connected' }] });
let question, answers = 0, inputs = 0, agentConnections = 0;
const interactions = createTelegramSessionAdapter({ list: sessions, pendingRequests: () => question ? [question] : [], rpc: async (_c, msg) => {
  assert.equal(msg.type, 'resolveInteraction'); assert.equal(msg.threadId, session.agent.id); assert.equal(msg.requestId, question.request.id);
  assert.deepEqual(msg.answers, { basis: ['单季度'] }); question = null; answers++;
} });
const automations = createWorkstationAutomations({ store, tracking, listSessions: sessions,
  wake: async () => {}, create: async () => { inputs++; throw Error('unexpected session launch'); },
  send: async () => { inputs++; throw Error('unexpected agent input'); } });
const router = express.Router();
const conditionalTasks = await createConditionalTasks({ directory: path.join(dir, 'conditions'), precheck: async () => null,
  idle: async () => true, send: async () => { inputs++; throw Error('unexpected condition dispatch'); } });
mountWorkstationActions(router, { ownerOnly, interactions, automations, conditionalTasks });
app.use('/api/workstation', router);
mountAlwaysOnRoutes(app, { store, runtime, memory, outboxDispatcher, butler, approvalGate, credentialProxy, ownerOnly });
app.use('/vendor', express.static(path.resolve('node_modules/@xterm/xterm/css')));
app.use('/vendor/xterm', express.static(path.resolve('node_modules/@xterm/xterm/lib')));
app.use('/vendor/fit', express.static(path.resolve('node_modules/@xterm/addon-fit/lib')));
app.use('/vendor/webgl', express.static(path.resolve('node_modules/@xterm/addon-webgl/lib')));
app.use('/vendor/web-links', express.static(path.resolve('node_modules/@xterm/addon-web-links/lib')));
app.use('/fonts/inter', express.static(path.resolve('node_modules/@fontsource-variable/inter')));
app.use('/fonts/noto-sans-sc', express.static(path.resolve('node_modules/@fontsource-variable/noto-sans-sc')));
app.use(express.static(path.resolve('public')));

const server = http.createServer(app);
const sockets = new WebSocketServer({ server });
sockets.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://fixture');
  if (url.pathname === '/ws') {
    return void handleTerminalConnection(ws, 'demo', { width: 100, height: 30 }, {
      canSwitchSession: true, outputFlowControl: true, outputFlowId: url.searchParams.get('flowId'), outputProtocol: 1,
      getLinkedWindowSessions: async () => [], preferLatestClientSize: async () => true, clampViewport: (x, y) => [x, y],
      submitTerminalInput: async () => { inputs++; }, writeTerminalInput: async () => { inputs++; },
      createTerminal: () => {
        let timer;
        return { onData(fn) { timer = setTimeout(() => fn('测试终端\r\n$ '), 20); }, onExit() {}, write() {}, resize() {}, kill() { clearTimeout(timer); } };
      },
    });
  }
  ws.agentTransport = true; agentConnections++;
  ws.send(JSON.stringify({ type: 'ready', hostname: 'fixture', protocol: { version: 1, epoch: 'test' },
    providers: [{ id: 'codex', capabilities: {} }] }));
  ws.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.type === 'sendMessage' || m.type === 'sendSessionMessage') inputs++;
    const result = m.type === 'openThread' ? { thread: { id: 'thr-demo', provider: 'codex', turns: [{ id: 'turn-1', status: 'completed',
      items: [{ type: 'agentMessage', id: 'msg-1', text: '上次季度研究已经整理。' }] }] } } : {};
    if (m.id != null) ws.send(JSON.stringify({ id: m.id, ok: true, result }));
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const executablePath = process.env.CODECK_CHROMIUM_BIN || undefined;
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });

try {
  const checks = [];
  for (const mode of [{ name: 'normal', path: '/' }, { name: 'remote', path: '/remote.html' }]) {
    for (const vp of [{ name: 'mobile-390', width: 390, height: 844 }, { name: 'desktop-1365', width: 1365, height: 900 }]) {
      const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
      await context.addInitScript(() => {
        const credential = location.search.includes('readonly-test') ? 'share-token' : 'owner-token';
        localStorage.setItem('codeck-token', credential);
        localStorage.setItem('codeck-local-input', '1');
        sessionStorage.setItem('codeck-token', credential);
      });
      const page = await context.newPage();
      const pageErrors = [];
      let pageListReads = 0, pendingReads = 0;
      page.on('request', request => {
        const path = new URL(request.url()).pathname;
        if (path === '/api/pages') pageListReads++;
        if (path === '/api/workstation/pending') pendingReads++;
      });
      page.on('pageerror', err => pageErrors.push(err.message));

      page.setDefaultTimeout(6500);
      const titles = { normal: ['核对季度指引', '复核营收与财报口径'], remote: ['核对估值表的来源', '更新季报对照表'] };
      async function capture(stage) {
        if (!process.env.CODECK_SCREENSHOT_DIR) return;
        await fs.mkdir(process.env.CODECK_SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({ path: path.join(process.env.CODECK_SCREENSHOT_DIR, [mode.name, vp.width, stage].join('-') + '.png') });
      }
      const title = titles[mode.name][vp.width === 390 ? 0 : 1];
      const task = tracking.trackTask({ title, botId: analyst.id, target: taskTarget, anchor: 'manual:' + title });
      question = { provider: 'codex', request: { id: title, method: 'item/tool/requestUserInput', params: {
        threadId: 'thr-demo', questions: [{ id: 'basis', question: '按哪个口径比较？', options: [{ label: '单季度' }] }] } } };
      await page.goto(`${baseUrl}${mode.path}?session=demo`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(400);

      const draft = page.locator(mode.name === 'normal' ? '#terminalVoiceDraft' : '#composerInput');
      await draft.fill('尚未发送的研究草稿');
      // Open drawer on mobile if needed
      if (vp.width === 390) {
        const menuBtn = page.locator(mode.name === 'normal' ? '#menuButton' : '#drawerButton');
        if (await menuBtn.isVisible()) await menuBtn.click();
        await page.waitForTimeout(200);
      }

      const panel = page.locator('.station-panel');
      const backToSession = async () => {
        for (let i = 0; i < 12 && await panel.isVisible(); i++) {
          const moved = page.evaluate(() => new Promise(resolve => window.addEventListener('popstate', () => resolve(true), { once: true })));
          await panel.locator('.station-heading').getByRole('button', { name: /^返回(会话)?$/ }).click();
          await moved;
        }
        await panel.waitFor({ state: 'hidden' });
      };
      const openDrawer = async () => {
        if (vp.width === 390) {
          const menu = page.locator(mode.name === 'normal' ? '#menuButton' : '#drawerButton');
          const stationMenu = panel.locator('#stationMenu');
          if (await panel.isVisible() && await stationMenu.isVisible()) await stationMenu.click();
          else if (await menu.getAttribute('aria-expanded') !== 'true') await menu.click();
        }
      };
      const nav = async id => {
        await openDrawer();
        await page.locator(id).click();
      };
      const station = page.locator('#workstationNav');
      await station.waitFor();
      const entries = station.locator('#alwaysOnButton, #botsToggle, #pagesToggle');
      assert.equal(await entries.filter({ visible: true }).count(), 0, '工作台三个入口默认收起');
      assert.equal(await station.locator('#tasksButton, #alwaysOnBadge').count(), 0);
      const summary = station.locator('summary').first();
      await summary.focus();
      await page.keyboard.press('Enter');
      assert.equal(await entries.filter({ visible: true }).count(), 3);
      for (const toggle of ['#botsToggle', '#pagesToggle']) assert.equal(await station.locator(toggle).getAttribute('aria-expanded'), 'false');
      assert.equal(pageListReads, 0);
      await station.locator('#pagesToggle').click();
      await station.getByRole('link', { name: '周报' }).waitFor();
      await station.locator('#pagesToggle').click();
      await summary.click();
      assert.equal(await entries.filter({ visible: true }).count(), 0);
      await summary.click();
      assert.equal(pendingReads, 0, '浏览侧栏不会读取跨会话待办');
      await station.locator('#botsToggle').click();
      await station.locator('.station-twist').click();
      await station.locator(`[data-focus-key="task:${task.id}"]`).click();
      await panel.getByRole('heading', { name: title, exact: true }).waitFor();
      const before = answers;
      await panel.getByRole('button', { name: '单季度', exact: true }).click();
      await panel.locator('[data-pending]').waitFor({ state: 'hidden' });
      assert.equal(answers, before + 1);
      await panel.getByRole('button', { name: '关联成果版本' }).click();
      await panel.getByRole('button', { name: '关联此版本' }).click();
      const [download] = await Promise.all([page.waitForEvent('download'), panel.getByRole('button', { name: '下载此版本' }).click()]);
      assert.equal(await fs.readFile(await download.path(), 'utf8'), 'Q3-v1');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, title);
      await capture('result');
      await nav('#bindBotButton');
      // Reusing the same home identity binds back to the existing Bot on every viewport.
      await panel.getByLabel('Bot 名称').fill('投研助手');
      await panel.getByLabel('职责').fill('季报核验');
      const homePicker = panel.getByLabel('主会话', { exact: true });
      assert.equal(await homePicker.inputValue(), '', '创建 Bot 必须显式选择主会话');
      await homePicker.selectOption({ label: 'demo' });
      await panel.getByRole('button', { name: '绑定 Bot', exact: true }).click();
      await panel.getByRole('heading', { name: '投研助手', exact: true }).waitFor();
      await panel.locator('summary').filter({ hasText: /^Telegram/ }).click();
      await panel.getByLabel('Telegram 机器人').selectOption('12');
      await panel.getByRole('button', { name: '绑定 Telegram', exact: true }).click();
      await panel.getByText('@demo_research_bot · 已连接', { exact: true }).waitFor();
      await panel.locator('summary').filter({ hasText: /^Telegram/ }).click();
      await openDrawer();
      const manage = page.locator('#stationBots').getByRole('button', { name: '管理 Bot' });
      await manage.waitFor();
      const hierarchy = await page.evaluate(() => {
        const controls = ['#botsToggle', '.station-bot', '.station-child[data-focus-key^="manage:"]'].map(s => document.querySelector(s));
        return controls.map(button => {
          const text = [...button.childNodes].find(n => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
          const range = document.createRange(); range.selectNodeContents(text);
          return { x: range.getBoundingClientRect().x, height: button.getBoundingClientRect().height };
        });
      });
      assert.ok(hierarchy.every((row, i) => !i || row.x >= hierarchy[i - 1].x + 12), JSON.stringify(hierarchy));
      if (vp.width === 390) assert.ok(hierarchy.every(row => row.height >= 44));
      await capture('sidebar');
      await manage.focus();
      await page.keyboard.press('Enter');
      assert.equal(await station.locator('[aria-current="page"]').count(), 1);
      assert.equal(await manage.getAttribute('aria-current'), 'page');
      await panel.locator('summary').getByText('@demo_research_bot · 已连接', { exact: true }).waitFor();
      await capture('bot');
      await panel.locator('summary').filter({ hasText: /^Telegram/ }).click();
      await panel.getByRole('button', { name: '解除 Telegram 绑定' }).click();
      await panel.getByLabel('Telegram 机器人').waitFor();
      await nav('#alwaysOnButton');
      await panel.getByRole('button', { name: '新建规则' }).click();
      assert.equal(await panel.getByLabel('执行来源').locator('option:checked').textContent(), '指定项目 · 按需新建会话');
      await panel.getByLabel('项目目录').fill(dir);
      await panel.getByLabel('执行 Agent').selectOption('qodercli');
      await panel.getByLabel('执行事项').fill(title);
      await panel.getByLabel('触发时间').selectOption('weekdays');
      await panel.getByLabel('时区').fill('Asia/Shanghai');
      await panel.getByRole('button', { name: '试算', exact: true }).click();
      await panel.getByText(/新建独立任务会话/).waitFor();
      await capture('rule');
      assert.equal(automations.list().filter(t => t.reason === title).length, 0);
      if (mode.name === 'normal' && vp.width === 390) {
        // The database saved the rule, but the client lost the response. Retry the unchanged form.
        const saveUrl = '**/api/workstation/automations';
        await page.route(saveUrl, async route => {
          assert.equal(route.request().method(), 'POST');
          const saved = await route.fetch();
          assert.ok(saved.ok());
          await saved.dispose();
          await route.abort('failed');
        }, { times: 1 });
        const lost = page.waitForEvent('requestfailed', r => r.url().endsWith('/api/workstation/automations'));
        await panel.getByRole('button', { name: '保存规则' }).click();
        await lost;
        assert.equal(automations.list().filter(t => t.reason === title).length, 1);
      }
      await panel.getByRole('button', { name: '保存规则' }).click();
      const rule = panel.locator('article').filter({ has: page.getByText(title, { exact: true }) });
      await rule.getByRole('button', { name: '暂停' }).click();
      assert.equal(automations.list().filter(t => t.reason === title).length, 1);
      await rule.getByText('已暂停', { exact: true }).waitFor();
      await rule.getByRole('button', { name: '运行记录' }).click();
      await rule.getByText('暂无运行记录').waitFor();
      assert.equal(inputs, 0);
      // Drop the agent transport while reading the rule. Navigation and drafts must survive reconnect.
      const previousConnections = agentConnections;
      for (const ws of sockets.clients) if (ws.agentTransport) ws.close(1012);
      const deadline = Date.now() + 8000;
      while (agentConnections === previousConnections && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
      assert.ok(agentConnections > previousConnections, 'agent feed reconnected');
      await rule.getByText('已暂停', { exact: true }).waitFor();
      await rule.getByRole('button', { name: '编辑', exact: true }).click();
      assert.equal(await panel.getByLabel('执行事项').inputValue(), title);
      assert.equal(await panel.getByLabel('项目目录').inputValue(), dir);
      assert.equal(await panel.getByLabel('执行 Agent').inputValue(), 'qodercli');
      assert.equal(await panel.getByLabel('触发时间').inputValue(), 'weekdays');
      await panel.getByLabel('执行事项').fill(title + '（修订）');
      await panel.getByLabel('触发时间').selectOption('daily');
      await panel.getByLabel('执行时间', { exact: true }).fill('18:45');
      await capture('edit-automation');
      await panel.getByRole('button', { name: '保存规则' }).click();
      const changed = panel.locator('article').filter({ has: page.getByText(title + '（修订）', { exact: true }) });
      await changed.getByText('已暂停', { exact: true }).waitFor();
      await changed.getByText(/每天 18:45/).waitFor();
      await changed.getByText('更多操作').click();
      page.once('dialog', dialog => dialog.dismiss());
      await changed.getByRole('button', { name: '删除', exact: true }).click();
      await changed.waitFor();
      page.once('dialog', dialog => dialog.accept());
      await changed.getByRole('button', { name: '删除', exact: true }).click();
      await changed.waitFor({ state: 'detached' });
      if (mode.name === 'remote' && vp.width === 390) {
        await panel.getByText('更多', { exact: true }).click();
        await panel.getByRole('button', { name: '新建条件规则' }).click();
        await panel.getByLabel('执行事项').fill('检查原会话');
        await panel.getByLabel('执行会话').selectOption('demo');
        await panel.getByLabel('条件检查命令及参数').fill('["/bin/true"]');
        await panel.getByRole('button', { name: '保存规则' }).click();
        const condition = panel.locator('article').filter({ has: page.getByText('检查原会话', { exact: true }) });
        await condition.getByRole('button', { name: '立即运行' }).click();
        await condition.getByText('手动检查 · 无变化').waitFor();
        await condition.getByRole('button', { name: '编辑' }).click();
        assert.equal(await panel.getByLabel('间隔（分钟）').inputValue(), '30');
        await panel.getByLabel('间隔（分钟）').fill('5');
        await panel.getByRole('button', { name: '保存规则' }).click();
        await condition.getByText(/每 5 分钟/).waitFor();
        await condition.getByRole('button', { name: '运行记录' }).click();
        assert.equal((await conditionalTasks.list())[0].history.length, 1);
        await condition.getByText('更多操作').click();
        page.once('dialog', d => d.accept());
        await condition.getByRole('button', { name: '删除', exact: true }).click();
        await condition.waitFor({ state: 'detached' });
      }

      assert.equal(inputs, 0);
      await panel.getByText('更多', { exact: true }).click();
      await panel.getByRole('button', { name: '原有提醒与设置' }).click();

      const dialog = page.locator('dialog.always-on-dialog[open]');
      await dialog.waitFor({ state: 'visible', timeout: 5000 });

      // Check cleaner 4 tabs: overview, blueprints (+ 新建目标), timers (+ 新增提醒), memory
      await dialog.locator('[data-tab="blueprints"]').click();
      await dialog.locator('button:has-text("新建目标")').click();
      await dialog.locator('text=告诉我你想自动化什么').waitFor({ state: 'visible', timeout: 3000 });
      await dialog.locator('[data-tab="timers"]').click();
      await dialog.locator('button:has-text("新增提醒")').click();
      await dialog.locator('input[name="reason"]').waitFor({ state: 'visible', timeout: 3000 });
      await dialog.locator('[data-tab="memory"]').click();
      await dialog.locator('textarea').waitFor({ state: 'visible', timeout: 3000 });
      await dialog.locator('[data-tab="overview"]').click();
      await dialog.locator('text=运行记录与实体时间线').waitFor({ state: 'visible', timeout: 3000 });

      if (mode.name === 'normal' && vp.width === 390) await dialog.getByText('分享演示报告页面', { exact: true }).waitFor();
      if (mode.name === 'normal' && vp.width === 1365) await approvalGate.resolveApproval(approval.id, { decision: 'rejected' });

      // Close cleanly
      await dialog.locator('[data-close]').click();
      await dialog.waitFor({ state: 'hidden', timeout: 3000 });

      await backToSession();
      assert.equal(await draft.inputValue(), '尚未发送的研究草稿');
      assert.equal(inputs, 0);
      if (mode.name === 'remote') {
        const turn = page.locator('[data-turn-id="turn-1"]');
        await turn.waitFor();
        assert.equal(await turn.getByRole('button', { name: '加入 Tasks' }).count(), 0);
        await nav(`[data-focus-key="task:${original.id}"]`);
        await panel.getByRole('button', { name: '打开来源会话' }).click();
        await panel.waitFor({ state: 'hidden' });
        assert.equal(tracking.overview().tasks.filter(t => t.anchor === 'turn:turn-1').length, 1);
        assert.equal(await draft.inputValue(), '尚未发送的研究草稿');
      }
      await nav('#historySearchButton');
      const historySearch = page.getByRole('dialog', { name: '搜索历史对话' });
      await historySearch.getByLabel('对话内容').waitFor();
      await historySearch.getByRole('button', { name: '关闭历史搜索' }).click();
      await historySearch.waitFor({ state: 'hidden' });
      await page.goto(baseUrl + mode.path + '?workstation=legacy');
      if (vp.width === 390) await page.locator(mode.name === 'normal' ? '#menuButton' : '#drawerButton').click();
      await page.locator('#legacyStationButton').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#workstationNav').isVisible(), false);
      for (const path of ['/pending', '', '/automations']) {
        const denied = await context.request.get(baseUrl + '/api/workstation' + path, { headers: { authorization: 'Bearer share-token' } });
        assert.equal(denied.status(), 403);
      }
      // A shared terminal must never reveal owner task or bot names, even with legacy navigation requested.
      await Promise.all([page.waitForResponse(r => new URL(r.url()).pathname === '/api/sessions'), page.goto(baseUrl + mode.path + '?workstation=legacy&readonly-test')]);
      assert.equal(await page.locator('#workstationNav').isVisible(), false);
      assert.equal(await page.locator('#legacyStationButton').isVisible(), false);
      assert.equal(pageErrors.length, 0, `${mode.name}/${vp.name} pageErrors: ${pageErrors.join('; ')}`);
      checks.push({ mode: mode.name, viewport: vp.name, ok: true });
      await context.close();
    }
  }
  console.log(JSON.stringify({ ok: true, checks }, null, 2));
} finally {
  await browser.close();
  for (const ws of sockets.clients) ws.terminate();
  sockets.close();
  runtime.close();
  store.close();
  await new Promise(resolve => server.close(resolve));
  await fs.rm(dir, { recursive: true, force: true });
}
