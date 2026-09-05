import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import nodePath from 'node:path';
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
import { stripTerminalInputResidue } from '../public/terminal-input.js';
import { latestAgentOutputText } from '../public/remote-copy.js';
import { isUserMessageDeliveryConfirmed } from '../public/agent-model.js';

const CODEX_APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'applyPatchApproval',
  'execCommandApproval',
]);
const CODEX_RECENT_USER_TURN_LIMIT = 10;
const CODEX_PROGRESSIVE_TURN_LIMIT = 20;
const CODEX_HISTORY_POSITION_LIMIT = 1_024;

function codexUserItems(turn) {
  return (Array.isArray(turn?.items) ? turn.items : [])
    .filter((item) => item?.type === 'userMessage');
}

function codexUserItemText(item) {
  const text = typeof item?.content === 'string'
    ? item.content
    : (Array.isArray(item?.content) ? item.content : [])
      .filter((part) => typeof part?.text === 'string')
      .map((part) => part.text)
      .join('\n');
  return stripTerminalInputResidue(text);
}

function codexTurnConfirmsDelivery(turn, item) {
  if (item.delivery?.baselineVersion === 2) {
    return isUserMessageDeliveryConfirmed({ turns: [turn] }, { text: codexUserItemText(item), ...item.delivery });
  }
  return codexUserItems(turn).some((candidate) => codexUserItemText(candidate) === codexUserItemText(item));
}

