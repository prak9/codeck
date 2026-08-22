import path from 'node:path';
import { EventEmitter } from 'node:events';
import { resolveSessionStatus } from './session-status.js';

const SESSION_START_MATCH_MS = 120_000;

function approvalKey(provider, id) {
  return `${provider}:${String(id)}`;
}

function subscriptionKey(provider, threadId) {
  return `${provider}:${threadId}`;
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
    if (assignments.has(session) || !session.agent.cwd) continue;
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
  constructor(backends, { listTmuxSessions, sendTmuxMessage, interruptTmuxSession } = {}) {
    super();
    this.backends = new Map(Object.entries(backends || {}));
    this.listTmuxSessions = listTmuxSessions;
    this.sendTmuxMessage = sendTmuxMessage;
    this.interruptTmuxSession = interruptTmuxSession;
    for (const [provider, backend] of this.backends) {
      backend.on('notification', (message) => this.emit('notification', { provider, ...message }));
      backend.on('serverRequest', (message) => this.emit('serverRequest', { provider, ...message }));
      backend.on('backendError', (error) => this.emit('backendError', { provider, error }));
    }
  }

  providerInfo() {
    return [...this.backends.entries()].map(([id, backend]) => ({ id, label: backend.label || id }));
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
    this.backend(provider);
    if (!this.sendTmuxMessage) throw new Error('当前服务不支持直接参与 tmux 会话');
    return this.sendTmuxMessage({ provider, ...params });
  }
  interruptSession(provider, params) {
    this.backend(provider);
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
  constructor(registry, { defaultCwd = process.cwd(), hostname = '' } = {}) {
    this.registry = registry;
    this.defaultCwd = defaultCwd;
    this.hostname = hostname;
    this.clients = new Map();
    this.pendingRequests = new Map();
    this.resolvedRequests = new Set();
    registry.on('notification', (message) => this.#broadcastNotification(message));
    registry.on('serverRequest', (message) => this.#broadcastServerRequest(message));
    registry.on('backendError', ({ provider }) => this.#clearProviderRequests(provider));
  }

  handleConnection(socket) {
    const client = { subscriptions: new Set(), deliveredRequests: new Set() };
    this.clients.set(socket, client);
    send(socket, {
      type: 'ready',
      defaultCwd: this.defaultCwd,
      hostname: this.hostname,
      providers: this.registry.providerInfo(),
    });
    socket.on('message', (data) => this.#handleMessage(socket, data));
    socket.once('close', () => this.clients.delete(socket));
    socket.once('error', () => this.clients.delete(socket));
  }

  async #handleMessage(socket, data) {
    let message;
    try {
      message = JSON.parse(String(data));
      if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid message');
      const result = await this.#dispatch(socket, message);
      if (message.id != null) send(socket, { id: message.id, ok: true, result });
    } catch (error) {
      const id = message?.id;
      send(socket, { id, ok: false, error: error.message || 'Agent request failed' });
    }
  }

  async #dispatch(socket, message) {
    const provider = cleanProvider(message.provider);
    if (message.type === 'listThreads') return this.registry.listThreads(provider);
    if (message.type === 'openThread') {
      const threadId = cleanId(message.threadId, 'Thread');
      this.registry.backend(provider);
      this.clients.get(socket)?.subscriptions.add(subscriptionKey(provider, threadId));
      try {
        const options = message.readOnly === true ? { readOnly: true } : undefined;
        const result = await this.registry.openThread(provider, threadId, options);
        this.#sendPending(socket, provider, threadId);
        return result;
      } catch (error) {
        this.clients.get(socket)?.subscriptions.delete(subscriptionKey(provider, threadId));
        throw error;
      }
    }
    if (message.type === 'sendSessionMessage') {
      const threadId = cleanId(message.threadId, 'Thread');
      const sessionName = cleanId(message.tmuxSession, 'tmux session');
      const text = cleanMessage(message.text);
      this.clients.get(socket)?.subscriptions.add(subscriptionKey(provider, threadId));
      return this.registry.sendSessionMessage(provider, { threadId, sessionName, text });
    }
    if (message.type === 'interruptSession') {
      return this.registry.interruptSession(provider, {
        threadId: cleanId(message.threadId, 'Thread'),
        sessionName: cleanId(message.tmuxSession, 'tmux session'),
      });
    }
    if (message.type === 'newThread') {
      const text = cleanMessage(message.text);
      const cwd = typeof message.cwd === 'string' && message.cwd.trim() ? message.cwd.trim() : this.defaultCwd;
      if (!path.isAbsolute(cwd)) throw new Error('Working directory must be an absolute path');
      const result = await this.registry.newThread(provider, { cwd, text });
      this.clients.get(socket)?.subscriptions.add(subscriptionKey(provider, result.thread.id));
      this.#sendPending(socket, provider, result.thread.id);
      return result;
    }
    if (message.type === 'sendMessage') {
      const threadId = cleanId(message.threadId, 'Thread');
      const text = cleanMessage(message.text);
      this.clients.get(socket)?.subscriptions.add(subscriptionKey(provider, threadId));
      return this.registry.sendMessage(provider, {
        threadId,
        turnId: typeof message.turnId === 'string' ? message.turnId : undefined,
        mode: message.mode === 'steer' ? 'steer' : 'followUp',
        text,
      });
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

  #broadcastNotification(message) {
    const { provider, method, params } = message;
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
    const key = subscriptionKey(provider, params?.threadId);
    for (const [socket, client] of this.clients) {
      if (client.subscriptions.has(key)) send(socket, { type: 'event', provider, method, params });
    }
  }

  #broadcastServerRequest(message) {
    const { provider, ...request } = message;
    const requestKey = approvalKey(provider, request.id);
    this.resolvedRequests.delete(requestKey);
    for (const client of this.clients.values()) client.deliveredRequests.delete(requestKey);
    this.pendingRequests.set(requestKey, { provider, request });
    const key = subscriptionKey(provider, request.params?.threadId);
    for (const [socket, client] of this.clients) {
      if (client.subscriptions.has(key)) this.#sendServerRequest(socket, provider, request);
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

  #sendPending(socket, provider, threadId) {
    for (const entry of this.pendingRequests.values()) {
      if (entry.provider === provider && entry.request.params?.threadId === threadId) {
        this.#sendServerRequest(socket, provider, entry.request);
      }
    }
  }

  #sendServerRequest(socket, provider, request) {
    const client = this.clients.get(socket);
    const key = approvalKey(provider, request.id);
    if (!client || client.deliveredRequests.has(key)) return;
    client.deliveredRequests.add(key);
    const type = request.method === 'item/tool/requestUserInput' ? 'interaction' : 'approval';
    send(socket, { type, provider, request });
  }

  #clearProviderRequests(provider) {
    for (const [key, entry] of this.pendingRequests) {
      if (entry.provider !== provider) continue;
      this.pendingRequests.delete(key);
      for (const client of this.clients.values()) client.deliveredRequests.delete(key);
    }
  }
}
