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
import { AUTONOMY_PROGRESS_PROMPT as progressPrompt } from '../public/remote-autonomy.js';
import { AutonomyController } from '../src/autonomy.js';
import { interruptSession } from '../src/tmux.js';
import { withoutDismissedDeliveries } from '../public/remote-delivery.js';

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
    readThread: async () => ({ thread: thread() }),
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
          capturePane: async () => `» ${draft}\n\n  gpt-6-astra ultra · /fixture${goal ? '   Goal stalled (/goal resume)' : ''}`,
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
      const nonce = /"nonce":"([^"]+)"/.exec(text)[1];
      fixture.finishAutonomy = (record, prose = '本轮检查已完成。') => {
        entry.status = 'completed';
        entry.items.push({ id: `${turnId}-answer`, type: 'agentMessage',
          text: `${prose}\n\n\`\`\`codeck-autonomy\n${JSON.stringify({ nonce, ...record })}\n\`\`\`` });
        fixture.status = 'done'; publishThread(); publishSessions();
      };
      fixture.status = 'working'; publishThread(); publishSessions();
      if (text.includes('"phase":"config"')) {
        fixture.finishConfig = () => fixture.finishAutonomy(fixture.autonomyPlan ? { status: 'ready', plan: fixture.autonomyPlan } : { status: 'ask', questions: [
          { id: 'goal', header: '目标', question: '这次推进哪个目标？', options: ['修复选择器并补回归', '只定位原因'] },
          { id: 'budget', header: '预算', question: '本次最多执行多少轮？', options: ['3 轮 / 30 分钟', '5 轮 / 60 分钟'] },
          { id: 'preferences', header: '偏好', question: '采用哪种执行边界？', options: ['最小修改，不提交部署', '先给设计再实施'] },
        ] }, fixture.autonomyPlan ? '目标与预算已整理，请在弹窗确认。' : '请在弹窗选择目标、预算和偏好。');
        if (!fixture.holdAutonomyConfig) fixture.finishConfig();
      }
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
    if (['startAutonomy', 'pauseAutonomy', 'answerAutonomy'].includes(request.type)) {
      if (request.type === 'startAutonomy') await fixture.autonomy.start(autonomyTarget);
      else if (request.type === 'answerAutonomy') await fixture.autonomy.respond(autonomyTarget, request);
      else fixture.autonomy.pause(autonomyTarget);
      await fixture.autonomy.tick(); await fixture.autonomy.tick();
      return reply({ autonomy: fixture.autonomy.snapshot(autonomyTarget) });
    }
    if (request.type === 'openThread') {
      fixture.autonomy.restoreProposal(autonomyTarget, thread());
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
      const autonomous = fixture.autonomy.snapshot(autonomyTarget);
      if (autonomous && !['completed', 'limit'].includes(autonomous.status) && request.text !== progressPrompt) {
        await fixture.autonomy.message(autonomyTarget, request.text);
        await fixture.autonomy.tick(); await fixture.autonomy.tick();
        return reply({ autonomyHandled: true, autonomy: fixture.autonomy.snapshot(autonomyTarget) });
      }
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
      // Actual controller + real UI; only the Agent's reasoning/results are fixtures.
      const auto = page.locator('#autonomyButton');
      assert.equal(await auto.locator('.autonomy-icon').textContent(), 'A');
      assert.equal(await auto.locator('#autonomyStatus').textContent(), '');
      await page.locator('#composerInput').fill('保留自主配置前的草稿');
      fixture.holdAutonomyConfig = true;
      fixture.status = viewport.width < 500 ? 'background' : 'working'; publishSessions();
      await auto.click();
      const dialog = page.locator('#autonomyDialog');
      await page.waitForFunction(() => document.querySelector('#autonomyStatus').textContent === '配置中');
      assert.match(await auto.getAttribute('aria-label'), /暂停自主配置/);
      assert.equal(fixture.autonomySent.length, 1, 'A sends configuration even while foreground/background work runs');
      assert.equal(fixture.autonomyStops, 0, 'configuration must not cancel the old task');
      assert.equal(await dialog.evaluate(node => node.open), false);
      if (provider === 'qodercli') {
        fixture.question = { id: 'autonomy-native-question', question: '是否执行终端操作？', options: [{ label: 'No' }, { label: 'Yes' }] };
        publishSessions(); await fixture.autonomy.tick();
        await page.waitForSelector('#nativeQuestionDialog[open]');
        await page.waitForFunction(() => document.querySelector('#autonomyStatus').textContent === '待处理');
        await page.getByRole('button', { name: '稍后回答' }).click();
        assert.equal(await auto.getAttribute('aria-label'), '处理 Agent 等待的问题');
        await auto.click(); await page.waitForSelector('#nativeQuestionDialog[open]');
        assert.equal(fixture.question.id, 'autonomy-native-question', 'A only opens the native question');
        const native = page.locator('#nativeQuestionDialog');
        await native.getByRole('radio', { name: 'No', exact: true }).check();
        await native.getByRole('button', { name: '回答并继续' }).click();
        await page.waitForSelector('#nativeQuestionDialog[open]', { state: 'detached' });
        await fixture.autonomy.tick();
        await page.waitForFunction(() => document.querySelector('#autonomyStatus').textContent === '配置中');
        assert.equal(fixture.autonomySent.length, 1);
      }
      await fixture.autonomy.tick();
      await page.waitForFunction(() => document.querySelector('#autonomyStatus').textContent === '配置中');
      assert.match(await auto.getAttribute('aria-label'), /暂停自主配置/);
      assert.equal(fixture.autonomySent.length, 1);
      await page.screenshot({ path: path.join(artifacts, `${provider}-${viewport.width}-autonomy-configuring.png`) });
      fixture.holdAutonomyConfig = false; fixture.finishConfig(); await fixture.autonomy.tick();
      await page.waitForFunction(() => document.querySelector('#autonomyStatus').textContent === '待回答');
      await dialog.getByText('这次推进哪个目标？', { exact: true }).waitFor();
      assert.equal(await page.inputValue('#composerInput'), '保留自主配置前的草稿');
      // research regression: a received ask reply outlives lost controller state.
      const setupRun = [...fixture.autonomy.runs.values()][0];
      fixture.autonomy.pause(setupRun.target, '发送状态未确认');
      await page.reload();
      await dialog.getByRole('heading', { name: '设置自主目标' }).waitFor();
      assert.equal(fixture.autonomySent.length, 1, 'choice recovery must not queue another continue');
      assert.equal(fixture.autonomyStops, 0);
      await page.screenshot({ path: path.join(artifacts, `${provider}-${viewport.width}-autonomy-recovered-choices.png`) });
      await dialog.getByRole('button', { name: '确认选择' }).click();
      await dialog.getByRole('alert').filter({ hasText: '请回答“目标”' }).waitFor();
      assert.equal(fixture.autonomySent.length, 1, 'an incomplete form cannot advance configuration');
      await dialog.getByRole('radio', { name: '修复选择器并补回归' }).check();
      await dialog.getByRole('radio', { name: '3 轮 / 30 分钟' }).check();
      await dialog.getByRole('textbox', { name: '偏好：自定义回答' }).fill('最小修改，不提交部署');
      await page.keyboard.press('Escape');
      assert.equal(await dialog.evaluate(node => node.open), false);
      assert.equal(fixture.autonomySent.length, 1, 'closing the modal does not approve execution');
      await auto.click();
      assert.equal(await dialog.getByRole('radio', { name: '修复选择器并补回归' }).isChecked(), true);
      await page.screenshot({ path: path.join(artifacts, `${provider}-${viewport.width}-autonomy-choices.png`) });
      fixture.autonomyPlan = { goal: '修复选择器', acceptance: '回归测试通过', maxRounds: 3,
        minutes: 30, preferences: '最小修改，不提交部署', advisoryBudget: '' };
      await dialog.getByRole('button', { name: '确认选择' }).click();
      await page.waitForFunction(() => document.querySelector('#autonomyStatus').textContent === '0/3 待确认');
      await dialog.getByRole('heading', { name: '确认自主目标' }).waitFor();
      assert.match(await dialog.locator('.autonomy-plan').textContent(), /修复选择器.*回归测试通过.*3 轮.*30 分钟.*不提交部署/);
      assert.equal(fixture.autonomySent.length, 2, 'a proposed plan is not yet authorized work');
      await page.screenshot({ path: path.join(artifacts, `${provider}-${viewport.width}-autonomy-confirm.png`) });
      assert.equal(await page.inputValue('#composerInput'), '');
      // report regression: the final ready reply exists, but a failed send check
      // lost the controller's proposal. Reopening recovers it without another prompt.
      const run = [...fixture.autonomy.runs.values()][0];
      run.proposal = null; fixture.autonomy.pause(run.target, '终端输入框未就绪');
      await page.reload();
      await dialog.getByRole('heading', { name: '确认自主目标' }).waitFor();
      assert.equal(fixture.autonomySent.length, 2, 'recovering a proposal must not resend setup');
      assert.equal(fixture.autonomyStops, 0);
      await dialog.getByText('确认停止旧任务，按此目标和预算执行？', { exact: true }).waitFor();
      fixture.holdAutonomyStop = true; fixture.failAutonomyStop = true; fixture.status = 'working'; publishSessions();
      // Keep explicit choice confirmation covered on desktop; mobile uses A itself.
      if (viewport.width < 500) {
        await page.keyboard.press('Escape');
        await page.locator('#composerInput').fill('保留确认前草稿');
        assert.match(await auto.getAttribute('aria-label'), /确认并执行/);
        await auto.focus(); await page.keyboard.press('Space');
      } else {
        await dialog.getByRole('radio', { name: '按此目标开始', exact: true }).check();
        await dialog.getByRole('button', { name: '确认选择' }).click();
      }
      await page.waitForFunction(() => document.querySelector('#autonomyStatus').textContent === '0/3 切换中');
      assert.equal(fixture.autonomySent.length, 2, 'new goal cannot start until old work is stopped');
      assert.equal(fixture.autonomyStops, 1);
      await page.screenshot({ path: path.join(artifacts, `${provider}-${viewport.width}-autonomy-switching.png`) });
      fixture.holdAutonomyStop = false; fixture.finishStop();
      await page.waitForFunction(() => document.querySelector('#autonomyStatus').textContent === '0/3 执行中 · 续跑关闭');
      await page.locator('#liveStatus').getByText('自主任务已暂停：旧任务未停止，新目标未启动', { exact: true }).waitFor();
      assert.equal(fixture.autonomySent.length, 2, 'failed cancellation spends no round and dispatches no work');
      if (provider === 'codex' || provider === 'qodercli') { fixture.status = 'background'; publishSessions(); }
      await auto.click();
      await page.waitForFunction(() => document.querySelector('#autonomyStatus').textContent === '1/3 执行中');
      assert.equal(fixture.autonomyStops, 2, 'only explicit retry can attempt cancellation again');
      if (provider === 'codex') assert.deepEqual(fixture.stopCommands, ['/goal clear', '/stop']);
      assert.equal(await page.inputValue('#composerInput'), viewport.width < 500 ? '保留确认前草稿' : '');
      assert.equal(await auto.getAttribute('aria-pressed'), 'true');
      const box = await auto.boundingBox(); assert.ok(box.width >= 44 && box.height >= 44);
      const groupedProgressBox = await page.locator('#progressButton').boundingBox();
      assert.ok(groupedProgressBox.width >= 44 && groupedProgressBox.height >= 44);
      assert.ok(box.x - (groupedProgressBox.x + groupedProgressBox.width) <= 1, 'session controls are adjacent');
      assert.equal(await auto.locator('.autonomy-icon').evaluate(node => getComputedStyle(node).borderRadius), '50%');
      assert.doesNotMatch(await page.locator('#turns').textContent(), /codeck-autonomy|"nonce"/);
      await page.screenshot({ path: path.join(artifacts, `${provider}-${viewport.width}-autonomy-running.png`) });
      const beforeReload = fixture.autonomySent.length;
      await page.reload();
      await page.waitForFunction(() => document.querySelector('#autonomyStatus').textContent === '1/3 执行中');
      assert.equal(fixture.autonomySent.length, beforeReload, 'reconnect cannot start another round');
      await auto.focus(); await page.keyboard.press('Space');
      await page.waitForFunction(() => document.querySelector('#autonomyStatus').textContent === '1/3 执行中 · 续跑关闭');
      await page.screenshot({ path: path.join(artifacts, `${provider}-${viewport.width}-autonomy-paused.png`) });
      fixture.finishAutonomy({ status: 'continue', summary: '旧方向完成一项', next: '旧方向', progress: true });
      await fixture.autonomy.tick(); assert.equal(fixture.autonomySent.length, beforeReload);
      fixture.status = 'background'; fixture.background = true; publishSessions();
      await page.locator('#composerInput').fill('');
      await page.waitForFunction(() => document.querySelector('#autonomyStatus').textContent.includes('后台执行中 · 续跑关闭'));
      await page.click('#sendButton');
      await page.getByRole('button', { name: '取消', exact: true }).click();
      assert.equal(fixture.scopedStops.length, 0);
      await page.click('#sendButton');
      await page.screenshot({ path: path.join(artifacts, `${provider}-${viewport.width}-stop-scope.png`) });
      fixture.holdManualStop = true;
      await page.getByRole('button', { name: '仅停止当前执行', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('#autonomyStatus').textContent.includes('停止中'));
      assert.equal(await auto.isDisabled(), true);
      fixture.holdManualStop = false; fixture.finishManualStop();
      await page.waitForFunction(() => document.querySelector('#autonomyStatus').textContent.includes('后台执行中 · 续跑关闭'));
      assert.equal(fixture.scopedStops.at(-1).scope, 'foreground');
      assert.equal(fixture.background, true);
      await page.screenshot({ path: path.join(artifacts, `${provider}-${viewport.width}-background-paused.png`) });
      if (provider === 'qodercli') {
        await page.click('#sendButton');
        await page.getByRole('button', { name: '全部停止', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('#liveStatus').textContent.includes('已停止本会话任务'));
        assert.equal(fixture.background, false);
        assert.ok(fixture.stopCommands.includes('k'));
      }
      fixture.status = 'done'; fixture.background = false; publishSessions();
      fixture.autonomyPlan.goal = '只修后端';
      await page.locator('#composerInput').fill('只修改后端，继续'); await page.locator('#sendButton').click();
      await page.waitForFunction(() => document.querySelector('#composerInput').value === '');
      await fixture.autonomy.tick();
      await page.waitForFunction(() => document.querySelector('#autonomyStatus').textContent === '2/3 执行中');
      assert.match(fixture.autonomySent.at(-1), /只修后端/);
      fixture.finishAutonomy({ status: 'complete', summary: '后端完成', evidence: '回归测试通过', progress: true });
      await fixture.autonomy.tick();
      await page.waitForFunction(() => document.querySelector('#autonomyStatus').textContent === '2/3 已完成');
      assert.equal(await auto.getAttribute('aria-pressed'), 'false');
      await page.screenshot({ path: path.join(artifacts, `${provider}-${viewport.width}-autonomy-completed.png`) });
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