function mergeCodexUserItems(current, incoming, turnId) {
  const used = new Set();
  const users = (Array.isArray(current) ? current : []).map((currentItem) => {
    let index = incoming.findIndex((item, candidateIndex) => (
      !used.has(candidateIndex) && currentItem.id && item.id === currentItem.id
    ));
    if (index < 0 && currentItem.delivery
      && codexTurnConfirmsDelivery({ id: turnId, items: incoming }, currentItem)) {
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

function mergeCodexFullTurn(summaryTurn, fullTurn, cachedUsers) {
  const items = [...(Array.isArray(fullTurn?.items) ? fullTurn.items : [])];
  const itemIds = new Set(items.map((item) => item?.id).filter(Boolean));
  for (const item of Array.isArray(cachedUsers) ? cachedUsers : []) {
    if (item?.id && itemIds.has(item.id)) continue;
    if (item?.delivery && codexTurnConfirmsDelivery(fullTurn, item)) continue;
    items.push(item);
  }
  return { ...summaryTurn, ...fullTurn, items };
}

function codexTurnNeedsFullItems(turn) {
  return turn?.status === 'inProgress' || turn?.status === 'interrupted';
}

function isActiveWriterError(error) {
  return /already has an active writer/i.test(error?.message || '');
}

// Codex 的 thread-store 是 SQLite。它自己的 TUI 在写、codeck 在读, 撞上就是 SQLITE_BUSY,
// 而那是瞬时的 —— 读又是幂等的, 退让几毫秒再试通常就过了。原样抛给界面只会让用户
// 自己再点一次。
const LOCKED_STORE_RETRIES = 3;
const LOCKED_STORE_DELAY_MS = 120;

function isLockedStoreError(error) {
  return /database is locked|SQLITE_BUSY|\(code: 5\)/i.test(error?.message || '');
}

function codexAnswers(answers) {
  return Object.fromEntries(Object.entries(answers || {}).map(([id, values]) => [id, {
    answers: Array.isArray(values) ? values.map(String) : [],
  }]));
}

export class CodexAgentBackend extends EventEmitter {
  constructor(appServer = new CodexAppServer(), {
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {}) {
    super();
    this.wait = wait;
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
    this.historyPositions = new Map();
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

  // 读操作幂等, 所以只有读走重试; 写不能重放。
  async #readStore(method, params) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.appServer.request(method, params);
      } catch (error) {
        if (attempt >= LOCKED_STORE_RETRIES || !isLockedStoreError(error)) throw error;
        await this.wait(LOCKED_STORE_DELAY_MS * (attempt + 1));
      }
    }
  }

  listThreads() {
    return this.#readStore('thread/list', {
      limit: 80,
      sortKey: 'updated_at',
      sortDirection: 'desc',
    });
  }

  async readLatestAgentOutput(threadId) {
    let cursor;
    do {
      const page = await this.#readStore('thread/turns/list', {
        threadId,
        limit: CODEX_PROGRESSIVE_TURN_LIMIT,
        sortDirection: 'desc',
        itemsView: 'summary',
        ...(cursor ? { cursor } : {}),
      });
      const turns = Array.isArray(page?.data) ? [...page.data] : [];
      // Match exact openThread reads: Codex summaries can omit newly appended text
      // from the latest interrupted turn. Other turns need no full tool hydration.
      if (!cursor && turns[0]?.status === 'interrupted') {
        const full = await this.#readLatestFullTurn(threadId, turns[0].id);
        if (full) turns[0] = full;
      }
      const text = latestAgentOutputText(turns.reverse());
      if (text) return { text };
      cursor = page?.nextCursor;
    } while (cursor);
    return { text: '' };
  }

  #rememberHistoryPosition(threadId, turnId, position) {
    if (!turnId) return;
    const key = JSON.stringify([threadId, turnId]);
    this.historyPositions.delete(key);
    this.historyPositions.set(key, position);
    if (this.historyPositions.size > CODEX_HISTORY_POSITION_LIMIT) {
      this.historyPositions.delete(this.historyPositions.keys().next().value);
    }
  }

  async loadThreadHistory(threadId, { beforeTurnId = '', limit = CODEX_PROGRESSIVE_TURN_LIMIT } = {}) {
    // Cache positions, not transcript contents. A null cursor is the known end;
    // partial pages keep their page cursor plus the turn to seek past within it.
    const key = JSON.stringify([threadId, beforeTurnId]);
    const position = this.historyPositions.get(key);
    let cursor = position?.cursor;
    let anchor = position ? position.anchor : beforeTurnId;
    const collected = [];
    const visited = new Set();
    let truncated = false;
    while (cursor !== null) {
      if (visited.has(cursor)) throw new Error('Thread history cursor did not advance');
      visited.add(cursor);
      const page = await this.#readStore('thread/turns/list', {
        threadId, limit: CODEX_PROGRESSIVE_TURN_LIMIT, sortDirection: 'desc', itemsView: 'summary',
        ...(cursor ? { cursor } : {}),
      }).catch((error) => {
        // A store restart can invalidate an opaque cursor. A retry must locate the
        // anchor again instead of repeatedly submitting the same stale position.
        this.historyPositions.delete(key);
        throw error;
      });
      const turns = Array.isArray(page?.data) ? page.data : [];
      const nextCursor = page?.nextCursor || null;
      this.#rememberHistoryPosition(threadId, turns.at(-1)?.id, { cursor: nextCursor, anchor: '' });
      const index = anchor ? turns.findIndex((turn) => turn.id === anchor) : -1;
      if (anchor && index < 0) {
        cursor = nextCursor;
        continue;
      }
      anchor = '';
      const available = turns.slice(index + 1);
      const taken = available.slice(0, limit - collected.length);
      collected.push(...taken);
      truncated = taken.length < available.length || Boolean(nextCursor);
      if (taken.length) {
        this.#rememberHistoryPosition(threadId, taken.at(-1).id,
          taken.length < available.length
            ? { cursor, anchor: taken.at(-1).id }
            : { cursor: nextCursor, anchor: '' });
      }
      if (collected.length >= limit) break;
      cursor = nextCursor;
    }
    if (anchor) throw new Error('Thread history anchor is no longer present');
    await this.#hydrateUserMessages(threadId);
    const cachedUsers = this.userMessages.get(threadId);
    const turns = this.#reconcileUserDeliveries(threadId, collected.reverse()
      .map((turn) => mergeCodexSummaryUsers(turn, cachedUsers?.get(turn.id))));
    return { turns, truncated, oldestTurnId: turns[0]?.id || null };
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
    const read = this.#readStore('thread/read', { threadId, includeTurns: false });
    const summary = this.#readStore('thread/turns/list', {
      threadId,
      limit: progressive ? CODEX_PROGRESSIVE_TURN_LIMIT : 80,
      sortDirection: 'desc',
      itemsView: 'summary',
    });
    const hydration = this.#hydrateUserMessages(threadId);
    const [result, turnPage] = await Promise.all([read, summary]);
    const summaryTurns = Array.isArray(turnPage?.data) ? [...turnPage.data].reverse() : [];
    this.#rememberHistoryPosition(threadId, summaryTurns[0]?.id, { cursor: turnPage?.nextCursor || null, anchor: '' });
    const latestSummaryTurn = summaryTurns.at(-1);
    const latestFull = !progressive && readOnly && codexTurnNeedsFullItems(latestSummaryTurn)
      ? this.#readLatestFullTurn(threadId, latestSummaryTurn.id)
      : Promise.resolve(null);
    if (summaryTurns.length && !progressive) await Promise.all([hydration, latestFull]);
    const fullTurn = await latestFull;
    const cachedUsers = this.userMessages.get(threadId);
    const turns = this.#reconcileUserDeliveries(threadId, summaryTurns.map((turn) => (
      turn.id === fullTurn?.id
        ? mergeCodexFullTurn(turn, fullTurn, cachedUsers?.get(turn.id))
        : mergeCodexSummaryUsers(turn, cachedUsers?.get(turn.id))
    )));
    return {
      ...result,
      thread: {
        ...result.thread,
        turns,
        truncated: Boolean(turnPage?.nextCursor),
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

  recordSessionMessage({
    threadId, turnId, text, commandId, submissionStatus,
    baselineVersion, baselineUserMessageId, baselineTurnId, baselineMatchingTextCount,
  }) {
    if (!threadId || !turnId || typeof text !== 'string' || !text.trim()) return;
    this.#cacheUserItem(threadId, turnId, {
      id: `delivery:${commandId || crypto.randomUUID()}`,
      type: 'userMessage',
      content: [{ type: 'text', text }],
      delivery: {
        status: 'accepted',
        submissionStatus: submissionStatus === 'submitted' ? 'submitted' : 'unconfirmed',
        ...(baselineVersion === 2 ? {
          baselineVersion, baselineUserMessageId, baselineTurnId, baselineMatchingTextCount,
        } : {}),
      },
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
    this.historyPositions.clear();
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

  #reconcileUserDeliveries(threadId, turns) {
    const resolved = new Set();
    for (const turn of turns) {
      for (const item of codexUserItems(turn)) {
        if (item.delivery?.baselineVersion === 2 && isUserMessageDeliveryConfirmed(
          { turns }, { text: codexUserItemText(item), ...item.delivery },
        )) resolved.add(item.id);
      }
    }
    if (!resolved.size) return turns;
    const cachedUsers = this.userMessages.get(threadId);
    return turns.map((turn) => {
      const items = (turn.items || []).filter((item) => !resolved.has(item.id));
      if (items.length === (turn.items || []).length) return turn;
      const users = cachedUsers?.get(turn.id);
      if (users) cachedUsers.set(turn.id, users.filter((item) => !resolved.has(item.id)));
      return { ...turn, items };
    });
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
        && codexTurnConfirmsDelivery({ id: turnId, items: [...users, item] }, candidate)
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
      turns.set(turn.id, mergeCodexUserItems(turns.get(turn.id), incoming, turn.id));
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

  async #readLatestFullTurn(threadId, expectedTurnId) {
    try {
      const page = await this.appServer.request('thread/turns/list', {
        threadId,
        limit: 1,
        sortDirection: 'desc',
        itemsView: 'full',
      });
      const turn = (Array.isArray(page?.data) ? page.data : [])
        .find((candidate) => candidate?.id === expectedTurnId);
      if (turn) this.#cacheTurnUsers(threadId, turn, { replace: true });
      return turn || null;
    } catch {
      // The full active-turn view supplements the lightweight transcript.
      return null;
    }
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


// Claude Code 把 transcript 写在 ~/.claude/projects/<cwd 的 / 换成 ->/<sessionId>.jsonl。
// 这是 SDK 的内部布局, 所以只有在文件确实存在、且大小与 SDK 自己报告的 fileSize
// 完全一致时才认它。布局一旦变化, 校验失败 -> 回落到 SDK 的整份读取, 只会变慢,
// 不会读错。
function claudeTranscriptFile(threadId, info, { requireSize = true } = {}) {
  const cwd = typeof info?.cwd === 'string' ? info.cwd : '';
  const size = Number(info?.fileSize);
  if (!cwd || !/^[0-9a-fA-F-]{36}$/.test(threadId)) return null;
  if (requireSize && !Number.isFinite(size)) return null;
  const file = nodePath.join(
    os.homedir(), '.claude', 'projects', cwd.replace(/\//g, '-'), `${threadId}.jsonl`,
  );
  try {
    if (requireSize && fs.statSync(file).size !== size) return null;
    if (!requireSize && !fs.statSync(file).isFile()) return null;
  } catch {
    return null;
  }
  return file;
}

async function readTranscriptRange(file, start, end) {
  const handle = await fsp.open(file, 'r');
  try {
    const length = Math.max(0, end - start);
    if (!length) return '';
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, Math.max(0, start));
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
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
      transcriptFile: claudeTranscriptFile,
      readTranscriptRange,
      readTranscriptFile: (file) => fsp.readFile(file, 'utf8'),
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
