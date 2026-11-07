import { createIsolatedWorkspace } from './isolated-workspace.js';
import { createConditionalTasks } from './conditional-tasks.js';
import { sessionRpc } from './session-rpc.js';
import { sessionTarget } from './telegram-sessions.js';
import { createCheckpoints } from './session-checkpoints.js';
import { userMessageText } from '../public/agent-model.js';
import { sessionExecutionState } from '../public/execution-status.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { authenticateToken, createShareToken, terminalAccessForAuth } from './auth.js';
import { createAuthRateLimiter, requestClientAddress } from './auth-rate-limit.js';
import { createAgentBackends } from './agent-backends.js';
import { startTelegramService } from './telegram-runtime.js';
import { createTelegramSessionAdapter } from './telegram-session-adapter.js';
import { understandTelegram } from './telegram-routing.js';
import { createTelegramTask } from './telegram-task.js';
import { createPageStore, mountPublishedPages } from './published-pages.js';
import { createAgentImages } from './agent-images.js';
import { AgentHub, AgentRegistry } from './agent-connection.js';
import { answerSessionQuestion, createSession, detectWindowSizeSupport, dismissSessionCommand, interruptSession, killSession, listSessions, parseViewport, renameSession, selectSessionModel, sendSessionMessage, validateSessionName } from './tmux.js';
import { handleTerminalConnection } from './terminal-connection.js';
import { createTerminalHistoryLinkReader } from './terminal-history-links.js';
import { loadTlsOptions } from './tls.js';
import { createSessionSnapshotLoader } from './session-snapshot.js';
import { createSnapshotFeed } from './snapshot-feed.js';
import {
  resolveSessionStatus,
  sessionSnapshotRefreshInterval,
  threadSnapshotRefreshInterval,
} from './session-status.js';
import { AGENT_WEBSOCKET_OPTIONS, TERMINAL_WEBSOCKET_OPTIONS } from './websocket-options.js';
import {
  WEB_SESSION_TTL_SECONDS,
  authenticateWebSession,
  clearWebSessionCookie,
  createWebSessionToken,
  readWebSessionCookie,
  safeNextPath,
  serializeWebSessionCookie,
} from './web-session.js';
import {
  resolveDownloadPath,
  saveUploadStream,
  uploadRoot,
} from './uploads.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const host = process.env.HOST || '0.0.0.0';
const port = Number(process.env.PORT || 4310);
const configuredAccessToken = process.env.CODECK_TOKEN;
const accessToken = configuredAccessToken || crypto.randomBytes(18).toString('base64url');
const agentImages = createAgentImages(accessToken);
const webAuthEnabled = process.env.CODECK_WEB_AUTH === '1';
const publicDir = path.join(dirname, '../public');
const app = express();
const terminalHistoryLinks = createTerminalHistoryLinkReader();
const sessionSnapshots = createSessionSnapshotLoader(listSessions);
const checkpoints = await createCheckpoints(path.join(process.env.CODECK_DATA_DIR || path.join(os.homedir(), '.codeck'), 'checkpoints.json'));
const protocolEpoch = crypto.randomUUID();
const sessionStatusByName = new Map();
const sessionPaneExcerpts = new Map();
let flexibleSizePromise = null;
const authRateLimiter = createAuthRateLimiter();
app.disable('x-powered-by');
app.use(setSecurityHeaders);
const parseJson = express.json({ limit: '16kb' });
const parsePageJson = express.json({ limit: '20mb' });
app.use((req, res, next) => {
  if (req.method === 'POST' && ['/api/uploads/images', '/api/uploads/files'].includes(req.path)) return next();
  if (req.path === '/api/pages' || req.path.startsWith('/api/pages/') || req.path.startsWith('/pages/')) return parsePageJson(req, res, next);
  return parseJson(req, res, next);
});

function setSecurityHeaders(_req, res, next) {
  res.set({
    'Content-Security-Policy': "frame-ancestors 'none'",
    'Permissions-Policy': 'microphone=(self), on-device-speech-recognition=(self)',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  });
  next();
}

function requestAuth(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return authenticateToken(accessToken, header.slice(7));
  if (webAuthEnabled && req.method === 'GET' && req.path === '/download' && requestHasWebSession(req)) {
    return { owner: true, session: null, canWrite: true };
  }
  return null;
}

