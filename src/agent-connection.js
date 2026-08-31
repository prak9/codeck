import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { COMMAND_RECEIPT_TTL_MS, createCommandReceiptCache } from './command-receipts.js';
import { resolveSessionStatus } from './session-status.js';

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
    baselineMatchingTextCount: count,
  };
}

function sessionUserMessageText(item) {
  if (typeof item?.content === 'string') return item.content;
  return (Array.isArray(item?.content) ? item.content : [])
    .filter((part) => typeof part?.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

function sessionUserMessageEntries(thread) {
  return (Array.isArray(thread?.turns) ? thread.turns : []).flatMap((turn, turnIndex) => (
    (Array.isArray(turn?.items) ? turn.items : [])
      .filter((item) => item?.type === 'userMessage' && !item.delivery)
      .map((item) => ({ item, turnIndex }))
  ));
}

function sessionMessageReceiptResolved(thread, receipt) {
  if (receipt.baselineVersion !== 2) return false;
  const users = sessionUserMessageEntries(thread);
  let candidates;
  // thread 流只推尾部窗口时, 锚点可能已经滚出窗口。那意味着此后又发生了整整一个
  // 窗口的对话 —— 这条消息要么早就送达, 要么早已无从补救; 继续判为"未送达"只会
  // 让那条乐观回显永远挂着, 表现为一条重复的待发消息。
  const outOfWindow = Boolean(thread?.truncated);
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
      status: 'accepted',
      baselineVersion: receipt.baselineVersion,
      baselineUserMessageId: receipt.baselineUserMessageId,
      baselineTurnId: receipt.baselineTurnId,
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
    listTmuxSessions, sendTmuxMessage, selectTmuxModel, interruptTmuxSession,
  } = {}) {
    super();
    this.backends = new Map(Object.entries(backends || {}));
    this.listTmuxSessions = listTmuxSessions;
    this.sendTmuxMessage = sendTmuxMessage;
    this.selectTmuxModel = selectTmuxModel;
    this.interruptTmuxSession = interruptTmuxSession;
    for (const [provider, backend] of this.backends) {
      backend.on('notification', (message) => this.emit('notification', { provider, ...message }));
      backend.on('serverRequest', (message) => this.emit('serverRequest', { provider, ...message }));
      backend.on('backendError', (error) => this.emit('backendError', { provider, error }));
    }
  }

  providerInfo() {
    return [...this.backends.entries()].map(([id, backend]) => ({
      id,
      label: backend.label || id,
      ...(backend.capabilities ? { capabilities: { ...backend.capabilities } } : {}),
    }));
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
  openThread(provider, threadId, options) { return this.backend(provider).openThread(threadId, options); }
  sendSessionMessage(provider, params) {
    if (cleanProvider(provider) !== 'shell') this.backend(provider);
    if (!this.sendTmuxMessage) throw new Error('当前服务不支持直接参与 tmux 会话');
    return this.sendTmuxMessage({ provider, ...params });
  }
  selectSessionModel(provider, params) {
    this.backend(provider);
    if (!this.selectTmuxModel) throw new Error('当前服务不支持远程选择模型');
    return this.selectTmuxModel({ provider, ...params });
  }
  recordSessionMessage(provider, params) {
    if (cleanProvider(provider) === 'shell') return;
    this.backend(provider).recordSessionMessage?.(params);
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
  } = {}) {
    this.registry = registry;
    this.defaultCwd = defaultCwd;
    this.hostname = hostname;
    this.protocolEpoch = protocolEpoch;
    this.sessionFeed = sessionFeed;
    this.threadFeed = threadFeed;
    this.invalidateSessions = invalidateSessions;
    this.paneExcerpt = paneExcerpt;
    this.clients = new Map();
    this.commandReceipts = createCommandReceiptCache();
    this.sessionMessageReceipts = new Map();
    this.pendingRequests = new Map();
    this.resolvedRequests = new Set();
    registry.on('notification', (message) => this.#broadcastNotification(message));
    registry.on('serverRequest', (message) => this.#broadcastServerRequest(message));
    registry.on('backendError', ({ provider }) => this.#clearProviderRequests(provider));
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
    if (message.type === 'listThreads') return this.registry.listThreads(provider);
    if (message.type === 'openThread') {
      const threadId = cleanId(message.threadId, 'Thread');
      this.registry.backend(provider);
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
        if (options && provider === 'codex' && this.threadFeed) options.progressive = true;
        const result = this.#withPaneExcerpt(
          await this.registry.openThread(provider, threadId, options), target.tmuxSession,
        );
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
      this.#ensureThreadSubscription(socket, { provider, threadId, tmuxSession: sessionName });
      const payload = {
        threadId, sessionName, text,
        ...(turnId ? { turnId, mode: message.mode === 'steer' ? 'steer' : 'followUp' } : {}),
        ...baseline,
      };
      return this.#runCommand(message, provider, payload, async () => {
        const result = await this.registry.sendSessionMessage(provider, { threadId, sessionName, text });
        this.registry.recordSessionMessage(provider, {
          threadId, turnId, text,
          commandId,
          ...baseline,
        });
        const receiptRecorded = !turnId && provider !== 'shell' && commandId
          && !text.startsWith('/') && (!result?.terminalOutput || result.terminalWorking)
          && this.#recordSessionMessageReceipt(provider, {
            threadId, text, commandId,
            inputWasQueued: result?.inputWasQueued === true,
            ...baseline,
          });
        this.#invalidateSessionFeed();
        const target = { provider, threadId, tmuxSession: sessionName };
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
    if (message.type === 'interruptSession') {
      const target = {
        threadId: cleanId(message.threadId, 'Thread'),
        tmuxSession: cleanId(message.tmuxSession, 'tmux session'),
      };
      const result = await this.registry.interruptSession(provider, {
        threadId: target.threadId,
        sessionName: target.tmuxSession,
      });
      this.#invalidateSessionFeed();
      this.#refreshThreadSubscription({ provider, ...target });
      return result;
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
    const thread = result?.thread;
    if (!thread) return result;
    this.#pruneSessionMessageReceipts();
    const pending = [];
    for (const [commandId, receipt] of this.sessionMessageReceipts) {
      if (receipt.provider !== provider || receipt.threadId !== threadId) continue;
      if (sessionMessageReceiptResolved(thread, receipt)) {
        this.sessionMessageReceipts.delete(commandId);
      } else {
        pending.push(receipt);
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
      const turnIndex = receipt.inputWasQueued
        ? sessionMessageReceiptTurnIndex(restoredTurns, receipt)
        : -1;
      if (turnIndex < 0) {
        standalone.push(sessionMessageReceiptTurn(receipt));
      } else {
        if (restoredTurns === turns) restoredTurns = [...turns];
        const target = restoredTurns[turnIndex];
        const items = [...(Array.isArray(target?.items) ? target.items : [])];
        const firstOutput = items.findIndex((candidate) => candidate?.type !== 'userMessage');
        items.splice(firstOutput < 0 ? items.length : firstOutput, 0, item);
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
    if (frame.kind === 'delta' && subscription.deltaBaseSafe && !hasPendingReceipts) {
      this.#deliverThreadMessage(socket, subscription, {
        type: 'threadPatch', version: 2, target: subscription.target,
        stream: {
          epoch: frame.epoch, baseSequence: frame.baseSequence, sequence: frame.sequence,
        },
        patch: frame.patch,
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
        ? this.threadFeed.subscribeFrom(subscription.target, subscription.cursor, onSnapshot, onError)
        : this.threadFeed.subscribe(subscription.target, onSnapshot, onError);
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
      if (method === 'turn/completed') {
        refreshTargets.set(JSON.stringify(subscription.target), subscription.target);
      }
    }
    if (this.threadFeed) {
      for (const target of refreshTargets.values()) this.threadFeed.invalidate(target).catch(() => {});
    }
  }

  #broadcastServerRequest(message) {
    const { provider, ...request } = message;
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
