import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { COMMAND_RECEIPT_TTL_MS, cleanCommandId, createCommandReceiptCache } from './command-receipts.js';
import { resolveSessionStatus } from './session-status.js';
import { stripTerminalInputResidue } from '../public/terminal-input.js';
import { latestAgentOutputText } from '../public/remote-copy.js';
import { encodeHistoryCursor, decodeHistoryCursor } from './thread-history-cursor.js';
import { deliveryInsertionIndex, isUserMessageDeliveryConfirmed } from '../public/agent-model.js';
import { normalizeSessionCommandOutput, sessionCommandCapabilities } from '../public/remote-command-output.js';
import { isAutonomyObservation } from '../public/remote-autonomy.js';
import { withoutDismissedDeliveries } from '../public/remote-delivery.js';

const SESSION_START_MATCH_MS = 120_000;
const SESSION_MESSAGE_RECEIPT_TTL_MS = 24 * 60 * 60_000;
const SESSION_MESSAGE_RECEIPT_LIMIT = 1_024;

function approvalKey(provider, id) {
  return `${provider}:${String(id)}`;
}

function subscriptionKey(provider, threadId) {
  return `${provider}:${threadId}`;
}

const AFTER_REPLY = Symbol('afterReply');

function afterReply(result, activate) {
  return { [AFTER_REPLY]: true, result, activate };
}

function send(socket, message) {
  if (socket.readyState === 1) socket.send(JSON.stringify(message));
}

function cleanProvider(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function cleanId(value, label) {
  const result = typeof value === 'string' ? value.trim() : '';
  if (!result) throw new Error(`${label} is required`);
  return result;
}

function cleanMessage(value) {
  const result = typeof value === 'string' ? value.trim() : '';
  if (!result) throw new Error('Message cannot be empty');
  if (result.length > 100_000) throw new Error('Message is too long');
  return result;
}

function cleanRequestId(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return cleanId(value, 'Request');
}

function cleanStreamCursor(value) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.epoch !== 'string' || !value.epoch
    || !Number.isSafeInteger(value.sequence) || value.sequence < 0) {
    throw new Error('Invalid stream cursor');
  }
  return { epoch: value.epoch, sequence: value.sequence };
}

function threadRelativePatch(operations) {
  if (!Array.isArray(operations)) return null;
  const rebased = [];
  for (const operation of operations) {
    const path = operation?.path;
    if (!Array.isArray(path) || path[0] !== 'thread'
      || (operation.op === 'remove' && path.length === 1)) return null;
    rebased.push({ ...operation, path: path.slice(1) });
  }
  return rebased;
}

function cleanAnswers(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Answers are required');
  const entries = Object.entries(value);
  if (!entries.length || entries.length > 4) throw new Error('Answers are required');
  return Object.fromEntries(entries.map(([id, answers]) => {
    const questionId = cleanId(id, 'Question');
    if (!Array.isArray(answers) || !answers.length || answers.length > 8) throw new Error('Each question requires an answer');
    return [questionId, answers.map((answer) => {
      const result = typeof answer === 'string' ? answer.trim() : '';
      if (!result || result.length > 4_000) throw new Error('Invalid question answer');
      return result;
    })];
  }));
}

function cleanDeliveryBaseline(message) {
  if (message.baselineVersion !== 2) return {};
  const cleanOptionalId = (value) => {
    if (value == null || value === '') return null;
    if (typeof value !== 'string') throw new Error('Invalid delivery baseline');
    const result = value.trim();
    if (result.length > 256) throw new Error('Invalid delivery baseline');
    return result || null;
  };
  const count = message.baselineMatchingTextCount;
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid delivery baseline');
  return {
    baselineVersion: 2,
    baselineUserMessageId: cleanOptionalId(message.baselineUserMessageId),
    baselineTurnId: cleanOptionalId(message.baselineTurnId),
    ...(message.baselineLastItemId != null ? { baselineLastItemId: cleanOptionalId(message.baselineLastItemId) } : {}),
    baselineMatchingTextCount: count,
  };
}

function sessionUserMessageText(item) {
  const text = typeof item?.content === 'string'
    ? item.content
    : (Array.isArray(item?.content) ? item.content : [])
      .filter((part) => typeof part?.text === 'string')
      .map((part) => part.text)
      .join('\n');
  return stripTerminalInputResidue(text);
}

function sessionUserMessageEntries(thread) {
  return (Array.isArray(thread?.turns) ? thread.turns : []).flatMap((turn, turnIndex) => (
    (Array.isArray(turn?.items) ? turn.items : [])
      .filter((item) => item?.type === 'userMessage' && !item.delivery)
      .map((item) => ({ item, turnIndex }))
  ));
}

function sessionMessageReceiptResolved(thread, receipt) {
  if (isUserMessageDeliveryConfirmed(thread, receipt)) return true;
  if (thread?.deliveryConfirmationMode === 'server') return false;
  if (receipt.baselineVersion !== 2) return false;
  const users = sessionUserMessageEntries(thread);
  let candidates;
  // thread 流只推尾部窗口时, 锚点可能已经滚出窗口。那意味着此后又发生了整整一个
  // 窗口的对话 —— 这条消息要么早就送达, 要么早已无从补救; 继续判为"未送达"只会
  // 让那条乐观回显永远挂着, 表现为一条重复的待发消息。
  // A missing anchor cannot prove that an input whose submission was unconfirmed
  // ever left the CLI draft. Keep its receipt until the transcript can confirm it.
  const outOfWindow = receipt.provider !== 'qodercli' && receipt.provider !== 'codex'
    && Boolean(thread?.truncated) && receipt.submissionStatus !== 'unconfirmed';
  if (receipt.baselineUserMessageId) {
    const anchorIndex = users.findIndex(({ item }) => item.id === receipt.baselineUserMessageId);
    if (anchorIndex < 0) return outOfWindow;
    candidates = users.slice(anchorIndex + 1);
  } else if (receipt.baselineTurnId) {
    const turnIndex = (Array.isArray(thread?.turns) ? thread.turns : [])
      .findIndex((turn) => turn.id === receipt.baselineTurnId);
    if (turnIndex < 0) return outOfWindow;
    candidates = users.filter((entry) => entry.turnIndex > turnIndex);
  } else {
    candidates = users;
  }
  return Boolean(candidates
    .filter(({ item }) => sessionUserMessageText(item) === receipt.text)
    [receipt.baselineMatchingTextCount]);
}

function sessionMessageReceiptItem(receipt) {
  return {
    id: `delivery:${receipt.commandId}`,
    type: 'userMessage',
    content: [{ type: 'text', text: receipt.text }],
    delivery: {
      status: receipt.inputReceived ? 'received' : receipt.confirmationTimedOut ? 'unknown' : 'accepted',
      commandId: receipt.commandId,
      submissionStatus: receipt.inputReceived ? 'submitted' : receipt.submissionStatus,
      baselineVersion: receipt.baselineVersion,
      baselineUserMessageId: receipt.baselineUserMessageId,
      baselineTurnId: receipt.baselineTurnId,
      ...(receipt.baselineLastItemId ? { baselineLastItemId: receipt.baselineLastItemId } : {}),
      baselineMatchingTextCount: receipt.baselineMatchingTextCount,
      ...(receipt.inputWasQueued ? { inputWasQueued: true } : {}),
    },
  };
}