function ownerOnly(req, res, next) {
  return req.auth.owner ? next() : res.status(403).json({ error: '分享链接无权管理会话' });
}

function rejectRateLimited(res, retryAfter) {
  res.set('Retry-After', String(retryAfter));
  return res.status(429).json({ error: '鉴权尝试次数过多，请稍后再试' });
}

function authenticateApiRequest(req, res, next) {
  const address = requestClientAddress(req);
  const limit = authRateLimiter.status(address);
  if (limit.blocked) return rejectRateLimited(res, limit.retryAfter);
  req.auth = requestAuth(req);
  if (req.auth) {
    if (req.auth.owner) authRateLimiter.reset(address);
    return next();
  }
  authRateLimiter.recordFailure(address);
  return res.status(401).json({ error: '访问令牌无效或分享链接已过期' });
}

function requestHasWebSession(req) {
  const token = readWebSessionCookie(req.headers.cookie);
  return authenticateWebSession(accessToken, token);
}

function requireWebSession(req, res, next) {
  if (!webAuthEnabled || req.path.startsWith('/api/') || requestHasWebSession(req)) return next();
  res.set('Cache-Control', 'no-store');
  const acceptsHtml = (req.headers.accept || '').includes('text/html');
  const navigation = req.method === 'GET' && (req.get('sec-fetch-mode') === 'navigate' || acceptsHtml);
  if (navigation) {
    const target = safeNextPath(req.originalUrl);
    return res.redirect(302, `/login.html?next=${encodeURIComponent(target)}`);
  }
  return res.status(401).json({ error: '请先登录 Codeck' });
}

function setLoginPageHeaders(res) {
  res.set({
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; connect-src 'self'; form-action 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  });
}

app.get('/login.html', (req, res) => {
  if (!webAuthEnabled) return res.redirect('/');
  if (requestHasWebSession(req)) return res.redirect(safeNextPath(req.query.next));
  setLoginPageHeaders(res);
  return res.sendFile(path.join(publicDir, 'login.html'));
});

app.post('/api/web-login', (req, res) => {
  if (!webAuthEnabled) return res.status(404).json({ error: '持久登录未启用' });
  const address = requestClientAddress(req);
  const limit = authRateLimiter.status(address);
  if (limit.blocked) return rejectRateLimited(res, limit.retryAfter);
  const auth = authenticateToken(accessToken, req.body?.token);
  res.set('Cache-Control', 'no-store');
  if (!auth?.owner) {
    authRateLimiter.recordFailure(address);
    return res.status(401).json({ error: '访问令牌不正确' });
  }
  authRateLimiter.reset(address);
  const now = Date.now();
  const token = createWebSessionToken(accessToken, now);
  res.setHeader('Set-Cookie', serializeWebSessionCookie(token, now));
  return res.json({
    ok: true,
    next: safeNextPath(req.body?.next),
    expiresAt: now + WEB_SESSION_TTL_SECONDS * 1000,
  });
});

app.post('/api/web-logout', (_req, res) => {
  if (!webAuthEnabled) return res.status(404).json({ error: '持久登录未启用' });
  res.set('Cache-Control', 'no-store');
  res.setHeader('Set-Cookie', clearWebSessionCookie());
  return res.status(204).end();
});

app.use('/api', authenticateApiRequest);
mountPublishedPages(app, {
  store: createPageStore(path.join(process.env.CODECK_DATA_DIR || path.join(os.homedir(), '.codeck'), 'pages')),
  resolveTarget: async name => sessionTarget(await sessionSnapshots.get(), name),
  sendFeedback: async (target, text, commandId) => {
    const live = sessionTarget(await listSessions(), target.tmuxSession);
    if (live.provider !== target.provider || live.threadId !== target.threadId) throw new Error('来源会话身份已变化，未发送');
    return sessionRpc({ url: `https://127.0.0.1:${port}`, token: accessToken, ca: String(tls.cert) }, { type: 'sendSessionMessage', ...target, text, commandId });
  },
  apiAuth: (_req, _res, next) => next(), // Already authenticated by the /api middleware above.
  pageAuth: (req, res, next) => {
    if (req.headers.authorization) return authenticateApiRequest(req, res, () => ownerOnly(req, res, next));
    if (requestHasWebSession(req)) return next();
    res.set('Cache-Control', 'no-store');
    return webAuthEnabled ? res.redirect(`/login.html?next=${encodeURIComponent(req.originalUrl)}`)
      : res.status(401).json({ error: '请使用主 Token 访问；浏览器登录需启用 CODECK_WEB_AUTH' });
  },
});

