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
import { encodeHistoryCursor, decodeHistoryCursor } from '../src/thread-history-cursor.js';
import { CodexDeliveryRecovery } from '../src/codex-delivery-recovery.js';
import { QoderQuestionTracker } from '../src/qoder-question.js';
import { AUTONOMY_PROGRESS_PROMPT as progressPrompt, AUTONOMY_PLANNING_PROMPT } from '../public/remote-autonomy.js';
import { AutonomyController } from '../src/autonomy.js';
import { writeReceipt } from '../src/autonomy-receipt.js';
import { interruptSession } from '../src/tmux.js';
import { withoutDismissedDeliveries } from '../public/remote-delivery.js';

const { chromium } = await import(process.env.CODECK_PLAYWRIGHT_MODULE || 'playwright');
const simpleMode = process.env.CODECK_BROWSER_CORE !== '1';
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
  fixture?.recovery?.close();
  fixture?.autonomy?.close();
  fixture = { provider, turns: Array.from({ length: 80 }, (_, i) => turn(i + 1)),
    status: 'done', liveOutput: '', sequence: 0, epoch: 'fixture-epoch', sent: [], scopedStops: [], receivedDeliveryIds: [], dismissed: new Set() };
  if (provider === 'codex') fixture.recovery = createFixtureRecovery();
  fixture.autonomySent = [];
  fixture.autonomyStops = 0;
  fixture.stopCommands = [];
  fixture.stopQoder = async (target, guard, all = true) => {
    let background = fixture.background || fixture.status === 'background', menu = false, draft = '';
    await interruptSession({ provider: 'qodercli', sessionName: target.tmuxSession, threadId: target.threadId,
      expectedPaneId: '%7', isCurrent: guard, waitForIdle: true, stopBackground: all, allowBackground: !all }, {
      listTmuxSessions: async () => [{ name: 'fixture', hasRunningProcess: fixture.status === 'working',
        agent: { kind: 'qodercli', id: 'fixture-thread', paneId: '%7', hasBackgroundProcess: background } }],
      capturePane: async () => menu
        ? `Background tasks\n${background ? '1 running' : '1 completed'}\nCommands (1)\n❯ test ${background ? 'running' : 'exited (0)'} PID 123\n↑↓ navigate · Enter output · k ${background ? 'kill' : 'clear'} · Esc close`
        : `────────\n > ${draft}\n────────\nAuto Model · /fixture`,
      execTmux: async args => {
        const key = args.at(-1); fixture.stopCommands.push(key);
        if (args.includes('-l')) draft = key;
        else if (key === 'Enter') { menu = true; draft = ''; }
        else if (key === 'k') background = false;
        else if (key === 'Escape') { menu = false; fixture.status = background ? 'background' : 'done'; }
      }, waitForStop: async () => {}, invalidatePaneSnapshot() {},
    });
    fixture.background = background; fixture.status = background ? 'background' : 'done';
  };
  fixture.autonomy = new AutonomyController({
    schedule: () => 1, cancel() {},
    readSession: async () => ({ name: 'fixture', hasRunningProcess: fixture.status === 'working',
      agent: { kind: provider, id: 'fixture-thread', paneId: '%7', question: fixture.question,
        hasBackgroundProcess: fixture.status === 'background' } }),
    stop: async (target, guard) => {
      assert.equal(guard(), true); fixture.autonomyStops++;
      if (fixture.holdAutonomyStop) await new Promise(resolve => { fixture.finishStop = resolve; });
      if (fixture.failAutonomyStop) { fixture.failAutonomyStop = false; throw new Error('旧任务未停止，新目标未启动'); }
      if (provider === 'codex') {
        let background = fixture.status === 'background'; let goal = true; let draft = '';
        await interruptSession({ provider, sessionName: target.tmuxSession, threadId: target.threadId,
          expectedPaneId: target.paneId, isCurrent: guard, waitForIdle: true, stopBackground: true,
        }, {
          listTmuxSessions: async () => [{ name: 'fixture', hasRunningProcess: fixture.status === 'working',
            agent: { kind: provider, id: 'fixture-thread', paneId: '%7', hasBackgroundProcess: background } }],
          capturePane: async () => `${fixture.status === 'working' ? '• Working (1s • esc to interrupt)\n' : ''}» ${draft}\n\n  gpt-6-astra ultra · /fixture${goal ? '   Goal stalled (/goal resume)' : ''}`,
          execTmux: async args => {
            if (args.includes('Escape')) fixture.status = background ? 'background' : 'done';
            if (args.includes('-l')) draft = args.at(-1).trimEnd();
            if (args.at(-1) === 'Enter') {
              fixture.stopCommands.push(draft);
              if (draft === '/goal clear') goal = false;
              if (draft === '/stop') background = false;
              draft = '';
            }
          },
          waitForPaste: async () => {}, waitForStop: async () => {}, invalidatePaneSnapshot() {},
        });
        assert.equal(background, false); assert.equal(goal, false);
      }
      if (provider === 'qodercli') await fixture.stopQoder(target, guard);
      fixture.status = 'done'; publishSessions();
    },
    send: async (_target, text, guard) => {
      assert.equal(guard(), true);
      fixture.autonomySent.push(text);
      const turnId = `autonomy-${fixture.autonomySent.length}`;
      const entry = { id: turnId, status: 'inProgress', items: [
        { id: `${turnId}-user`, type: 'userMessage', content: [{ type: 'text', text }] },
      ] };
      fixture.turns.push(entry);
      fixture.status = 'working'; publishThread(); publishSessions();
      return { submissionStatus: 'submitted' };
    },
  });
  fixture.autonomy.on('change', run => {
    for (const socket of sockets.clients) send(socket, { type: 'autonomyState', run });
  });
}
function createFixtureRecovery() {
  return new CodexDeliveryRecovery({
    read: async ({ turnId }) => ({ data: [...(fixture.turns.find(turn => turn.id === turnId)?.items || [])]
      .reverse().map(item => ({ turnId, item })) }),
    observe() {},
  });
}
function snapshot() {
  return { capabilities: { canManage: true }, sessions: [{ name: 'fixture', status: fixture.status,
    agent: { kind: fixture.provider, id: 'fixture-thread', name: 'Remote fixture',
      hasBackgroundProcess: fixture.background || fixture.status === 'background',
      ...(fixture.question ? { question: fixture.question } : {}) } }] };
}
function thread() {
  return withoutDismissedDeliveries({ id: 'fixture-thread', provider: fixture.provider, readOnly: true, turns: fixture.turns.slice(-20),
    truncated: fixture.turns.length > 20, oldestTurnId: fixture.turns.at(-20)?.id,
    receivedDeliveryIds: fixture.receivedDeliveryIds,
    ...(fixture.recovery ? fixture.holdConfirmation ? fixture.recovery.snapshot('fixture-thread')
      : fixture.recovery.update('fixture-thread', fixture.turns) : {}),
    ...(fixture.liveOutput ? { liveOutput: fixture.liveOutput } : {}) }, [...fixture.dismissed]);
}
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fixture');
  if (url.pathname === '/api/agent-turn-images') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ images: [] }));
    return;
  }
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
    scopedSessionStop: true,
    autonomy: fixture.autonomy.snapshots(),
    protocol: { version: 1, epoch: fixture.epoch, commandReceiptTtlMs: 600_000 },
    providers: providers.map(id => ({ id, capabilities: { attachments: true, slashCommands: true, turnImages: id === 'codex', ...sessionCommandCapabilities(id) } })) });
  socket.on('message', async raw => {
    const request = JSON.parse(raw);
    const reply = result => send(socket, { id: request.id, ok: true, result });
    const autonomyTarget = { provider: request.provider, threadId: request.threadId, tmuxSession: request.tmuxSession };
    if (request.type === 'prepareAutonomyPlanning') return reply(await fixture.autonomy.preparePlanning(autonomyTarget));
    if (request.type === 'resetAutonomy') return reply({ autonomy: await fixture.autonomy.resetObserved(autonomyTarget) });
    if (request.type === 'interruptSession') {
      fixture.scopedStops.push(request);
      await fixture.autonomy.interrupt(autonomyTarget, async () => {
        if (fixture.holdManualStop) await new Promise(resolve => { fixture.finishManualStop = resolve; });
        if (fixture.provider === 'qodercli') await fixture.stopQoder(autonomyTarget, () => true, request.scope === 'all');
        fixture.status = request.scope === 'foreground' && fixture.background ? 'background' : 'done';
        for (const turn of fixture.turns) if (turn.status === 'inProgress') turn.status = 'completed';
        if (request.scope === 'all') fixture.background = false;
      });
      publishThread(); publishSessions(); return reply({});
    }
    if (request.type === 'openThread') {
      for (const id of request.dismissedDeliveryIds || []) { fixture.dismissed.add(id); fixture.recovery?.dismiss('fixture-thread', id); }
      for (const receipt of request.deliveryReceipts || []) {
        if (!fixture.dismissed.has(receipt.commandId)) fixture.recovery?.record({ ...receipt, threadId: 'fixture-thread', restored: true });
      }
      if (fixture.holdOpenThread) {
        fixture.finishOpening = () => reply({ thread: thread() });
        return;
      }
      return reply({ thread: thread() });
    }
    if (request.type === 'dismissSessionDelivery') {
      fixture.dismissed.add(request.deliveryId); fixture.recovery?.dismiss('fixture-thread', request.deliveryId);
      reply({ dismissedDeliveryIds: [request.deliveryId] }); publishThread(); return;
    }
    if (request.type === 'answerSessionQuestion') {
      assert.equal(request.questionId, fixture.question.id);
      assert.equal(request.tmuxSession, 'fixture');
      if (fixture.failQuestion) {
        fixture.failQuestion = false;
        return send(socket, { id: request.id, ok: false, error: '终端选项尚未更新，回答未发送，请重试' });
      }
      fixture.answer = request.answer;
      fixture.question = null;
      reply({ submitted: true });
      publishSessions();
      return;
    }
    if (request.type === 'loadThreadHistory') {
      const anchor = request.cursor ? decodeHistoryCursor(request.cursor, fixture.provider, 'fixture-thread') : request.beforeTurnId;
      assert.equal(anchor, request.beforeTurnId, 'cursor follows the current history boundary, including reconnect gaps');
      const end = fixture.turns.findIndex(turn => turn.id === anchor);
      const start = Math.max(0, end - 20);
      return reply({ turns: fixture.turns.slice(start, end), truncated: start > 0, oldestTurnId: fixture.turns[start]?.id,
        nextCursor: start > 0 ? encodeHistoryCursor(fixture.provider, 'fixture-thread', fixture.turns[start].id) : null });
    }
    if (request.type === 'selectSessionModel') {
      assert.equal(request.option, fixture.modelSelected ? 'Extra high' : 'model-a');
      if (fixture.modelSelected) return reply({ completed: true });
      fixture.modelSelected = true;
      const terminalOutput = 'Select Reasoning Level for model-a\n1. High  Deep\n› 2. Extra high (current) More reasoning';
      return reply({ terminalOutput, commandOutput: normalizeSessionCommandOutput(fixture.provider, '/model', { terminalOutput }) });
    }
    if (request.type === 'dismissSessionCommand') return reply({ dismissed: true });
    if (request.type === 'sendSessionMessage') {
      fixture.sent.push(request);
      if (request.text.startsWith('/')) {
        const terminalOutput = request.text === '/model'
          ? 'Select Model and Effort\n› 1. model-a (current) Fast\n2. model-b  Deep'
          : `Fixture ${request.text}\nModel: fixture-model\nUsage: 10%`;
        return reply({ terminalOutput, commandOutput: normalizeSessionCommandOutput(fixture.provider, request.text, { terminalOutput }) });
      }
      const accepted = { id: `sent-${fixture.sent.length}`, status: 'completed', items: [
        { id: `sent-user-${fixture.sent.length}`, type: 'userMessage', content: [{ type: 'text', text: request.text }] },
        { id: `sent-answer-${fixture.sent.length}`, type: 'agentMessage', text: '已处理 fixture 消息' },
      ] };
      fixture.recovery?.record(request);
      if (request.text === 'lost response') {
        fixture.turns.push(accepted);
        fixture.recovery?.close();
        if (fixture.provider === 'codex') fixture.recovery = createFixtureRecovery();
        fixture.receivedDeliveryIds = [];
        fixture.epoch = 'fixture-restarted';
        socket.close();
        return;
      }
      reply({ submissionStatus: 'unconfirmed', inputWasQueued: true });
      if (request.text === '延迟确认') fixture.holdConfirmation = true;
      setTimeout(() => {
        fixture.turns.push(accepted);
        if (request.text === '延迟确认') {
          fixture.confirmDelivery = () => {
            fixture.holdConfirmation = false;
            publishThread();
          };
          publishEvent('item/completed', { turnId: accepted.id, item: accepted.items[0] });
          publishThread();
          return;
        }
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
      if (simpleMode) {
        const auto = page.locator('#autonomyButton');
        fixture.status = 'working'; publishSessions();
        await page.locator('#composerInput').fill('尚未发送的草稿');
        await auto.click();
        await page.waitForFunction(() => !document.querySelector('#autonomyButton').disabled);
        assert.equal(fixture.sent.filter(request => request.text?.startsWith(AUTONOMY_PLANNING_PROMPT)).length, 1);
        assert.equal(fixture.autonomySent.length, 0); assert.equal(fixture.autonomyStops, 0);
        assert.equal(fixture.autonomy.snapshot({ provider, threadId: 'fixture-thread', tmuxSession: 'fixture' }).status, 'planning');
        assert.equal(await page.locator('#autonomyDialog').count(), 0);
        assert.equal(await page.locator('#composerInput').inputValue(), '尚未发送的草稿');
        assert.equal(await auto.getAttribute('aria-pressed'), 'false', 'planning is not execution');
        await page.locator('#progressButton').click();
        await page.waitForFunction(() => !document.querySelector('#progressButton').disabled);
        assert.ok(fixture.sent.some(request => request.text === progressPrompt));
        const confirm = page.locator('#confirmButton');
        await confirm.focus(); await page.keyboard.press('Enter');
        await page.waitForFunction(() => !document.querySelector('#confirmButton').disabled);
        assert.equal(fixture.sent.filter(request => request.text === 'OK').length, 1);
        assert.equal(await page.locator('#composerInput').inputValue(), '尚未发送的草稿');
        const confirmBox = await confirm.boundingBox();
        assert.ok(confirmBox.width >= 44 && confirmBox.height >= 44 && confirmBox.x + confirmBox.width <= viewport.width);
        await page.locator('#composerInput').fill('按此计划开始');
        await page.locator('#sendButton').click();
        await page.waitForFunction(() => document.querySelector('#composerInput').value === '');
        assert.ok(fixture.sent.some(request => request.text === '按此计划开始'));
        assert.equal(fixture.autonomySent.length, 0, 'confirmation stays in the Agent conversation');
        const observed = fixture.autonomy.runs.values().next().value;
        writeReceipt(['--receipt', observed.observation.startFile, '--status', 'started', '--goal', '修复输入', '--summary', '用户确认开始']);
        await fixture.autonomy.tick();
        await page.waitForFunction(() => document.querySelector('#autonomyButton').dataset.tone === 'running');
        await page.waitForFunction(() => document.querySelector('[data-tmux-session="fixture"] small')?.textContent.includes('自主执行中'));
        fixture.status = 'done'; publishSessions();
        await page.waitForFunction(() => document.querySelector('[data-tmux-session="fixture"] small')?.textContent.includes('自主模式·当前空闲'));
        await page.waitForFunction(() => getComputedStyle(document.querySelector('#autonomyButton .autonomy-icon')).borderTopColor === 'rgb(234, 179, 8)');
        writeReceipt(['--receipt', observed.observation.endFile, '--status', 'budget', '--summary', '预算已耗尽', '--next', '交接剩余验证']);
        await fixture.autonomy.tick();
        await page.waitForFunction(() => document.querySelector('#autonomyButton').dataset.state === 'ended');
        assert.equal(await auto.getAttribute('data-tone'), 'running', 'budget stop stays yellow');
        assert.equal(await auto.evaluate(el => el.closest('.composer-meta')?.id), 'composerMeta');
        await page.screenshot({ path: path.join(artifacts, provider + '-' + viewport.width + '-planning-shortcut.png') });
        await page.reload(); await auto.waitFor({ state: 'visible' });
        await page.waitForFunction(() => !document.querySelector('#autonomyButton').disabled);
        assert.equal(fixture.sent.filter(request => request.text?.startsWith(AUTONOMY_PLANNING_PROMPT)).length, 1, 'reconnect never resends');
        assert.equal(await auto.getAttribute('data-tone'), 'running', 'yellow outcome survives reconnect');
        await auto.click(); await page.waitForFunction(() => document.querySelector('#autonomyButton').dataset.tone === 'idle');
        assert.equal(fixture.sent.filter(request => request.text?.startsWith(AUTONOMY_PLANNING_PROMPT)).length, 1, 'first click only resets');
        await auto.click(); await page.waitForFunction(() => !document.querySelector('#autonomyButton').disabled);
        assert.equal(fixture.sent.filter(request => request.text?.startsWith(AUTONOMY_PLANNING_PROMPT)).length, 2, 'next click plans again');
        assert.equal(await page.locator('dialog[open]').count(), 0);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        assert.deepEqual(errors, []);
        results.push({ provider, viewport: viewport.width, journeys: 'planning-shortcut/draft/confirmation/progress/reconnect', errors: 0 });
        await context.close(); continue;
      }
      if (viewport.width < 720) await page.click('#drawerButton');
      await page.fill('#sessionSearch', 'NO-MATCH');
      assert.equal(await page.locator('#threadList .thread-row').count(), 0);
      assert.match(await page.textContent('#threadList'), /没有匹配/);
      await page.fill('#sessionSearch', 'FIXT');
      assert.equal(await page.locator('#threadList .thread-row').count(), 1);
      publishSessions();
      assert.equal(await page.inputValue('#sessionSearch'), 'FIXT');
      await page.screenshot({ path: path.join(artifacts, `${provider}-${viewport.width}-search.png`) });
      await page.fill('#sessionSearch', '');
      if (viewport.width < 720) await page.click('#drawerScrim', { position: { x: viewport.width - 5, y: 10 } });
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

      fixture.status = 'working';
      fixture.liveOutput = '正在整理结果\n- 保持输入和回复边界\n- 实时回显沿用最终回复样式';
      publishSessions();
      publishThread();
      await page.waitForSelector('.agent-live-activity .agent-live-output');
      if (viewport.width < 500) {
        await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
      }
      const liveSurface = await page.locator('.agent-live-activity').evaluate(node => ({
        tag: node.querySelector('.agent-live-output')?.tagName,
        outputClass: node.querySelector('.agent-live-output')?.className,
        background: getComputedStyle(node).backgroundColor,
        firstChild: node.firstElementChild?.className,
      }));
      assert.equal(liveSurface.tag, 'DIV');
      assert.match(liveSurface.outputClass, /assistant-message/);
      assert.doesNotMatch(liveSurface.outputClass, /terminal-live-output/);
      assert.match(liveSurface.firstChild, /assistant-message/);
      assert.equal(liveSurface.background, 'rgba(0, 0, 0, 0)');
      await page.getByRole('button', { name: '直达最新消息' }).click();
      await page.waitForFunction(() => { const node = document.querySelector('#transcript'); return node.scrollHeight - node.scrollTop - node.clientHeight < 3; });
      const liveBox = await page.locator('.agent-live-output').boundingBox();
      const transcriptBox = await page.locator('#transcript').boundingBox();
      assert.ok(liveBox.y >= transcriptBox.y && liveBox.y < transcriptBox.y + transcriptBox.height,
        'latest action exposes the live answer surface');
      await page.screenshot({ path: path.join(artifacts, `${provider}-${viewport.width}-live-output.png`) });
      fixture.status = 'done';
      fixture.liveOutput = '';
      publishThread();
      publishSessions();
      await page.waitForSelector('.agent-live-activity', { state: 'detached' });
      if (viewport.width < 500) {
        await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
      }

      await page.locator('#transcript').evaluate(node => { node.scrollTop = Math.min(100, node.scrollHeight - node.clientHeight); });
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
      await page.locator('#progressButton').click();
      assert.equal(await page.getByRole('button', { name: '允许一次', exact: true }).evaluate(node => node === document.activeElement), true);
      await page.getByRole('button', { name: '允许一次', exact: true }).click();
      await page.waitForSelector('.approval-card', { state: 'detached' });

      if (provider === 'qodercli') {
        const askingScreen = await fs.readFile(path.join(root, 'test/fixtures/qoder-asking-user-chat.txt'), 'utf8');
        fixture.question = new QoderQuestionTracker().observe('fixture',
          { kind: provider, id: 'fixture-thread', paneId: '%42' }, askingScreen);
        assert.ok(fixture.question, 'screenshot menu must reach Remote through the real parser');
        // A slow transcript must not hide a live question on session entry/reconnect.
        fixture.holdOpenThread = true;
        await page.reload();
        const dialog = page.locator('#nativeQuestionDialog');
        await page.waitForSelector('#nativeQuestionDialog[open]');
        assert.equal(await dialog.getByRole('radio').count(), 2);
        assert.equal(await dialog.locator('input:checked').count(), 0, 'never preselect an answer');
        assert.match(await dialog.textContent(), /TASK-035\/TASK-036/);
        assert.doesNotMatch(await dialog.textContent(), /Type something|Chat about this/);
        await page.waitForFunction(() => document.querySelector('#composerInput').disabled);
        assert.ok(fixture.finishOpening, 'history response is still pending when the question appears');
        fixture.holdOpenThread = false;
        fixture.finishOpening();
        await page.waitForFunction(() => !document.querySelector('#composerInput').disabled);
        await dialog.getByRole('button', { name: '回答并继续' }).click();
        assert.match(await dialog.locator('.question-error').textContent(), /请回答/);
        await dialog.getByRole('radio', { name: /Skip scan/ }).check();
        publishSessions();
        publishThread();
        assert.equal(await dialog.getByRole('radio', { name: /Skip scan/ }).isChecked(), true);
        fixture.failQuestion = true;
        await dialog.getByRole('button', { name: '回答并继续' }).click();
        await page.waitForFunction(() => document.querySelector('#nativeQuestionDialog .question-error').textContent.includes('回答未发送'));
        assert.equal(await dialog.getByRole('radio', { name: /Skip scan/ }).isChecked(), true);
        const box = await dialog.boundingBox();
        assert.ok(box.x >= 0 && box.x + box.width <= viewport.width + 1);
        await page.screenshot({ path: path.join(artifacts, `${provider}-${viewport.width}-native-question.png`) });
        await dialog.getByRole('button', { name: '回答并继续' }).click();
        await page.waitForSelector('#nativeQuestionDialog[open]', { state: 'detached' });
        assert.equal(fixture.answer, 'Skip scan and continue');
        fixture.question = { id: 'next-question', question: '继续下一步？', options: [{ label: 'Continue' }] };
        publishSessions();
        await page.waitForSelector('#nativeQuestionDialog[open]');
        await page.getByRole('button', { name: '稍后回答' }).click();
        publishSessions();
        assert.equal(await dialog.getAttribute('open'), null);
        assert.equal(fixture.question.id, 'next-question', 'closing browser modal does not answer or cancel native prompt');
        await page.locator('#progressButton').click();
        await page.waitForSelector('#nativeQuestionDialog[open]');
        await page.getByRole('button', { name: '稍后回答' }).click();
        fixture.question = null;
        publishSessions();
        await page.waitForSelector('#approvalStack .question-card', { state: 'detached' });
        const planFile = viewport.width < 500 ? 'qoder-plan-screen-clipped.txt' : 'qoder-plan-screen.txt';
        const planScreen = await fs.readFile(path.join(root, 'test/fixtures', planFile), 'utf8');
        fixture.question = new QoderQuestionTracker().observe('fixture',
          { kind: provider, id: 'fixture-thread', paneId: '%42' }, planScreen);
        assert.ok(fixture.question);
        publishSessions();
        await page.waitForSelector('#nativeQuestionDialog[open]');
        assert.match(await dialog.textContent(), viewport.width < 500 ? /不提交或推送代码/ : /Fix history reads and run tests/);
        assert.equal(await dialog.getByRole('radio').count(), 3);
        await dialog.getByRole('radio', { name: /^Reject plan/ }).check();
        await page.screenshot({ path: path.join(artifacts, `${provider}-${viewport.width}-plan-approval.png`) });
        await dialog.getByRole('button', { name: '回答并继续' }).click();
        await page.waitForSelector('#nativeQuestionDialog[open]', { state: 'detached' });
        assert.equal(fixture.answer, 'Reject plan');
        for (const [filename, answer, count] of [
          ['qoder-permission-command.txt', 'No', 3],
          ['qoder-empty-plan.txt', 'No, stay in plan mode', 2],
        ]) {
          const screen = await fs.readFile(path.join(root, 'test/fixtures', filename), 'utf8');
          fixture.question = new QoderQuestionTracker().observe('fixture',
            { kind: provider, id: 'fixture-thread', paneId: '%42' }, screen);
          assert.ok(fixture.question);
          publishSessions();
          await page.waitForSelector('#nativeQuestionDialog[open]');
          assert.equal(await dialog.getByRole('radio').count(), count);
          assert.equal(await dialog.locator('input:checked').count(), 0, 'never preselect an authorization');
          if (count === 3) {
            assert.match(await dialog.textContent(), /后续会话也生效/);
            const details = dialog.locator('.question-field > p');
            assert.equal(await details.evaluate(node => getComputedStyle(node).whiteSpace), 'pre-wrap');
            assert.match(await details.textContent(), /Command: printf 'hello\\n'\n  printf 'done\\n'/);
          }
          await dialog.getByRole('button', { name: '回答并继续' }).click();
          assert.match(await dialog.locator('.question-error').textContent(), /请回答/);
          await dialog.getByRole('radio', { name: new RegExp(`^${answer}(?: |$)`) }).check();
          const box = await dialog.boundingBox();
          assert.ok(box.x >= 0 && box.x + box.width <= viewport.width + 1);
          await page.screenshot({ path: path.join(artifacts, `${provider}-${viewport.width}-${filename}.png`) });
          await dialog.getByRole('button', { name: '回答并继续' }).click();
          await page.waitForSelector('#nativeQuestionDialog[open]', { state: 'detached' });
          assert.equal(fixture.answer, answer);
        }
        // Reload discarded the earlier pages used by the reconnect-gap journey below.
        for (let pageIndex = 0; pageIndex < 3 && !await page.locator('[data-turn-id="turn-41"]').count(); pageIndex += 1) {
          await page.getByRole('button', { name: '加载更早的对话' }).click();
          await page.getByRole('button', { name: '加载更早的对话' }).waitFor();
        }
        await page.waitForSelector('[data-turn-id="turn-41"]');
      }

      fixture.status = 'background'; publishSessions();
      await page.waitForFunction(() => document.querySelector('#composerStatus').textContent.includes('后台任务'));
      await page.locator('#composerInput').fill('正在写的草稿');
      const progress = page.getByRole('button', { name: '询问目标与进度，不打断当前任务', exact: true });
      const progressBox = await progress.boundingBox();
      const inputBox = await page.locator('#composerInput').boundingBox();
      assert.ok(progressBox.width >= 44 && progressBox.height >= 44);
      assert.ok(progressBox.y + progressBox.height <= inputBox.y);
      assert.equal(await progress.evaluate(node => node.closest('#composerMeta') != null), true);
      await progress.click();
      await page.getByText(progressPrompt, { exact: true }).last().waitFor();
      assert.equal(fixture.sent.at(-1).text, progressPrompt);
      assert.equal(await page.inputValue('#composerInput'), '正在写的草稿');
      await page.locator('#composerInput').fill('');
      for (const command of ['/status', '/usage', '/model']) {
        await page.locator('#composerInput').fill(command);
        await page.locator('#sendButton').click();
        await page.waitForSelector('#commandDialog[open]');
        if (command === '/model') assert.equal(await page.locator('.model-row').count(), provider === 'codex' ? 2 : 0);
        await page.screenshot({ path: path.join(artifacts, `${provider}-${viewport.width}-${command.slice(1)}.png`) });
        if (command === '/model' && provider === 'codex') {
          await page.locator('.model-row').first().click();
          await page.getByText('选择推理强度', { exact: true }).waitFor();
          await page.locator('.model-row').last().click();
        }
        else await page.locator('#commandDialogClose').click();
        await page.waitForSelector('#commandDialog[open]', { state: 'detached' });
      }
      if (provider === 'codex') {
        await page.locator('#composerInput').fill('延迟确认');
        await page.locator('#sendButton').click();
        await page.waitForSelector(`[data-turn-id="sent-${fixture.sent.length}"]`);
        assert.match(await page.locator('#transcript').textContent(), /等待 Agent 确认/,
          'raw user events and snapshots must not bypass the server confirmation');
        assert.equal(await page.inputValue('#composerInput'), '延迟确认');
        fixture.confirmDelivery();
        await page.waitForFunction(() => document.querySelector('#composerInput').value === '');
        assert.equal(await page.getByText('延迟确认', { exact: true }).count(), 1);
        assert.equal(fixture.sent.filter(request => request.text === '延迟确认').length, 1);
      }
      await page.locator('#composerInput').fill('消息确认');
      await page.locator('#sendButton').click();
      await page.waitForFunction(() => document.querySelector('#composerInput').value === '');
      assert.equal(await page.getByText('消息确认', { exact: true }).count(), 1);
      const sentBeforePaste = fixture.sent.length;
      await page.evaluate(() => {
        const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII='), ch => ch.charCodeAt(0));
        const data = new DataTransfer();
        data.items.add(new File([bytes], 'windows-screenshot.png', { type: 'image/png' }));
        document.querySelector('#composerInput').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      });
      assert.equal(await page.locator('.attachment-item').count(), 1);
      assert.equal(fixture.sent.length, sentBeforePaste);
      await page.getByRole('button', { name: '移除附件 windows-screenshot.png' }).click();
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
      // An edited short receipt is not evidence that the longer message was delivered.
      const sentBeforeDismiss = fixture.sent.length;
      fixture.turns.push({ id: 'edited-receipt', status: 'completed', items: [
        { id: 'edited-real', type: 'userMessage', content: [{ type: 'text', text: '问号不打断，A 进入自主模式' }] },
        { id: 'delivery:edited-command', type: 'userMessage', content: [{ type: 'text', text: '问号不打断' }],
          delivery: { status: 'unknown', commandId: 'edited-command' } },
      ] });
      publishThread();
      await page.getByRole('button', { name: '清除此提示' }).click();
      await page.waitForFunction(() => !document.querySelector('.delivery-dismiss'));
      assert.equal(await page.getByText('问号不打断，A 进入自主模式', { exact: true }).count(), 1);
      fixture.dismissed.clear(); // Simulate a server restart: browser carries dismissal forward.
      await page.reload();
      await page.getByText('问号不打断，A 进入自主模式', { exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: '清除此提示' }).count(), 0);
      assert.equal(fixture.sent.length, sentBeforeDismiss, 'clearing a receipt never resends input');
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
        journeys: 'history/latest/live-output/reading-position/reconnect-gap/background/failure/approval/progress/commands/selection/attachment/copy/receipt/lost-response/restart/autonomy/geometry', errors: 0 });
      await context.close();
    }
  }
  console.log(JSON.stringify({ artifacts, results }, null, 2));
} finally {
  fixture?.recovery?.close();
  fixture?.autonomy?.close();
  await browser.close();
  for (const socket of sockets.clients) socket.terminate();
  await new Promise(resolve => sockets.close(resolve));
  await new Promise(resolve => server.close(resolve));
}
