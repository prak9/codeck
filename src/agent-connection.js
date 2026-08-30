import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { COMMAND_RECEIPT_TTL_MS, createCommandReceiptCache } from './command-receipts.js';
import { resolveSessionStatus } from './session-status.js';

const SESSION_START_MATCH_MS = 120_000;

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
  } = {}) {
    this.registry = registry;
    this.defaultCwd = defaultCwd;
    this.hostname = hostname;
    this.protocolEpoch = protocolEpoch;
    this.sessionFeed = sessionFeed;
    this.threadFeed = threadFeed;
    this.invalidateSessions = invalidateSessions;
    this.clients = new Map();
    this.commandReceipts = createCommandReceiptCache();
    this.pendingRequests = new Map();
    this.resolvedRequests = new Set();
    registry.on('notification', (message) => this.#broadcastNotification(message));
    registry.on('serverRequest', (message) => this.#broadcastServerRequest(message));
    registry.on('backendError', ({ provider }) => this.#clearProviderRequests(provider));
  }

  handleConnection(socket) {
    const client = {
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
        version: 1,
        epoch: this.protocolEpoch,
        commandReceiptTtlMs: COMMAND_RECEIPT_TTL_MS,
      },
      providers: this.registry.providerInfo(),
    });
    if (this.sessionFeed) {
      client.unsubscribeSessions = this.sessionFeed.subscribe(
        'sessions',
        ({ epoch, sequence, snapshot }) => {
          const subscription = client.threadSubscription;
          const previousStatus = subscription?.target.tmuxSession
            ? client.sessionStatuses.get(subscription.target.tmuxSession)
            : null;
          client.sessionStatuses = new Map((snapshot?.sessions || []).map((session) => [session.name, session.status]));
          send(socket, {
            type: 'sessionsSnapshot',
            version: 1,
            stream: { epoch, sequence },
            snapshot,
          });
          const currentStatus = subscription?.target.tmuxSession
            ? client.sessionStatuses.get(subscription.target.tmuxSession)
            : null;
          if (currentStatus === 'working' && previousStatus !== 'working') {
            this.#refreshThreadSubscription(subscription.target);
          } else if (previousStatus === 'working' && currentStatus !== 'working') {
            this.#invalidateThreadSubscription(subscription.target);
          }
        },
        (error) => send(socket, {
          type: 'sessionsStreamError',
          version: 1,
          error: error.message || 'Session stream failed',
        }),
      );
    }
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
    if (message.type === 'unsubscribeThread') {
      this.#clearThreadSubscription(socket, this.clients.get(socket)?.threadSubscription);
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
      const subscription = this.#beginThreadSubscription(socket, target);
      try {
        const options = message.readOnly === true ? { readOnly: true } : undefined;
        if (options && provider === 'codex' && this.threadFeed) options.progressive = true;
        const result = await this.registry.openThread(provider, threadId, options);
        return afterReply(result, () => this.#activateThreadSubscription(socket, subscription));
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
      if (provider !== 'shell') this.registry.backend(provider);
      this.#ensureThreadSubscription(socket, { provider, threadId, tmuxSession: sessionName });
      const payload = {
        threadId, sessionName, text,
        ...(turnId ? { turnId, mode: message.mode === 'steer' ? 'steer' : 'followUp' } : {}),
      };
      return this.#runCommand(message, provider, payload, async () => {
        const result = await this.registry.sendSessionMessage(provider, { threadId, sessionName, text });
        this.registry.recordSessionMessage(provider, {
          threadId, turnId, text,
          commandId: message.commandId == null ? '' : String(message.commandId).trim(),
        });
        this.#invalidateSessionFeed();
        this.#refreshThreadSubscription({ provider, threadId, tmuxSession: sessionName });
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

  #invalidateSessionFeed() {
    try {
      const refresh = this.invalidateSessions
        ? this.invalidateSessions()
        : this.sessionFeed?.invalidate('sessions');
      Promise.resolve(refresh).catch(() => {});
    } catch { /* The session stream reports its own recoverable loader errors. */ }
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

  #beginThreadSubscription(socket, target) {
    const client = this.clients.get(socket);
    if (!client) return null;
    client.threadSubscription?.unsubscribe?.();
    const subscription = {
      target,
      ready: false,
      pending: [],
      unsubscribe: null,
    };
    client.threadSubscription = subscription;
    return subscription;
  }

  #activateThreadSubscription(socket, subscription) {
    const client = this.clients.get(socket);
    if (!client || !subscription || client.threadSubscription !== subscription) return;
    subscription.ready = true;
    if (this.threadFeed && subscription.target.provider !== 'shell') {
      subscription.unsubscribe = this.threadFeed.subscribe(
        subscription.target,
        ({ epoch, sequence, snapshot }) => this.#deliverThreadMessage(socket, subscription, {
          type: 'threadSnapshot',
          version: 1,
          target: subscription.target,
          stream: { epoch, sequence },
          thread: snapshot?.thread,
        }),
        (error) => this.#deliverThreadMessage(socket, subscription, {
          type: 'threadStreamError',
          version: 1,
          target: subscription.target,
          error: error.message || 'Thread stream failed',
        }),
      );
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