app.get('/api/tasks', ownerOnly, async (_req, res, next) => {
  try { res.json({ tasks: await conditionalTasks.list() }); } catch (error) { next(error); }
});
app.put('/api/tasks/:id', ownerOnly, async (req, res, next) => {
  try {
    const target = sessionTarget(await listSessions(), req.body?.session);
    res.json(await conditionalTasks.put(req.params.id, { ...req.body, ...target, session: target.tmuxSession }));
  } catch (error) { next(error); }
});
app.delete('/api/tasks/:id', ownerOnly, async (req, res, next) => {
  try { await conditionalTasks.remove(req.params.id); res.sendStatus(204); } catch (error) { next(error); }
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.get('/api/services', ownerOnly, (_req, res) => res.json({
  connection: 'enabled', delivery: 'enabled',
  telegram: { configured: Boolean(process.env.CODECK_TELEGRAM_CONFIG), status: telegram?.status || 'disabled' },
}));
let telegramSettingPending = false;
app.post('/api/services/telegram', ownerOnly, async (req, res, next) => {
  if (telegramSettingPending) return res.status(409).json({ error: '正在更新服务设置' });
  if (!process.env.CODECK_TELEGRAM_CONFIG) return res.status(400).json({ error: '请先配置 Telegram Bot' });
  if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ error: 'enabled 必须为布尔值' });
  telegramSettingPending = true;
  try {
    const file = process.env.CODECK_TELEGRAM_CONFIG;
    const config = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    await fs.promises.writeFile(`${file}.tmp`, JSON.stringify({ ...config, enabled: req.body.enabled }, null, 2), { mode: 0o600 });
    await fs.promises.rename(`${file}.tmp`, file);
    telegram?.stop(); await telegram?.done;
    startConfiguredTelegram();
    res.json({ status: telegram?.status || 'disabled' });
  } catch (error) { next(error); }
  finally { telegramSettingPending = false; }
});

// Owner-only stream accounting: how much the delta protocol actually saves, per feed.
app.get('/api/stream-stats', ownerOnly, (_req, res) => res.json({
  sessions: sessionFeed.stats(),
  threads: threadFeed.stats(),
}));

function flexibleSizeSupport() {
  if (!flexibleSizePromise) {
    flexibleSizePromise = Promise.resolve().then(() => detectWindowSizeSupport()).catch((error) => {
      flexibleSizePromise = null;
      throw error;
    });
  }
  return flexibleSizePromise;
}

async function sessionSnapshotForAuth(auth) {
  let [sessions, flexibleSize] = await Promise.all([sessionSnapshots.get(), flexibleSizeSupport()]);
  await checkpoints.observe(sessions.map(session => ({ ...session, status: resolveSessionStatus(session),
    pendingApprovalId: [...agentHub.pendingRequests.values()].find(({ provider, request }) =>
      provider === session.agent?.kind && request.params?.threadId === session.agent?.id)?.request.id,
  })));
  if (!auth.owner) sessions = sessions.filter((session) => session.name === auth.session);
  const enriched = sessions.map((session) => {
    // 有结构化会话的, pane 摘录走 thread 通道 (sessionPaneExcerpts), 不在这里广播。
    // 但 shell 会话与还没暴露 thread id 的 agent 会话从不开 thread, 会话列表是它们
    // 唯一的内容来源 —— 对这两类必须继续带上, 否则连最近的输出都看不到。
    const { paneId: _paneId, liveOutput, ...publicSession } = session;
    const threadless = !session.agent || !session.agent.id;
    return {
      ...publicSession,
      ...(auth.owner ? { checkpoint: checkpoints.get(session) } : {}),
      ...(auth.owner && threadless && liveOutput ? { liveOutput } : {}),
      agent: session.agent ? {
        kind: session.agent.kind,
        id: session.agent.id,
        name: session.agent.name,
        activity: session.agent.activity,
        ...(auth.owner && session.agent.question ? { question: session.agent.question } : {}),
        ...(auth.owner && threadless && session.agent.liveOutput
          ? { liveOutput: session.agent.liveOutput } : {}),
      } : null,
      status: resolveSessionStatus(session),
      executionState: sessionExecutionState({ ...session, status: resolveSessionStatus(session) }),
    };
  });
  return {
    sessions: enriched,
    capabilities: {
      flexibleSize,
      canManage: auth.owner,
      canWrite: auth.canWrite,
      canSwitchSession: auth.owner,
      terminalSubmit: true,
    },
  };
}