function sessionMessageReceiptTurn(receipt) {
  return {
    id: `delivery-turn:${receipt.commandId}`,
    status: 'completed',
    deliveryOnly: true,
    items: [sessionMessageReceiptItem(receipt)],
  };
}

function sessionMessageReceiptTurnIndex(turns, receipt) {
  if (receipt.baselineLastItemId) {
    const index = turns.findIndex(turn => (Array.isArray(turn?.items) ? turn.items : [])
      .some(item => item.id === receipt.baselineLastItemId));
    if (index >= 0) return index;
  }
  if (receipt.baselineTurnId) {
    const index = turns.findIndex((turn) => turn.id === receipt.baselineTurnId);
    if (index >= 0) return index;
  }
  if (!receipt.baselineUserMessageId) return -1;
  return turns.findIndex((turn) => (Array.isArray(turn?.items) ? turn.items : [])
    .some((item) => item?.type === 'userMessage' && item.id === receipt.baselineUserMessageId));
}

function timestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 10_000_000_000 ? value : value * 1000;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function tmuxThreads(provider, sessions, threads) {
  const providerSessions = (Array.isArray(sessions) ? sessions : [])
    .filter((session) => session.agent?.kind === provider);
  const availableThreads = Array.isArray(threads) ? threads : [];
  const byId = new Map(availableThreads.map((thread) => [thread.id, thread]));
  const reservedIds = new Set(providerSessions.map((session) => session.agent.id).filter(Boolean));
  const assignments = new Map();
  const usedIds = new Set();

  for (const session of providerSessions) {
    const id = session.agent.id;
    if (!id) continue;
    assignments.set(session, byId.get(id) || { id });
    usedIds.add(id);
  }

  const candidates = [];
  for (const session of providerSessions) {
    // Resumed Agents can explicitly opt out when their CLI selects an older thread
    // interactively. In that state a nearby transcript is not evidence of identity.
    if (assignments.has(session) || !session.agent.cwd || session.agent.matchByStart === false) continue;
    const startedAt = timestampMs(session.agent.startedAt);
    if (!startedAt) continue;
    for (const thread of availableThreads) {
      if (!thread.id || reservedIds.has(thread.id) || usedIds.has(thread.id) || thread.cwd !== session.agent.cwd) continue;
      const distance = Math.abs(timestampMs(thread.createdAt) - startedAt);
      if (distance <= SESSION_START_MATCH_MS) candidates.push({ session, thread, distance });
    }
  }
  candidates.sort((a, b) => a.distance - b.distance || String(a.thread.id).localeCompare(String(b.thread.id)));
  for (const candidate of candidates) {
    if (assignments.has(candidate.session) || usedIds.has(candidate.thread.id)) continue;
    assignments.set(candidate.session, candidate.thread);
    usedIds.add(candidate.thread.id);
  }

  return providerSessions.map((session) => {
    const matched = assignments.get(session);
    const available = Boolean(matched?.id);
    return {
      ...(matched || {}),
      id: matched?.id || `tmux:${provider}:${session.name}`,
      tmux: {
        name: session.name,
        title: session.agent.name || session.name,
        activityAt: session.activityAt,
        status: resolveSessionStatus(session),
        available,
      },
    };
  });
}

export class AgentRegistry extends EventEmitter {
  constructor(backends, {
    listTmuxSessions, sendTmuxMessage, selectTmuxModel, dismissTmuxCommand, interruptTmuxSession, answerTmuxQuestion,
    decorateTranscript = value => value,
  } = {}) {
    super();
    this.backends = new Map(Object.entries(backends || {}));
    this.listTmuxSessions = listTmuxSessions;
    this.sendTmuxMessage = sendTmuxMessage;
    this.answerTmuxQuestion = answerTmuxQuestion;
    this.selectTmuxModel = selectTmuxModel;
    this.dismissTmuxCommand = dismissTmuxCommand;
    this.interruptTmuxSession = interruptTmuxSession;
    this.decorateTranscript = decorateTranscript;
    for (const [provider, backend] of this.backends) {
      backend.on('notification', (message) => this.emit('notification', { provider, ...this.decorateTranscript(message) }));
      backend.on('serverRequest', (message) => this.emit('serverRequest', { provider, ...message }));
      backend.on('backendError', (error) => this.emit('backendError', { provider, error }));
    }
  }

  providerInfo() {
    return [...this.backends.entries()].map(([id, backend]) => ({
      id,
      label: backend.label || id,
      capabilities: { ...backend.capabilities, ...this.commandCapabilities(id) },
    }));
  }

  commandCapabilities(provider) {
    const supported = sessionCommandCapabilities(provider);
    return {
      modelSelection: supported.modelSelection && Boolean(this.selectTmuxModel),
      dismissCommands: this.dismissTmuxCommand ? supported.dismissCommands : [],
    };
  }

  backend(provider) {
    const backend = this.backends.get(cleanProvider(provider));
    if (!backend) throw new Error(`Unknown provider: ${provider || '(empty)'}`);
    return backend;
  }

