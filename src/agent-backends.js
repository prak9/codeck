import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  getSessionInfo as getClaudeSessionInfo,
  getSessionMessages as getClaudeSessionMessages,
  listSessions as listClaudeSessions,
  query as queryClaude,
} from '@anthropic-ai/claude-agent-sdk';
import {
  getSessionInfo as getQoderSessionInfo,
  getSessionMessages as getQoderSessionMessages,
  listSessions as listQoderSessions,
  qodercliAuth,
  query as queryQoder,
} from '@qoder-ai/qoder-agent-sdk';
import { CodexAppServer } from './codex-app-server.js';
import { SdkAgentBackend } from './sdk-agent-backend.js';

const CODEX_APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'applyPatchApproval',
  'execCommandApproval',
]);
const CODEX_RECENT_USER_TURN_LIMIT = 10;
const CODEX_PROGRESSIVE_TURN_LIMIT = 20;

function codexUserItems(turn) {
  return (Array.isArray(turn?.items) ? turn.items : [])
    .filter((item) => item?.type === 'userMessage');
}

function codexUserItemText(item) {
  if (typeof item?.content === 'string') return item.content;
  return (Array.isArray(item?.content) ? item.content : [])
    .filter((part) => typeof part?.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

function mergeCodexUserItems(current, incoming) {
  const used = new Set();
  const users = (Array.isArray(current) ? current : []).map((currentItem) => {
    let index = incoming.findIndex((item, candidateIndex) => (
      !used.has(candidateIndex) && currentItem.id && item.id === currentItem.id
    ));
    if (index < 0 && currentItem.delivery) {
      const text = codexUserItemText(currentItem);
      index = incoming.findIndex((item, candidateIndex) => (
        !used.has(candidateIndex) && codexUserItemText(item) === text
      ));
    }
    if (index < 0) return currentItem;
    used.add(index);
    return incoming[index];
  });
  incoming.forEach((item, index) => {
    if (!used.has(index)) users.push(item);
  });
  return users;
}

function mergeCodexSummaryUsers(turn, cachedUsers) {
  if (!Array.isArray(cachedUsers) || !cachedUsers.length) return turn;
  const items = Array.isArray(turn?.items) ? turn.items : [];
  const users = [...cachedUsers];
  const ids = new Set(users.map((item) => item?.id).filter(Boolean));
  for (const item of codexUserItems(turn)) {
    if (!item.id || !ids.has(item.id)) users.push(item);
  }
  return {
    ...turn,
    items: [...users, ...items.filter((item) => item?.type !== 'userMessage')],
  };
}

function isActiveWriterError(error) {
  return /already has an active writer/i.test(error?.message || '');
}

function codexAnswers(answers) {
  return Object.fromEntries(Object.entries(answers || {}).map(([id, values]) => [id, {
    answers: Array.isArray(values) ? values.map(String) : [],
  }]));
}

export class CodexAgentBackend extends EventEmitter {
  constructor(appServer = new CodexAppServer()) {
    super();
    this.provider = 'codex';
    this.label = 'Codex';
    this.capabilities = {
      structuredTranscript: true,
      liveEvents: true,
      directTmuxInput: true,
      slashCommands: true,
      attachments: true,
    };
    this.appServer = appServer;
    this.pendingRequests = new Map();
    this.userMessages = new Map();
    this.userMessageLoads = new Map();
    this.hydratedUserMessages = new Set();
    appServer.on('notification', (message) => {
      this.#observeNotification(message);
      this.emit('notification', message);
    });
    appServer.on('serverRequest', (message) => this.#handleServerRequest(message));
    appServer.on('exit', (error) => {
      this.pendingRequests.clear();
      this.emit('backendError', error);
    });
  }

  listThreads() {
    return this.appServer.request('thread/list', {
      limit: 80,
      sortKey: 'updated_at',
      sortDirection: 'desc',
    });
  }

  async openThread(threadId, { readOnly = false, progressive = false } = {}) {
    if (!readOnly) {
      try {
        await this.appServer.request('thread/resume', { threadId });
      } catch (error) {
        if (!isActiveWriterError(error)) throw error;
        readOnly = true;
      }
    }
    const read = this.appServer.request('thread/read', { threadId, includeTurns: false });
    const summary = this.appServer.request('thread/turns/list', {
      threadId,
      limit: progressive ? CODEX_PROGRESSIVE_TURN_LIMIT : 80,
      sortDirection: 'desc',
      itemsView: 'summary',
    });
    const hydration = this.#hydrateUserMessages(threadId);
    const [result, turnPage] = await Promise.all([read, summary]);
    const summaryTurns = Array.isArray(turnPage?.data) ? [...turnPage.data].reverse() : [];
    if (summaryTurns.length && !progressive) await hydration;
    const cachedUsers = this.userMessages.get(threadId);
    const turns = summaryTurns.map((turn) => mergeCodexSummaryUsers(turn, cachedUsers?.get(turn.id)));
    return {
      ...result,
      thread: {
        ...result.thread,
        turns,
        readOnly,
        ...(readOnly ? { readOnlyReason: 'activeWriter' } : {}),
      },
    };
  }

  async newThread({ cwd, text }) {
    const { thread } = await this.appServer.request('thread/start', { cwd, serviceName: 'codeck' });
    const { turn } = await this.appServer.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text }],
    });
    return { thread: { ...thread, turns: [...(thread.turns || []), turn] }, turn };
  }

  async sendMessage({ threadId, turnId, mode, text }) {
    const input = [{ type: 'text', text }];
    if (mode === 'steer') {
      if (!turnId) throw new Error('A running turn is required for steering');
      const result = await this.appServer.request('turn/steer', {
        threadId,
        expectedTurnId: turnId,
        input,
      });
      return { ...result, queued: true };
    }
    return this.appServer.request('turn/start', { threadId, input });
  }

  recordSessionMessage({ threadId, turnId, text, commandId }) {
    if (!threadId || !turnId || typeof text !== 'string' || !text.trim()) return;
    this.#cacheUserItem(threadId, turnId, {
      id: `delivery:${commandId || crypto.randomUUID()}`,
      type: 'userMessage',
      content: [{ type: 'text', text }],
      delivery: { status: 'accepted' },
    });
  }

  interruptTurn({ threadId, turnId }) {
    return this.appServer.request('turn/interrupt', { threadId, turnId });
  }

  async respond(id, result) {
    const key = String(id);
    const request = this.pendingRequests.get(key);
    if (!request) throw new Error('Request was already resolved or expired');
    let response = result;
    if (request.method === 'item/permissions/requestApproval') {
      const accepted = result?.decision === 'accept' || result?.decision === 'acceptForSession';
      response = {
        permissions: accepted ? request.params?.permissions || {} : {},
        scope: result?.decision === 'acceptForSession' ? 'session' : 'turn',
      };
    } else if (request.method === 'item/tool/requestUserInput') {
      response = { answers: codexAnswers(result?.answers) };
    }
    await this.appServer.respond(id, response);
    this.pendingRequests.delete(key);
  }

  close() {
    this.pendingRequests.clear();
    this.userMessages.clear();
    this.userMessageLoads.clear();
    this.hydratedUserMessages.clear();
    this.appServer.close();
  }

  #threadUserMessages(threadId) {
    let turns = this.userMessages.get(threadId);
    if (!turns) {
      turns = new Map();
      this.userMessages.set(threadId, turns);
    }
    return turns;
  }

  #cacheUserItem(threadId, turnId, item) {
    if (!threadId || !turnId || item?.type !== 'userMessage') return;
    const turns = this.#threadUserMessages(threadId);
    const users = [...(turns.get(turnId) || [])];
    let index = users.findIndex((candidate) => candidate.id === item.id);
    if (index < 0 && !item.delivery) {
      const text = codexUserItemText(item);
      index = users.findIndex((candidate) => (
        candidate.delivery && codexUserItemText(candidate) === text
      ));
    }
    if (index < 0) users.push(item);
    else users[index] = item;
    turns.set(turnId, users);
  }

  #cacheTurnUsers(threadId, turn, { replace = false } = {}) {
    if (!threadId || !turn?.id) return;
    const incoming = codexUserItems(turn);
    if (!incoming.length) return;
    const turns = this.#threadUserMessages(threadId);
    if (replace) {
      turns.set(turn.id, mergeCodexUserItems(turns.get(turn.id), incoming));
      return;
    }
    for (const item of incoming) this.#cacheUserItem(threadId, turn.id, item);
  }

  #hydrateUserMessages(threadId, { force = false, limit = CODEX_RECENT_USER_TURN_LIMIT } = {}) {
    const inFlight = this.userMessageLoads.get(threadId);
    if (inFlight) return inFlight;
    if (!force && this.hydratedUserMessages.has(threadId)) return Promise.resolve();
    const load = this.appServer.request('thread/turns/list', {
      threadId,
      limit,
      sortDirection: 'desc',
      itemsView: 'full',
    }).then((page) => {
      for (const turn of Array.isArray(page?.data) ? page.data : []) {
        this.#cacheTurnUsers(threadId, turn, { replace: true });
      }
      this.hydratedUserMessages.add(threadId);
    }).catch(() => {
      // Full user-message hydration is an enhancement over the summary transcript.
      // Keep the thread readable if the optional view is unavailable.
    }).finally(() => {
      if (this.userMessageLoads.get(threadId) === load) this.userMessageLoads.delete(threadId);
    });
    this.userMessageLoads.set(threadId, load);
    return load;
  }

  #observeNotification(message) {
    const params = message?.params || {};
    const threadId = params.threadId;
    if (!threadId) return;
    if (params.item?.type === 'userMessage' && params.turnId) {
      this.#cacheUserItem(threadId, params.turnId, params.item);
    }
    if (params.turn) this.#cacheTurnUsers(threadId, params.turn);
    if (message.method === 'turn/completed') {
      this.#hydrateUserMessages(threadId, { force: true, limit: 1 });
    }
  }

  #handleServerRequest(message) {
    if (CODEX_APPROVAL_METHODS.has(message.method) || message.method === 'item/tool/requestUserInput') {
      this.pendingRequests.set(String(message.id), message);
      this.emit('serverRequest', message);
      return;
    }
    if (message.method === 'mcpServer/elicitation/request') {
      this.appServer.respond(message.id, { action: 'decline' }).catch((error) => this.emit('backendError', error));
      return;
    }
    if (message.method === 'item/tool/call') {
      this.appServer.respond(message.id, {
        success: false,
        contentItems: [{ type: 'inputText', text: 'Codeck does not expose client-side dynamic tools' }],
      }).catch((error) => this.emit('backendError', error));
      return;
    }
    this.appServer.respondError(message.id, -32601, `Unsupported Codex server request: ${message.method}`)
      .catch((error) => this.emit('backendError', error));
  }
}

export function createAgentBackends() {
  return {
    codex: new CodexAgentBackend(),
    claude: new SdkAgentBackend({
      provider: 'claude',
      label: 'Claude Code',
      query: queryClaude,
      queryOptions: () => ({
        env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'codeck/0.1.0' },
      }),
      listSessions: listClaudeSessions,
      getSessionInfo: getClaudeSessionInfo,
      getSessionMessages: getClaudeSessionMessages,
    }),
    qodercli: new SdkAgentBackend({
      provider: 'qodercli',
      label: 'QoderCLI',
      query: queryQoder,
      queryOptions: () => ({ auth: qodercliAuth() }),
      listSessions: listQoderSessions,
      getSessionInfo: getQoderSessionInfo,
      getSessionMessages: getQoderSessionMessages,
    }),
  };
}