function invalidateSessionSnapshots() {
  sessionSnapshots.invalidate();
  return sessionFeed.invalidate('sessions');
}

app.get('/api/sessions', async (req, res, next) => {
  try {
    res.json(await sessionSnapshotForAuth(req.auth));
  } catch (error) { next(error); }
});

app.put('/api/sessions/:name/checkpoint', ownerOnly, async (req, res, next) => {
  try {
    const session = (await sessionSnapshots.get()).find(s => s.name === req.params.name);
    if (!session) return res.status(404).json({ error: '会话不存在' });
    if (req.body?.threadId !== session.agent?.id) return res.status(409).json({ error: '会话身份已变化，请重新读取' });
    await checkpoints.set(session, req.body);
    await invalidateSessionSnapshots();
    res.json(checkpoints.get(session));
  } catch (error) { next(error); }
});
app.post('/api/sessions/:name/attention/read', ownerOnly, async (req, res, next) => {
  try {
    const session = (await sessionSnapshots.get()).find(s => s.name === req.params.name);
    if (!session) return res.sendStatus(404);
    await checkpoints.ack(session, req.body?.id);
    await invalidateSessionSnapshots(); res.sendStatus(204);
  } catch (error) { next(error); }
});

app.get('/api/sessions/:name/terminal-links', async (req, res, next) => {
  if (!req.auth.owner && req.auth.session !== req.params.name) return res.sendStatus(403);
  res.set('Cache-Control', 'no-store');
  try { res.json(await terminalHistoryLinks(req.params.name)); }
  catch (error) { next(error); }
});

app.post('/api/sessions', ownerOnly, async (req, res, next) => {
  try {
    const options = req.body || {};
    if (options.worktree) {
      if (!validateSessionName(options.name) || (await listSessions()).some(s => s.name === options.name)) return res.status(409).json({ error: '会话名无效或已存在' });
      const cwd = await createIsolatedWorkspace(options);
      try { await createSession({ ...options, cwd }); }
      catch (error) { throw new Error(`${error.message}；独立工作区保留在 ${cwd}，请核实会话后再处理`); }
    } else await createSession(options);
    invalidateSessionSnapshots().catch(() => {});
    res.status(201).json({ ok: true });
  } catch (error) { next(error); }
});