  async listThreads(provider) {
    const backend = this.backend(provider);
    if (!this.listTmuxSessions) return backend.listThreads();
    const [result, sessions] = await Promise.all([backend.listThreads(), this.listTmuxSessions()]);
    return { ...(result || {}), data: tmuxThreads(provider, sessions, result?.data) };
  }
  async openThread(provider, threadId, options) {
    return this.decorateTranscript(await this.backend(provider).openThread(threadId, options));
  }
  async readLatestAgentOutput(provider, threadId) {
    const backend = this.backend(provider);
    if (backend.readLatestAgentOutput) return backend.readLatestAgentOutput(threadId);
    const result = await backend.openThread(threadId, { readOnly: true });
    return { text: latestAgentOutputText(result?.thread?.turns) };
  }
  async loadThreadHistory(provider, threadId, { beforeTurnId, limit, cursor }) {
    if (cursor) beforeTurnId = decodeHistoryCursor(cursor, provider, threadId);
    const page = this.decorateTranscript(await this.#historyPage(provider, threadId, { beforeTurnId, limit }));
    // Older clients keep the anchor-only response; cursor clients share one
    // provider-independent pagination contract, including after worker restarts.
    return cursor === undefined ? page : { ...page,
      nextCursor: page.truncated && page.oldestTurnId
        ? encodeHistoryCursor(provider, threadId, page.oldestTurnId) : null };
  }
  async #historyPage(provider, threadId, { beforeTurnId, limit }) {
    const backend = this.backend(provider);
    if (backend.loadThreadHistory) return backend.loadThreadHistory(threadId, { beforeTurnId, limit });
    const result = await backend.openThread(threadId, { readOnly: true });
    const turns = Array.isArray(result?.thread?.turns) ? result.thread.turns : [];
    const end = beforeTurnId ? turns.findIndex((turn) => turn.id === beforeTurnId) : turns.length;
    if (end < 0) throw new Error('Thread history anchor is no longer present');
    const start = Math.max(0, end - limit);
    const slice = turns.slice(start, end);
    return { turns: slice, truncated: start > 0, oldestTurnId: slice[0]?.id || null };
  }
  async sendSessionMessage(provider, params) {
    if (cleanProvider(provider) !== 'shell') this.backend(provider);
    if (!this.sendTmuxMessage) throw new Error('当前服务不支持直接参与 tmux 会话');
    const result = await this.sendTmuxMessage({ provider, ...params });
    const command = provider !== 'shell' ? params.text.match(/^\/\S*/)?.[0] : null;
    const commandOutput = command && normalizeSessionCommandOutput(provider, command, result, this.commandCapabilities(provider));
    return commandOutput ? { ...result, commandOutput } : result;
  }
  async selectSessionModel(provider, params) {
    this.backend(provider);
    if (!this.commandCapabilities(provider).modelSelection) throw new Error('当前 Agent 不支持远程选择模型，请在普通终端操作');
    const result = await this.selectTmuxModel({ provider, ...params });
    const commandOutput = normalizeSessionCommandOutput(provider, '/model', result, this.commandCapabilities(provider));
    return commandOutput ? { ...result, commandOutput } : result;
  }
  dismissSessionCommand(provider, params) {
    this.backend(provider);
    if (!this.dismissTmuxCommand) throw new Error('当前服务不支持关闭原生命令菜单');
    return this.dismissTmuxCommand({ provider, ...params });
  }
  answerSessionQuestion(provider, params) {
    this.backend(provider);
    if (!this.answerTmuxQuestion) throw new Error('当前服务不支持回答原生终端询问');
    return this.answerTmuxQuestion({ provider, ...params });
  }
  recordSessionMessage(provider, params) {
    if (cleanProvider(provider) === 'shell') return;
    this.backend(provider).recordSessionMessage?.(params);
  }
  prepareSessionMessage(provider, params) {
    if (cleanProvider(provider) === 'shell') return undefined;
    return this.backend(provider).prepareSessionMessage?.(params);
  }
  interruptSession(provider, params) {
    if (cleanProvider(provider) !== 'shell') this.backend(provider);
    if (!this.interruptTmuxSession) throw new Error('当前服务不支持中断 tmux 会话');
    return this.interruptTmuxSession({ provider, ...params });
  }
  newThread(provider, params) { return this.backend(provider).newThread(params); }
  sendMessage(provider, params) { return this.backend(provider).sendMessage(params); }
  interruptTurn(provider, params) { return this.backend(provider).interruptTurn(params); }
  respond(provider, id, result) { return this.backend(provider).respond(id, result); }

  close() {
    for (const backend of this.backends.values()) backend.close?.();
  }
}

