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
    appServer.on('notification', (message) => this.emit('notification', message));
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

  async openThread(threadId, { readOnly = false } = {}) {
    if (!readOnly) {
      try {
        await this.appServer.request('thread/resume', { threadId });
      } catch (error) {
        if (!isActiveWriterError(error)) throw error;
        readOnly = true;
      }
    }
    const [result, turnPage] = await Promise.all([
      this.appServer.request('thread/read', { threadId, includeTurns: false }),
      this.appServer.request('thread/turns/list', {
        threadId,
        limit: 80,
        sortDirection: 'desc',
        itemsView: 'summary',
      }),
    ]);
    const turns = Array.isArray(turnPage?.data) ? [...turnPage.data].reverse() : [];
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
    this.appServer.close();
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