app.patch('/api/sessions/:name', ownerOnly, async (req, res, next) => {
  try {
    await renameSession(req.params.name, req.body?.name);
    invalidateSessionSnapshots().catch(() => {});
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.delete('/api/sessions/:name', ownerOnly, async (req, res, next) => {
  try {
    await killSession(req.params.name);
    invalidateSessionSnapshots().catch(() => {});
    res.status(204).end();
  } catch (error) { next(error); }
});

app.post('/api/sessions/:name/share', ownerOnly, async (req, res, next) => {
  try {
    const session = (await listSessions()).find((item) => item.name === req.params.name);
    if (!session) return res.status(404).json({ error: '会话不存在' });
    const token = createShareToken(accessToken, session.name);
    const url = new URL('/', 'https://codeck.local');
    url.hash = new URLSearchParams({ share: token });
    res.status(201).json({ url: `${url.pathname}${url.hash}`, expiresAt: Date.now() + 86400 * 1000 });
  } catch (error) { next(error); }
});

app.post('/api/uploads/images', ownerOnly, async (req, res, next) => {
  try {
    req.setTimeout(180_000);
    const contentType = req.headers['content-type']?.split(';')[0].trim().toLowerCase();
    res.status(201).json({ path: await saveUploadStream(req, { contentType: contentType || 'application/octet-stream' }) });
  } catch (error) { next(error); }
});

app.post('/api/uploads/files', ownerOnly, async (req, res, next) => {
  try {
    req.setTimeout(180_000);
    const fileName = req.query.name || req.get('x-file-name') || 'upload';
    const relativePath = req.query.relativePath || req.get('x-relative-path') || '';
    res.status(201).json({ path: await saveUploadStream(req, { fileName, relativePath }) });
  } catch (error) { next(error); }
});

app.get('/api/download', ownerOnly, (req, res, next) => {
  try {
    const filePath = resolveDownloadPath(req.query.path, uploadRoot);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: '文件不存在' });
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return res.status(400).json({ error: '只能下载文件' });
    res.download(filePath, path.basename(filePath));
  } catch (error) { next(error); }
});

app.get('/api/agent-images/:token', ownerOnly, agentImages.serve);
app.get('/api/agent-turn-images', ownerOnly, async (req, res) => {
  const { provider, threadId, turnId } = req.query;
  if (provider !== 'codex' || ![threadId, turnId].every(value => typeof value === 'string' && /^[\w.:-]{1,200}$/u.test(value))) {
    return res.status(400).json({ error: '图片会话信息无效' });
  }
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });
  try {
    const refs = await agentRegistry.backend(provider).readTurnImages(threadId, turnId, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
    });
    res.set('Cache-Control', 'private, no-store').json({ images: agentImages.describe(refs) });
  } catch {
    if (!res.destroyed) res.status(503).json({ error: '图片信息暂时无法读取，可稍后重试' });
  }
});

// Public install metadata contains no account or session data.
app.get('/manifest.webmanifest', (_req, res) => res.sendFile(path.join(publicDir, 'manifest.webmanifest')));
app.get('/app-icon.png', (_req, res) => res.sendFile(path.join(publicDir, 'app-icon.png')));
app.use(requireWebSession);
app.use('/vendor', express.static(path.join(dirname, '../node_modules/@xterm/xterm/css')));
app.use('/vendor/xterm', express.static(path.join(dirname, '../node_modules/@xterm/xterm/lib')));
app.use('/vendor/fit', express.static(path.join(dirname, '../node_modules/@xterm/addon-fit/lib')));
app.use('/vendor/webgl', express.static(path.join(dirname, '../node_modules/@xterm/addon-webgl/lib')));
app.use('/vendor/web-links', express.static(path.join(dirname, '../node_modules/@xterm/addon-web-links/lib')));
app.use('/fonts/inter', express.static(path.join(dirname, '../node_modules/@fontsource-variable/inter')));
app.use('/fonts/noto-sans-sc', express.static(path.join(dirname, '../node_modules/@fontsource-variable/noto-sans-sc')));
app.use(express.static(publicDir));
app.use((error, _req, res, _next) => {
  const status = error.type === 'entity.too.large' || error.status === 413
    ? 413
    : /无效|只能|未知|格式|为空|非法|上传/.test(error.message)
      ? 400
      : 500;
  if (status === 413) res.set('Connection', 'close');
  res.status(status).json({ error: error.message || '服务器操作失败' });
});

const tls = loadTlsOptions();
const server = https.createServer({ cert: tls.cert, key: tls.key }, app);
// Allow large uploads beyond Node's five-minute body deadline; idle sockets remain bounded.
server.requestTimeout = 24 * 60 * 60_000;
const wss = new WebSocketServer({ noServer: true, ...TERMINAL_WEBSOCKET_OPTIONS });
const agentWss = new WebSocketServer({ noServer: true, ...AGENT_WEBSOCKET_OPTIONS });
const agentRegistry = new AgentRegistry(createAgentBackends(), {
  decorateTranscript: agentImages.decorate,
  listTmuxSessions: listSessions,
  sendTmuxMessage: sendSessionMessage,
  answerTmuxQuestion: answerSessionQuestion,
  selectTmuxModel: selectSessionModel,
  dismissTmuxCommand: dismissSessionCommand,
  interruptTmuxSession: interruptSession,
});
const sessionFeed = createSnapshotFeed(
  async () => {
    const raw = await sessionSnapshots.get();
    const snapshot = await sessionSnapshotForAuth({ owner: true, session: null, canWrite: true });
    sessionStatusByName.clear();
    for (const session of snapshot.sessions) sessionStatusByName.set(session.name, session.status);
    sessionPaneExcerpts.clear();
    for (const session of raw) {
      const excerpt = session.agent?.liveOutput || session.liveOutput || '';
      if (excerpt) sessionPaneExcerpts.set(session.name, excerpt);
    }
    return snapshot;
  },
  { epoch: protocolEpoch, intervalMs: sessionSnapshotRefreshInterval },
);
function withPaneExcerpt(result, tmuxSession) {
  const excerpt = sessionPaneExcerpts.get(tmuxSession);
  if (!excerpt || !result?.thread) return result;
  return { ...result, thread: { ...result.thread, liveOutput: excerpt } };
}