export class AgentHub {
  constructor(registry, {
    defaultCwd = process.cwd(),
    hostname = '',
    protocolEpoch = crypto.randomUUID(),
    sessionFeed = null,
    threadFeed = null,
    invalidateSessions = null,
    paneExcerpt = null,
    autonomy = null,
    // 打开会话的首帧只发尾部若干轮: 这条 1.2MB / 43 turns 的会话往返要 73ms,
    // 几乎全花在序列化、permessage-deflate 与客户端解析上, 而用户一眼能看到的
    // 只有最后几轮。更早的按需再取。
    threadTurnWindow = 20,
  } = {}) {
    this.registry = registry;
    this.defaultCwd = defaultCwd;
    this.hostname = hostname;
    this.protocolEpoch = protocolEpoch;
    this.sessionFeed = sessionFeed;
    this.threadFeed = threadFeed;
    this.invalidateSessions = invalidateSessions;
    this.paneExcerpt = paneExcerpt;
    this.autonomy = autonomy;
    this.threadTurnWindow = threadTurnWindow;
    this.clients = new Map();
    this.commandReceipts = createCommandReceiptCache();
    this.sessionStops = new Set();
    this.sessionMessageReceipts = new Map();
    this.dismissedDeliveries = new Map();
    this.pendingRequests = new Map();
    this.resolvedRequests = new Set();
    registry.on('notification', (message) => this.#broadcastNotification(message));
    registry.on('serverRequest', (message) => this.#broadcastServerRequest(message));
    registry.on('backendError', ({ provider }) => this.#clearProviderRequests(provider));
    autonomy?.on('change', run => {
      for (const socket of this.clients.keys()) send(socket, { type: 'autonomyState', run });
    });
  }

  handleConnection(socket, { streamVersion = 1 } = {}) {
    const negotiatedStreamVersion = streamVersion === 2 ? 2 : 1;
    const client = {
      streamVersion: negotiatedStreamVersion,
      deliveredRequests: new Set(),
      threadSubscription: null,
      unsubscribeSessions: null,
      sessionStatuses: new Map(),
    };
    this.clients.set(socket, client);
    send(socket, {
      type: 'ready',
      defaultCwd: this.defaultCwd,
      hostname: this.hostname,
      protocol: {
        version: negotiatedStreamVersion,
        epoch: this.protocolEpoch,
        commandReceiptTtlMs: COMMAND_RECEIPT_TTL_MS,
      },
      providers: this.registry.providerInfo(),
      scopedSessionStop: true,
      ...(this.autonomy ? { autonomy: this.autonomy.snapshots(), autonomySessionBinding: true } : {}),
    });
    if (this.sessionFeed && negotiatedStreamVersion === 1) this.#subscribeSessions(socket, null);
    socket.on('message', (data) => this.#handleMessage(socket, data));
    const cleanup = () => this.#removeClient(socket);
    socket.once('close', cleanup);
    socket.once('error', cleanup);
  }

  #removeClient(socket) {
    const client = this.clients.get(socket);
    if (!client) return;
    client.unsubscribeSessions?.();
    client.threadSubscription?.unsubscribe?.();
    this.clients.delete(socket);
  }

  #subscribeSessions(socket, cursor) {
    const client = this.clients.get(socket);
    if (!client || !this.sessionFeed) return;
    client.unsubscribeSessions?.();
    const onSnapshot = (frame) => {
      const snapshot = frame.snapshot;
      const subscription = client.threadSubscription;
      const previousStatus = subscription?.target.tmuxSession
        ? client.sessionStatuses.get(subscription.target.tmuxSession)
        : null;
      if (snapshot) {
        client.sessionStatuses = new Map((snapshot.sessions || []).map((session) => [session.name, session.status]));
      }
      if (client.streamVersion === 1) {
        send(socket, {
          type: 'sessionsSnapshot', version: 1,
          stream: { epoch: frame.epoch, sequence: frame.sequence },
          snapshot,
        });
      } else if (frame.kind === 'delta') {
        send(socket, {
          type: 'sessionsPatch', version: 2,
          stream: {
            epoch: frame.epoch, baseSequence: frame.baseSequence, sequence: frame.sequence,
          },
          patch: frame.patch,
        });
      } else if (frame.kind === 'synchronized') {
        send(socket, {
          type: 'sessionsSynchronized', version: 2,
          stream: { epoch: frame.epoch, sequence: frame.sequence },
        });
      } else {
        send(socket, {
          type: 'sessionsSnapshot', version: 2,
          stream: { epoch: frame.epoch, sequence: frame.sequence },
          snapshot,
        });
      }
      const currentStatus = subscription?.target.tmuxSession
        ? client.sessionStatuses.get(subscription.target.tmuxSession)
        : null;
      if (currentStatus === 'working' && previousStatus !== 'working') {
        this.#refreshThreadSubscription(subscription.target);
      } else if (previousStatus === 'working' && currentStatus !== 'working') {
        this.#invalidateThreadSubscription(subscription.target);
      }
    };
    const onError = (error) => send(socket, {
      type: 'sessionsStreamError', version: client.streamVersion,
      error: error.message || 'Session stream failed',
    });
    client.unsubscribeSessions = client.streamVersion === 2
      ? this.sessionFeed.subscribeFrom('sessions', cursor, onSnapshot, onError)
      : this.sessionFeed.subscribe('sessions', onSnapshot, onError);
  }

  async #handleMessage(socket, data) {
    let message;
    try {
      message = JSON.parse(String(data));
      if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid message');
      const dispatched = await this.#dispatch(socket, message);
      const wrapped = dispatched?.[AFTER_REPLY] === true;
      const result = wrapped ? dispatched.result : dispatched;
      if (message.id != null) send(socket, { id: message.id, ok: true, result });
      if (wrapped) dispatched.activate();
    } catch (error) {
      const id = message?.id;
      send(socket, { id, ok: false, error: error.message || 'Agent request failed' });
    }
  }

  async #dispatch(socket, message) {
    const provider = cleanProvider(message.provider);
    const stopKey = JSON.stringify([provider, message.threadId, message.tmuxSession]);
    if (this.sessionStops.has(stopKey) && ['startAutonomy', 'answerAutonomy', 'sendSessionMessage'].includes(message.type)) {
      throw new Error('正在停止任务，请等待结果后操作');
    }
    if (message.type === 'dismissSessionDelivery') {
      const threadId = cleanId(message.threadId, 'Thread');
      const commandId = cleanCommandId(message.deliveryId);
      const target = { provider, threadId, tmuxSession: cleanId(message.tmuxSession, 'tmux session') };
      const subscribed = this.clients.get(socket)?.threadSubscription?.target;
      if (!subscribed || subscribed.provider !== provider || subscribed.threadId !== threadId
        || subscribed.tmuxSession !== target.tmuxSession) throw new Error('回执不属于当前会话');
      this.#dismissDelivery(provider, threadId, commandId);
      this.#invalidateThreadSubscription(target);
      return { dismissedDeliveryIds: [commandId] };
    }
    if (message.type === 'bindAutonomySession') {
      if (!this.autonomy) throw new Error('当前服务不支持自主迭代');
      const client = this.clients.get(socket);
      client.autonomyTarget = null;
      if (message.threadId == null && message.tmuxSession == null) return {};
      if (!['codex', 'claude', 'qodercli'].includes(provider)) throw new Error('自主迭代需要 Agent 会话');
      const target = { provider, threadId: cleanId(message.threadId, 'Thread'), tmuxSession: cleanId(message.tmuxSession, 'tmux session') };
      // Terminal mode binds controls without retaining an expensive history stream.
      // Every write still verifies live Agent/thread/pane identity in the controller.
      client.autonomyTarget = target;
      const run = this.autonomy.snapshot(target);
      if (run?.status === 'paused' && run.round === 0 && !run.plan && !run.proposal) {
        // One read can recover a lost setup dialog; never retain a history stream
        // or block control binding on a slow transcript. A later start wins.
        this.registry.openThread(provider, target.threadId, { readOnly: true }).then(result => {
          if (client.autonomyTarget === target) this.autonomy.restoreProposal(target, result?.thread);
        }).catch(() => {});
      }
      return { autonomy: this.autonomy.snapshot(target) };
    }
    if (['startAutonomy', 'pauseAutonomy', 'answerAutonomy'].includes(message.type)) {
      if (!this.autonomy) throw new Error('当前服务不支持自主迭代');
      const target = { provider, threadId: cleanId(message.threadId, 'Thread'), tmuxSession: cleanId(message.tmuxSession, 'tmux session') };
      const client = this.clients.get(socket);
      const subscribed = Object.hasOwn(client, 'autonomyTarget') ? client.autonomyTarget : client.threadSubscription?.target;
      if (!subscribed || subscribed.provider !== provider || subscribed.threadId !== target.threadId
        || subscribed.tmuxSession !== target.tmuxSession) throw new Error('自主任务不属于当前会话');
      cleanCommandId(message.commandId);
      const answer = message.type === 'answerAutonomy' ? { requestId: cleanCommandId(message.requestId), answers: message.answers } : {};
      return this.#runCommand(message, provider, { ...target, ...answer }, async () => ({ autonomy: message.type === 'startAutonomy'
        ? await this.autonomy.start(target) : message.type === 'answerAutonomy'
          ? await this.autonomy.respond(target, answer) : this.autonomy.pause(target) }));
    }
    if (message.type === 'subscribeSessions') {
      const client = this.clients.get(socket);
      if (client?.streamVersion !== 2) throw new Error('Session cursors require stream protocol V2');
      this.#subscribeSessions(socket, cleanStreamCursor(message.cursor));
      return {};
    }
    if (message.type === 'unsubscribeThread') {
      this.#clearThreadSubscription(socket, this.clients.get(socket)?.threadSubscription);
      return {};
    }
    if (message.type === 'resyncThread') {
      const client = this.clients.get(socket);
      if (client?.streamVersion !== 2) throw new Error('Thread cursors require stream protocol V2');
      const target = {
        provider,
        threadId: cleanId(message.threadId, 'Thread'),
        tmuxSession: typeof message.tmuxSession === 'string' ? message.tmuxSession.trim() : '',
      };
      const current = client.threadSubscription;
      if (!current || subscriptionKey(current.target.provider, current.target.threadId) !== subscriptionKey(provider, target.threadId)
        || current.target.tmuxSession !== target.tmuxSession) {
        throw new Error('Thread subscription changed');
      }
      const subscription = this.#beginThreadSubscription(socket, target, null);
      this.#activateThreadSubscription(socket, subscription);
      return {};
    }
    if (message.type === 'readLatestAgentOutput') {
      return this.registry.readLatestAgentOutput(provider, cleanId(message.threadId, 'Thread'));
    }
    if (message.type === 'loadThreadHistory') {
      const threadId = cleanId(message.threadId, 'Thread');
      const beforeTurnId = typeof message.beforeTurnId === 'string' ? message.beforeTurnId.trim() : '';
      const limit = Number.isSafeInteger(message.limit) && message.limit > 0
        ? Math.min(message.limit, 200)
        : this.threadTurnWindow;
      return this.registry.loadThreadHistory(provider, threadId, { beforeTurnId, limit, cursor: message.cursor });
    }
    if (message.type === 'listThreads') return this.registry.listThreads(provider);
    if (message.type === 'openThread') {
      const threadId = cleanId(message.threadId, 'Thread');
      this.registry.backend(provider);
      // Hints rebuild read-only confirmation state after a service restart. Never
      // trust a client's submitted/confirmed status and never invoke the sender.
      const hints = provider === 'codex' ? message.deliveryReceipts : undefined;
      const dismissed = message.dismissedDeliveryIds ?? [];
      if (!Array.isArray(dismissed) || dismissed.length > 512) throw new Error('Invalid dismissed deliveries');
      const dismissedIds = dismissed.map(cleanCommandId);
      if (hints !== undefined) {
        if (!Array.isArray(hints) || hints.length > 32 || Buffer.byteLength(JSON.stringify(hints)) > 120_000) {
          throw new Error('Invalid delivery receipts');
        }
        const restored = hints.map(hint => {
          const baseline = cleanDeliveryBaseline(hint || {});
          if (baseline.baselineVersion !== 2) throw new Error('Invalid delivery baseline');
          const text = cleanMessage(hint.text);
          if (text.startsWith('/')) throw new Error('Commands cannot be restored as messages');
          return { threadId, commandId: cleanCommandId(hint.commandId), text, ...baseline,
            restored: true, submissionStatus: 'unconfirmed', confirmationTimedOut: true };
        });
        for (const id of dismissedIds) this.#dismissDelivery(provider, threadId, id);
        for (const receipt of restored) {
          if (this.dismissedDeliveries.has(JSON.stringify([provider, threadId, receipt.commandId]))) continue;
          this.registry.recordSessionMessage(provider, receipt);
          this.#recordSessionMessageReceipt(provider, receipt);
        }
      }
      if (hints === undefined) for (const id of dismissedIds) this.#dismissDelivery(provider, threadId, id);
      const target = {
        provider,
        threadId,
        tmuxSession: typeof message.tmuxSession === 'string' ? message.tmuxSession.trim() : '',
      };
      const client = this.clients.get(socket);
      const streamCursor = client?.streamVersion === 2
        ? cleanStreamCursor(message.streamCursor)
        : null;
      const subscription = this.#beginThreadSubscription(socket, target, streamCursor);
      try {
        const options = message.readOnly === true ? { readOnly: true } : undefined;
        const resumable = client?.streamVersion === 2 && streamCursor
          && !hints?.length && !dismissedIds.length
          && ![...this.dismissedDeliveries.values()].some(entry => entry.provider === provider && entry.threadId === threadId)
          && (message.readOnly === true || target.tmuxSession)
          && !this.#hasSessionMessageReceipts(provider, threadId)
          && this.threadFeed?.canResume(target, streamCursor);
        if (resumable) {
          return afterReply(
            { resumed: true, stream: streamCursor },
            () => this.#activateThreadSubscription(socket, subscription),
          );
        }
        subscription.cursor = null;
        subscription.fresh = true;
        if (options && provider === 'codex' && this.threadFeed) options.progressive = true;
        if (options && provider === 'qodercli' && this.threadFeed) options.deferCompactionRestore = true;
        const result = this.#windowThread(this.#withPaneExcerpt(
          await this.registry.openThread(provider, threadId, options), target.tmuxSession,
        ));
        this.autonomy?.restoreProposal(target, result?.thread);
        const restored = this.#restoreSessionMessageReceipts(provider, threadId, result);
        return afterReply(restored, () => this.#activateThreadSubscription(socket, subscription));
      } catch (error) {
        this.#clearThreadSubscription(socket, subscription);
        throw error;
      }
    }
    if (message.type === 'sendSessionMessage') {
      const threadId = cleanId(message.threadId, 'Thread');
      const sessionName = cleanId(message.tmuxSession, 'tmux session');
      const text = cleanMessage(message.text);
      const turnId = typeof message.turnId === 'string' && message.turnId.trim()
        ? message.turnId.trim()
        : null;
      const baseline = cleanDeliveryBaseline(message);
      const commandId = message.commandId == null ? '' : String(message.commandId).trim();
      if (provider !== 'shell') this.registry.backend(provider);
      if (!Object.hasOwn(this.clients.get(socket), 'autonomyTarget')) {
        this.#ensureThreadSubscription(socket, { provider, threadId, tmuxSession: sessionName });
      }
      const payload = {
        threadId, sessionName, text,
        ...(turnId ? { turnId, mode: message.mode === 'steer' ? 'steer' : 'followUp' } : {}),
        ...baseline,
      };
      return this.#runCommand(message, provider, payload, async () => {
        const target = { provider, threadId, tmuxSession: sessionName };
        const autonomous = this.autonomy?.snapshot(target);
        if (autonomous && !['completed', 'limit'].includes(autonomous.status) && !isAutonomyObservation(text)) {
          if (!text.startsWith('/')) return { autonomyHandled: true, autonomy: await this.autonomy.message(target, text) };
          this.autonomy.pause(target, '用户正在操作原生命令菜单');
        }
        const deliveryBaseline = provider === 'qodercli'
          ? await this.registry.prepareSessionMessage(provider, { threadId, text, commandId }) : undefined;
        const result = await this.registry.sendSessionMessage(provider, { threadId, sessionName, text,
          ...(isAutonomyObservation(text) ? { nonInterrupting: true } : {}),
        });
        if (result?.submissionStatus === 'not-sent') throw new Error('输入框未就绪，消息未注入；请先处理草稿或弹窗');
        const submission = provider === 'codex' || result?.submissionStatus != null
          ? { submissionStatus: result?.submissionStatus === 'submitted' ? 'submitted' : 'unconfirmed' }
          : {};
        this.registry.recordSessionMessage(provider, {
          threadId, turnId, text,
          commandId,
          ...submission,
          ...baseline,
          ...(deliveryBaseline ? { deliveryBaseline } : {}),
        });
        const receiptRecorded = !turnId && provider !== 'shell' && commandId
          && !text.startsWith('/') && (!result?.terminalOutput || result.terminalWorking)
          && this.#recordSessionMessageReceipt(provider, {
            threadId, text, commandId,
            ...submission,
            inputWasQueued: result?.inputWasQueued === true,
            ...baseline,
          });
        this.#invalidateSessionFeed();
        if (receiptRecorded) this.#invalidateThreadSubscription(target);
        else this.#refreshThreadSubscription(target);
        return result;
      });
    }
    if (message.type === 'selectSessionModel') {
      const threadId = cleanId(message.threadId, 'Thread');
      const sessionName = cleanId(message.tmuxSession, 'tmux session');
      const option = cleanId(message.option, 'Model option');
      this.#ensureThreadSubscription(socket, { provider, threadId, tmuxSession: sessionName });
      return this.registry.selectSessionModel(provider, {
        threadId, sessionName, option,
      });
    }
    if (message.type === 'dismissSessionCommand') {
      return this.registry.dismissSessionCommand(provider, {
        threadId: cleanId(message.threadId, 'Thread'),
        sessionName: cleanId(message.tmuxSession, 'tmux session'),
        command: cleanId(message.command, 'Command'),
      });
    }
    if (message.type === 'interruptSession') {
      const target = {
        threadId: cleanId(message.threadId, 'Thread'),
        tmuxSession: cleanId(message.tmuxSession, 'tmux session'),
      };
      if (message.scope != null && !['foreground', 'all'].includes(message.scope)) throw new Error('停止范围无效');
      return this.#runCommand(message, provider, { ...target, scope: message.scope }, async () => {
        if (this.sessionStops.has(stopKey)) throw new Error('正在停止任务，请等待结果');
        this.sessionStops.add(stopKey);
        const operation = () => this.registry.interruptSession(provider, {
          threadId: target.threadId, sessionName: target.tmuxSession,
          ...(message.scope ? { waitForIdle: true, stopBackground: message.scope === 'all',
            allowBackground: message.scope === 'foreground' } : {}),
        });
        try {
          return this.autonomy ? await this.autonomy.interrupt({ provider, ...target }, operation, { verified: Boolean(message.scope) }) : await operation();
        } finally {
          this.sessionStops.delete(stopKey);
          this.#invalidateSessionFeed(); this.#refreshThreadSubscription({ provider, ...target });
        }
      });
    }
    if (message.type === 'newThread') {
      const text = cleanMessage(message.text);
      const cwd = typeof message.cwd === 'string' && message.cwd.trim() ? message.cwd.trim() : this.defaultCwd;
      if (!path.isAbsolute(cwd)) throw new Error('Working directory must be an absolute path');
      const result = await this.registry.newThread(provider, { cwd, text });
      const subscription = this.#beginThreadSubscription(socket, {
        provider, threadId: result.thread.id, tmuxSession: '',
      });
      return afterReply(result, () => this.#activateThreadSubscription(socket, subscription));
    }
    if (message.type === 'sendMessage') {
      const threadId = cleanId(message.threadId, 'Thread');
      const text = cleanMessage(message.text);
      this.registry.backend(provider);
      this.#ensureThreadSubscription(socket, { provider, threadId, tmuxSession: '' });
      const payload = {
        threadId,
        turnId: typeof message.turnId === 'string' ? message.turnId : undefined,
        mode: message.mode === 'steer' ? 'steer' : 'followUp',
        text,
      };
      return this.#runCommand(message, provider, payload, () => this.registry.sendMessage(provider, payload));
    }
    if (message.type === 'interruptTurn') {
      return this.registry.interruptTurn(provider, {
        threadId: cleanId(message.threadId, 'Thread'),
        turnId: cleanId(message.turnId, 'Turn'),
      });
    }
    if (message.type === 'resolveApproval') {
      if (!['accept', 'acceptForSession', 'decline', 'cancel'].includes(message.decision)) {
        throw new Error('Invalid approval decision');
      }
      await this.#respondOnce(provider, cleanRequestId(message.requestId), { decision: message.decision });
      return {};
    }
    if (message.type === 'answerSessionQuestion') {
      const threadId = cleanId(message.threadId, 'Thread');
      const sessionName = cleanId(message.tmuxSession, 'tmux session');
      const target = this.clients.get(socket)?.threadSubscription?.target;
      if (provider !== 'qodercli' || target?.provider !== provider || target.threadId !== threadId
        || target.tmuxSession !== sessionName) throw new Error('询问不属于当前会话，回答未发送');
      const result = await this.registry.answerSessionQuestion(provider, {
        threadId, sessionName, questionId: cleanId(message.questionId, 'Question'), answer: cleanMessage(message.answer),
      });
      this.#invalidateSessionFeed();
      return result;
    }
    if (message.type === 'resolveInteraction') {
      await this.#respondOnce(provider, cleanRequestId(message.requestId), { answers: cleanAnswers(message.answers) });
      return {};
    }
    throw new Error(`Unknown agent message type: ${message.type || '(empty)'}`);
  }

  #runCommand(message, provider, payload, operation) {
    if (message.commandId == null) return operation();
    const commandId = String(message.commandId).trim();
    const fingerprint = JSON.stringify({ type: message.type, provider, ...payload });
    return this.commandReceipts.run(commandId, fingerprint, async () => {
      const result = await operation();
      return {
        ...(result && typeof result === 'object' && !Array.isArray(result) ? result : {}),
        command: { id: commandId, status: 'accepted' },
      };
    });
  }

  // The pane excerpt no longer rides the session list, so the thread payload has to
  // carry it; without this the first render after opening a session shows an empty
  // output area until the thread stream catches up.
  #windowThread(result) {
    const turns = result?.thread?.turns;
    const limit = this.threadTurnWindow;
    if (!Array.isArray(turns) || !Number.isSafeInteger(limit) || limit < 1 || turns.length <= limit) {
      return result;
    }
    const kept = turns.slice(-limit);
    return {
      ...result,
      thread: {
        ...result.thread, turns: kept, truncated: true, oldestTurnId: kept[0]?.id || null,
      },
    };
  }

  #withPaneExcerpt(result, tmuxSession) {
    const excerpt = tmuxSession && this.paneExcerpt ? this.paneExcerpt(tmuxSession) : '';
    if (!excerpt || !result?.thread) return result;
    return { ...result, thread: { ...result.thread, liveOutput: excerpt } };
  }

  #invalidateSessionFeed() {
    try {
      const refresh = this.invalidateSessions
        ? this.invalidateSessions()
        : this.sessionFeed?.invalidate('sessions');
      Promise.resolve(refresh).catch(() => {});
    } catch { /* The session stream reports its own recoverable loader errors. */ }
  }

  #pruneSessionMessageReceipts() {
    const now = Date.now();
    for (const [commandId, receipt] of this.sessionMessageReceipts) {
      if (receipt.expiresAt <= now) this.sessionMessageReceipts.delete(commandId);
    }
    for (const [key, entry] of this.dismissedDeliveries) if (entry.expiresAt <= now) this.dismissedDeliveries.delete(key);
  }

  #dismissDelivery(provider, threadId, commandId) {
    this.#pruneSessionMessageReceipts();
    const key = JSON.stringify([provider, threadId, commandId]);
    this.dismissedDeliveries.set(key, { provider, threadId, commandId, expiresAt: Date.now() + SESSION_MESSAGE_RECEIPT_TTL_MS });
    while (this.dismissedDeliveries.size > SESSION_MESSAGE_RECEIPT_LIMIT) this.dismissedDeliveries.delete(this.dismissedDeliveries.keys().next().value);
    const receipt = this.sessionMessageReceipts.get(commandId);
    if (receipt?.provider === provider && receipt.threadId === threadId) this.sessionMessageReceipts.delete(commandId);
    this.registry.backend(provider).dismissSessionMessage?.({ threadId, commandId });
    for (const client of this.clients.values()) {
      const subscription = client.threadSubscription;
      if (subscription?.target.provider === provider && subscription.target.threadId === threadId) {
        subscription.deltaBaseSafe = false; subscription.fullAtSync = true;
      }
    }
  }

  #hasSessionMessageReceipts(provider, threadId) {
    this.#pruneSessionMessageReceipts();
    for (const receipt of this.sessionMessageReceipts.values()) {
      if (receipt.provider === provider && receipt.threadId === threadId) return true;
    }
    return false;
  }

  #recordSessionMessageReceipt(provider, receipt) {
    if (receipt.baselineVersion !== 2) return false;
    this.#pruneSessionMessageReceipts();
    if (this.sessionMessageReceipts.has(receipt.commandId)) return true;
    while (this.sessionMessageReceipts.size >= SESSION_MESSAGE_RECEIPT_LIMIT) {
      this.sessionMessageReceipts.delete(this.sessionMessageReceipts.keys().next().value);
    }
    this.sessionMessageReceipts.set(receipt.commandId, {
      provider,
      ...receipt,
      expiresAt: Date.now() + SESSION_MESSAGE_RECEIPT_TTL_MS,
    });
    return true;
  }

  #restoreSessionMessageReceipts(provider, threadId, result) {
    const dismissedIds = [...this.dismissedDeliveries.values()]
      .filter(entry => entry.provider === provider && entry.threadId === threadId).map(entry => entry.commandId);
    if (dismissedIds.length && result?.thread) result = { ...result, thread: withoutDismissedDeliveries(result.thread, dismissedIds) };
    const thread = result?.thread;
    if (!thread) return result;
    this.#pruneSessionMessageReceipts();
    const pending = [];
    for (const [commandId, receipt] of this.sessionMessageReceipts) {
      if (receipt.provider !== provider || receipt.threadId !== threadId) continue;
      if (sessionMessageReceiptResolved(thread, receipt)) {
        this.sessionMessageReceipts.delete(commandId);
      } else {
        if (provider === 'qodercli' && thread.receivedDeliveryIds?.includes(commandId)) receipt.inputReceived = true;
        pending.push(thread.unconfirmedDeliveryIds?.includes(receipt.commandId)
          ? { ...receipt, confirmationTimedOut: true } : receipt);
      }
    }
    if (!pending.length) return result;
    const turns = Array.isArray(thread.turns) ? thread.turns : [];
    const itemIds = new Set(turns.flatMap((turn) => (
      Array.isArray(turn?.items) ? turn.items.map((item) => item?.id) : []
    )));
    let restoredTurns = turns;
    const standalone = [];
    for (const receipt of pending) {
      const item = sessionMessageReceiptItem(receipt);
      if (itemIds.has(item.id)) continue;
      const turnIndex = receipt.inputWasQueued || receipt.restored
        ? sessionMessageReceiptTurnIndex(restoredTurns, receipt)
        : -1;
      if (turnIndex < 0) {
        standalone.push(sessionMessageReceiptTurn(receipt));
      } else {
        if (restoredTurns === turns) restoredTurns = [...turns];
        const target = restoredTurns[turnIndex];
        const items = [...(Array.isArray(target?.items) ? target.items : [])];
        items.splice(deliveryInsertionIndex(items, receipt.baselineLastItemId), 0, item);
        restoredTurns[turnIndex] = { ...target, items };
      }
      itemIds.add(item.id);
    }
    if (standalone.length) restoredTurns = [...restoredTurns, ...standalone];
    if (restoredTurns === turns) return result;
    return { ...result, thread: { ...thread, turns: restoredTurns } };
  }

  #refreshThreadSubscription(target) {
    if (!this.threadFeed || !target) return;
    this.threadFeed.refreshSubscribed((resource) => (
      resource.provider === target.provider
      && resource.threadId === target.threadId
      && resource.tmuxSession === target.tmuxSession
    )).catch(() => {});
  }

  #invalidateThreadSubscription(target) {
    if (!this.threadFeed || !target) return;
    this.threadFeed.invalidate(target).catch(() => {});
  }

  #beginThreadSubscription(socket, target, cursor = null) {
    const client = this.clients.get(socket);
    if (!client) return null;
    client.threadSubscription?.unsubscribe?.();
    const subscription = {
      target,
      cursor,
      ready: false,
      pending: [],
      unsubscribe: null,
      deltaBaseSafe: !this.#hasSessionMessageReceipts(target.provider, target.threadId),
      fullAtSync: false,
    };
    client.threadSubscription = subscription;
    return subscription;
  }

  #deliverV2ThreadFrame(socket, subscription, frame) {
    this.autonomy?.restoreProposal(subscription.target, frame.snapshot?.thread);
    const restored = frame.snapshot
      ? this.#restoreSessionMessageReceipts(
        subscription.target.provider,
        subscription.target.threadId,
        frame.snapshot,
      )
      : null;
    const hasPendingReceipts = this.#hasSessionMessageReceipts(
      subscription.target.provider,
      subscription.target.threadId,
    );
    // The feed diffs the backend result ({ thread }), while the wire snapshot exposes
    // only that result's thread value. Rebase delta paths to the same root clients hold;
    // otherwise every first delta fails and causes an endless full-resync loop.
    const patch = frame.kind === 'delta' ? threadRelativePatch(frame.patch) : null;
    const sendFull = () => {
      if (!restored?.thread) return false;
      this.#deliverThreadMessage(socket, subscription, {
        type: 'threadSnapshot', version: 2, target: subscription.target,
        stream: { epoch: frame.epoch, sequence: frame.sequence },
        thread: restored.thread,
      });
      subscription.deltaBaseSafe = !hasPendingReceipts;
      subscription.fullAtSync = false;
      return true;
    };

    if (frame.kind === 'synchronized') {
      if (subscription.fullAtSync && !sendFull()) {
        this.#deliverThreadMessage(socket, subscription, {
          type: 'threadStreamError', version: 2, target: subscription.target,
          error: 'Thread stream requires a full snapshot',
        });
        return;
      }
      this.#deliverThreadMessage(socket, subscription, {
        type: 'threadSynchronized', version: 2, target: subscription.target,
        stream: { epoch: frame.epoch, sequence: frame.sequence },
      });
      return;
    }
    if (frame.kind === 'delta' && patch && subscription.deltaBaseSafe && !hasPendingReceipts) {
      this.#deliverThreadMessage(socket, subscription, {
        type: 'threadPatch', version: 2, target: subscription.target,
        stream: {
          epoch: frame.epoch, baseSequence: frame.baseSequence, sequence: frame.sequence,
        },
        patch,
      });
      return;
    }
    if (!sendFull()) {
      subscription.deltaBaseSafe = false;
      subscription.fullAtSync = true;
    }
  }

  #activateThreadSubscription(socket, subscription) {
    const client = this.clients.get(socket);
    if (!client || !subscription || client.threadSubscription !== subscription) return;
    subscription.ready = true;
    if (this.threadFeed && subscription.target.provider !== 'shell') {
      const onSnapshot = client.streamVersion === 2
        ? (frame) => this.#deliverV2ThreadFrame(socket, subscription, frame)
        : ({ epoch, sequence, snapshot }) => {
          this.autonomy?.restoreProposal(subscription.target, snapshot?.thread);
          const restored = this.#restoreSessionMessageReceipts(
            subscription.target.provider,
            subscription.target.threadId,
            snapshot,
          );
          this.#deliverThreadMessage(socket, subscription, {
            type: 'threadSnapshot',
            version: 1,
            target: subscription.target,
            stream: { epoch, sequence },
            thread: restored?.thread,
          });
        };
      const onError = (error) => this.#deliverThreadMessage(socket, subscription, {
          type: 'threadStreamError',
          version: client.streamVersion,
          target: subscription.target,
          error: error.message || 'Thread stream failed',
        });
      subscription.unsubscribe = client.streamVersion === 2
        ? this.threadFeed.subscribeFrom(subscription.target, subscription.cursor, onSnapshot, onError, { fresh: subscription.fresh })
        : this.threadFeed.subscribe(subscription.target, onSnapshot, onError, { fresh: subscription.fresh });
    }
    for (const message of subscription.pending.splice(0)) send(socket, message);
    this.#sendPending(socket, subscription);
  }

  #ensureThreadSubscription(socket, target) {
    const current = this.clients.get(socket)?.threadSubscription;
    if (current && subscriptionKey(current.target.provider, current.target.threadId) === subscriptionKey(target.provider, target.threadId)
      && current.target.tmuxSession === target.tmuxSession) return current;
    const subscription = this.#beginThreadSubscription(socket, target);
    this.#activateThreadSubscription(socket, subscription);
    return subscription;
  }

  #clearThreadSubscription(socket, subscription) {
    const client = this.clients.get(socket);
    if (!client || client.threadSubscription !== subscription) return;
    subscription.unsubscribe?.();
    client.threadSubscription = null;
  }

  #deliverThreadMessage(socket, subscription, message) {
    const client = this.clients.get(socket);
    if (!client || client.threadSubscription !== subscription) return;
    if (subscription.ready) {
      send(socket, message);
      return;
    }
    if (message.type === 'threadSnapshot') {
      subscription.pending = subscription.pending.filter((pending) => pending.type !== 'threadSnapshot');
    }
    if (subscription.pending.length >= 512) subscription.pending.shift();
    subscription.pending.push(message);
  }

  #broadcastNotification(message) {
    const { provider, method, params } = message;
    if (method === 'turn/started' || method === 'turn/completed') this.#invalidateSessionFeed();
    if (method === 'turn/completed') {
      const turnId = params?.turn?.id || params?.turnId;
      for (const [key, entry] of this.pendingRequests) {
        if (entry.provider === provider && entry.request.params?.threadId === params?.threadId
          && (!turnId || entry.request.params?.turnId === turnId)) {
          this.pendingRequests.delete(key);
          for (const client of this.clients.values()) client.deliveredRequests.delete(key);
        }
      }
    }
    const refreshTargets = new Map();
    for (const [socket, client] of this.clients) {
      const subscription = client.threadSubscription;
      if (!subscription || subscription.target.provider !== provider
        || subscription.target.threadId !== params?.threadId) continue;
      this.#deliverThreadMessage(socket, subscription, {
        type: 'event', provider, method, params,
        tmuxSession: subscription.target.tmuxSession,
      });
      if (method === 'turn/completed' || method === 'codeck/deliveryUpdated') {
        refreshTargets.set(JSON.stringify(subscription.target), subscription.target);
      }
    }
    if (this.threadFeed) {
      for (const target of refreshTargets.values()) this.threadFeed.invalidate(target).catch(() => {});
    }
  }

  #broadcastServerRequest(message) {
    const { provider, ...request } = message;
    for (const run of this.autonomy?.snapshots() || []) {
      if (run.target.provider === provider && run.target.threadId === request.params?.threadId) {
        this.autonomy.pause(run.target, 'Agent 需要用户授权或回答');
      }
    }
    const requestKey = approvalKey(provider, request.id);
    this.resolvedRequests.delete(requestKey);
    for (const client of this.clients.values()) client.deliveredRequests.delete(requestKey);
    this.pendingRequests.set(requestKey, { provider, request });
    for (const [socket, client] of this.clients) {
      const subscription = client.threadSubscription;
      if (subscription?.target.provider === provider
        && subscription.target.threadId === request.params?.threadId) {
        this.#sendServerRequest(socket, provider, request, subscription);
      }
    }
  }

  async #respondOnce(provider, requestId, result) {
    const key = approvalKey(provider, requestId);
    if (this.resolvedRequests.has(key)) throw new Error('Request was already resolved');
    this.resolvedRequests.add(key);
    if (this.resolvedRequests.size > 1_024) this.resolvedRequests.delete(this.resolvedRequests.values().next().value);
    try {
      await this.registry.respond(provider, requestId, result);
      this.pendingRequests.delete(key);
      for (const client of this.clients.values()) client.deliveredRequests.delete(key);
    } catch (error) {
      if (!/already resolved|expired/i.test(error.message)) this.resolvedRequests.delete(key);
      throw error;
    }
  }

  #sendPending(socket, subscription) {
    const { provider, threadId } = subscription.target;
    for (const entry of this.pendingRequests.values()) {
      if (entry.provider === provider && entry.request.params?.threadId === threadId) {
        this.#sendServerRequest(socket, provider, entry.request, subscription);
      }
    }
  }

  #sendServerRequest(socket, provider, request, subscription = this.clients.get(socket)?.threadSubscription) {
    const client = this.clients.get(socket);
    const key = approvalKey(provider, request.id);
    if (!client || client.deliveredRequests.has(key)) return;
    client.deliveredRequests.add(key);
    const type = request.method === 'item/tool/requestUserInput' ? 'interaction' : 'approval';
    this.#deliverThreadMessage(socket, subscription, {
      type, provider, request, tmuxSession: subscription?.target.tmuxSession || '',
    });
  }

  #clearProviderRequests(provider) {
    for (const [key, entry] of this.pendingRequests) {
      if (entry.provider !== provider) continue;
      this.pendingRequests.delete(key);
      for (const client of this.clients.values()) client.deliveredRequests.delete(key);
    }
  }
}

export const resolvedForTest = sessionMessageReceiptResolved;