// 轮询流只读取并携带尾部窗口，避免反复补全和传输更早的 turn。
// 早期历史由客户端按需分页；truncated 表示窗口外的记录不是被删除了。
const THREAD_STREAM_TURN_WINDOW = 20;

function windowedThread(result, limit = THREAD_STREAM_TURN_WINDOW) {
  const turns = result?.thread?.turns;
  if (!Array.isArray(turns) || turns.length <= limit) return result;
  const kept = turns.slice(-limit);
  return {
    ...result,
    thread: { ...result.thread, truncated: true, turns: kept, oldestTurnId: kept[0]?.id || null },
  };
}

const threadFeed = createSnapshotFeed(
  async ({ provider, threadId, tmuxSession }) => {
    const result = await agentRegistry.openThread(provider, threadId, {
      readOnly: true, turnLimit: THREAD_STREAM_TURN_WINDOW,
      deferCompactionRestore: provider === 'qodercli',
    });
    const session = (await sessionSnapshots.get()).find(s => s.name === tmuxSession && s.agent?.id === threadId && s.agent?.kind === provider);
    if (session && !result?.thread?.historyLoading && !result?.thread?.historyError) await checkpoints.observeTurn(session, result?.thread?.turns?.at(-1));
    return windowedThread(withPaneExcerpt(result, tmuxSession));
  },
  {
    epoch: protocolEpoch,
    intervalMs: (snapshot, target) => threadSnapshotRefreshInterval(
      snapshot, sessionStatusByName.get(target.tmuxSession),
    ),
    resourceKey: ({ provider, threadId, tmuxSession }) => `${provider}:${threadId}:${tmuxSession || ''}`,
  },
);
const agentHub = new AgentHub(agentRegistry, {
  defaultCwd: process.cwd(),
  hostname: os.hostname(),
  protocolEpoch,
  sessionFeed,
  threadFeed,
  invalidateSessions: invalidateSessionSnapshots,
  paneExcerpt: (tmuxSession) => sessionPaneExcerpts.get(tmuxSession) || '',
});
const conditionalTasks = await createConditionalTasks({
  directory: path.join(process.env.CODECK_DATA_DIR || path.join(os.homedir(), '.codeck'), 'conditional-tasks'),
  idle: async task => {
    const sessions = await listSessions(), target = sessionTarget(sessions, task.session);
    if (target.provider !== task.provider || target.threadId !== task.threadId) throw new Error('目标会话已变化，请重新配置任务');
    const session = sessions.find(s => s.name === task.session);
    return sessionExecutionState({ ...session, status: resolveSessionStatus(session) }) === 'idle';
  },
  settled: async (task, last) => {
    const result = await agentRegistry.openThread(task.provider, task.threadId, { readOnly: true, turnLimit: 20, deferCompactionRestore: true });
    if (result?.thread?.historyLoading || result?.thread?.historyError) return false;
    return (result?.thread?.turns || []).some(turn => ['completed', 'failed', 'errored', 'interrupted', 'cancelled'].includes(turn.status)
      && (turn.items || []).some(item => item.type === 'userMessage' && userMessageText(item).includes(last.commandId)));
  },
  send: async (task, commandId, event) => sessionRpc({ url: `https://127.0.0.1:${port}`, token: accessToken, ca: String(tls.cert) }, {
    type: 'sendSessionMessage', provider: task.provider, threadId: task.threadId, tmuxSession: task.session,
    text: `${task.prompt}\n\n条件检查事件：${event}\n调度请求标识：${commandId}`, commandId,
  }),
});
let taskTimer;
let checkpointTimer;
let telegram;

server.on('upgrade', (req, socket, head) => {
  const address = requestClientAddress(req);
  const limit = authRateLimiter.status(address);
  if (limit.blocked) {
    socket.write(`HTTP/1.1 429 Too Many Requests\r\nRetry-After: ${limit.retryAfter}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
    return;
  }
  const url = new URL(req.url, 'http://localhost');
  const protocols = (req.headers['sec-websocket-protocol'] || '').split(',').map((value) => value.trim());
  const encodedToken = protocols.find((value) => value.startsWith('codeck.'))?.slice(7);
  const credential = encodedToken ? Buffer.from(encodedToken, 'base64url').toString('utf8') : '';
  const auth = authenticateToken(accessToken, credential);
  if (!auth) authRateLimiter.recordFailure(address);
  else if (auth.owner) authRateLimiter.reset(address);
  if (url.pathname === '/agent') {
    if (!auth?.owner) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    const streamVersion = url.searchParams.get('streamVersion') === '2' ? 2 : 1;
    agentWss.handleUpgrade(req, socket, head, (ws) => agentWss.emit('connection', ws, { streamVersion }));
    return;
  }
  const session = url.searchParams.get('session');
  if (url.pathname !== '/ws' || !auth || (!auth.owner && auth.session !== session)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  if (!validateSessionName(session)) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }
  const viewport = parseViewport(url.searchParams);
  const outputFlowId = url.searchParams.get('flowId');
  const outputFlowControl = url.searchParams.get('flowControl') === '1'
    && /^[1-9]\d{0,15}$/.test(outputFlowId || '');
  const terminalAccess = {
    ...terminalAccessForAuth(auth, { recovery: url.searchParams.get('recovery') === '1' }),
    canSwitchSession: auth.owner,
    outputProtocol: url.searchParams.get('outputProtocol') === '1' ? 1 : 0,
    outputFlowControl,
    outputFlowId: outputFlowControl ? outputFlowId : null,
    onSessionActivity: () => invalidateSessionSnapshots().catch(() => {}),
  };
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, session, viewport, terminalAccess));
});

wss.on('connection', (ws, session, viewport, terminalAccess) => handleTerminalConnection(ws, session, viewport, terminalAccess));
agentWss.on('connection', (ws, options) => agentHub.handleConnection(ws, options));
server.on('close', () => {
  clearInterval(taskTimer);
  clearInterval(checkpointTimer);
  telegram?.stop();
  sessionFeed.close();
  threadFeed.close();
  agentRegistry.close();
});

function startConfiguredTelegram() {
  if (process.env.CODECK_TELEGRAM_CONFIG) {
    const sessions = createTelegramSessionAdapter({
      connection: { url: `https://127.0.0.1:${port}`, token: accessToken, ca: String(tls.cert) },
      list: async () => (await sessionSnapshotForAuth({ owner: true })).sessions,
      read: async target => (await threadFeed.refresh(target))?.snapshot,
      pendingRequests: () => [...agentHub.pendingRequests.values()],
      create: async task => { const result = await createTelegramTask(task); await invalidateSessionSnapshots(); return result; },
    });
    telegram = startTelegramService({ configFile: process.env.CODECK_TELEGRAM_CONFIG,
      directory: path.join(process.env.CODECK_DATA_DIR || path.join(os.homedir(), '.codeck'), 'telegram'), sessions, understand: understandTelegram });
  }
}
server.listen(port, host, () => {
  startConfiguredTelegram();
  taskTimer = setInterval(() => conditionalTasks.tick().catch(error => console.error('Conditional tasks:', error.message)), 30_000);
  taskTimer.unref();
  checkpointTimer = setInterval(() => sessionSnapshotForAuth({ owner: true }).catch(error => console.error('Session checkpoints:', error.message)), 10_000);
  checkpointTimer.unref();
  console.log(`Codeck is running at https://${host}:${port}`);
  if (tls.generated) console.log('TLS: using the persistent self-signed certificate in ~/.codeck');
  if (configuredAccessToken) console.log('Access token: configured through CODECK_TOKEN');
  else console.log(`Access token: ${accessToken}`);
});
