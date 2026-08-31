import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const MAX_TRANSCRIPT_CACHE_ENTRIES = 16;

class AsyncInputQueue {
  constructor() {
    this.values = [];
    this.waiters = [];
    this.closed = false;
  }

  [Symbol.asyncIterator]() { return this; }

  next() {
    if (this.values.length) return Promise.resolve({ value: this.values.shift(), done: false });
    if (this.closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  push(value) {
    if (this.closed) throw new Error('Agent input stream is closed');
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }
}

function contentBlocks(message) {
  const content = message?.message?.content ?? message?.content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content : [];
}

function textFromBlocks(blocks) {
  return blocks.filter((block) => block?.type === 'text').map((block) => block.text || '').join('');
}

function timestamp(value, fallback = Date.now()) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sessionToThread(info, turns = []) {
  const updatedAt = timestamp(info.lastModified, Date.now());
  const createdAt = timestamp(info.createdAt, updatedAt);
  return {
    id: info.sessionId,
    name: info.customTitle || null,
    preview: info.summary || info.firstPrompt || '新会话',
    cwd: info.cwd || '',
    createdAt: Math.round(createdAt / 1000),
    updatedAt: Math.round(updatedAt / 1000),
    status: turns.some((turn) => turn.status === 'inProgress') ? { type: 'active' } : { type: 'idle' },
    turns,
  };
}

function transcriptRevision(info) {
  const modified = typeof info?.lastModified === 'number'
    ? info.lastModified
    : Date.parse(info?.lastModified);
  const rawSize = info?.fileSize;
  const size = typeof rawSize === 'number'
    ? rawSize
    : typeof rawSize === 'string' && rawSize.trim() ? Number(rawSize) : Number.NaN;
  if (!Number.isFinite(modified) || !Number.isFinite(size) || size < 0) return null;
  return JSON.stringify([
    modified,
    size,
    info.cwd || '',
    info.customTitle || '',
    info.summary || '',
    info.firstPrompt || '',
  ]);
}

function transcriptToTurns(messages) {
  const turns = [];
  let turn = null;
  const toolItems = new Map();

  const ensureTurn = (id) => {
    if (!turn) {
      turn = { id: `turn-${id || crypto.randomUUID()}`, status: 'completed', items: [] };
      turns.push(turn);
    }
    return turn;
  };

  for (const entry of messages || []) {
    const blocks = contentBlocks(entry);
    if (entry.type === 'user') {
      const text = textFromBlocks(blocks).trim();
      const isToolResult = blocks.some((block) => block?.type === 'tool_result');
      if (text && !entry.parent_tool_use_id && !isToolResult) {
        turn = {
          id: `turn-${entry.uuid || crypto.randomUUID()}`,
          status: 'completed',
          items: [{
            id: entry.uuid || crypto.randomUUID(),
            type: 'userMessage',
            content: [{ type: 'text', text }],
          }],
        };
        turns.push(turn);
      }
      for (const block of blocks) {
        if (block?.type !== 'tool_result') continue;
        const item = toolItems.get(block.tool_use_id);
        if (!item) continue;
        item.status = block.is_error ? 'failed' : 'completed';
        item.result = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
      }
      continue;
    }
    if (entry.type !== 'assistant') continue;
    const target = ensureTurn(entry.uuid);
    for (const [index, block] of blocks.entries()) {
      const id = block?.id || `${entry.uuid || target.id}-${index}`;
      if (block?.type === 'text' && block.text) {
        target.items.push({ id, type: 'agentMessage', text: block.text });
      } else if (block?.type === 'thinking' && block.thinking) {
        target.items.push({ id, type: 'reasoning', summary: [block.thinking] });
      } else if (block?.type === 'tool_use') {
        const item = {
          id,
          type: 'mcpToolCall',
          server: 'agent',
          tool: block.name || 'Tool',
          arguments: block.input || {},
          status: 'inProgress',
        };
        target.items.push(item);
        toolItems.set(id, item);
      }
    }
  }
  return turns;
}

function withToolUseId(result, options) {
  return options.toolUseID ? { ...result, toolUseID: options.toolUseID } : result;
}

function normalizedQuestions(input, label) {
  const source = Array.isArray(input?.questions) ? input.questions : [{
    question: input?.question || `${label} 需要补充信息`,
    header: label,
    options: input?.options || [],
  }];
  return source.map((question, index) => ({
    id: `question-${index + 1}`,
    header: question.header || `问题 ${index + 1}`,
    question: question.question || `${label} 需要补充信息`,
    options: (Array.isArray(question.options) ? question.options : []).map((option) => (
      typeof option === 'string' ? { label: option, description: '' } : {
        label: option?.label || String(option || ''),
        description: option?.description || '',
      }
    )).filter((option) => option.label),
    multiSelect: Boolean(question.multiSelect),
    isOther: true,
  }));
}

function permissionResult(decision, approval) {
  const { input, options } = approval;
  if (approval.kind === 'userInput') {
    const answers = {};
    for (const question of approval.questions) {
      const values = decision?.answers?.[question.id];
      if (!Array.isArray(values) || !values.length) continue;
      answers[question.question] = values.map(String).join(', ');
    }
    if (!Object.keys(answers).length) {
      return withToolUseId({ behavior: 'deny', message: '用户没有提供答案' }, options);
    }
    const updatedInput = Array.isArray(input?.questions)
      ? { ...input, answers }
      : { ...input, answer: Object.values(answers)[0] };
    return withToolUseId({ behavior: 'allow', updatedInput }, options);
  }
  const choice = decision?.decision;
  if (choice === 'accept' || choice === 'acceptForSession') {
    const result = { behavior: 'allow', updatedInput: input };
    if (choice === 'acceptForSession' && options.suggestions?.length) {
      result.updatedPermissions = options.suggestions;
    }
    return withToolUseId(result, options);
  }
  return withToolUseId({
    behavior: 'deny',
    message: '用户拒绝了此操作',
    interrupt: choice === 'cancel',
  }, options);
}

export class SdkAgentBackend extends EventEmitter {
  constructor({
    provider,
    label,
    query,
    queryOptions = () => ({}),
    listSessions,
    getSessionInfo,
    getSessionMessages,
    transcriptFile = null,
    readTranscriptRange = null,
    idleTimeoutMs = 60_000,
  }) {
    super();
    this.provider = provider;
    this.label = label;
    this.capabilities = {
      structuredTranscript: true,
      liveEvents: true,
      directTmuxInput: true,
      slashCommands: true,
      attachments: true,
    };
    this.query = query;
    this.queryOptions = queryOptions;
    this.listSessions = listSessions;
    this.getSessionInfo = getSessionInfo;
    this.getSessionMessages = getSessionMessages;
    this.transcriptFile = transcriptFile;
    this.readTranscriptRange = readTranscriptRange;
    this.idleTimeoutMs = idleTimeoutMs;
    this.runtimes = new Map();
    this.transcriptCache = new Map();
    this.transcriptLoads = new Map();
    this.approvals = new Map();
    this.approvalSequence = 0;
    this.closed = false;
  }

  async listThreads() {
    const sessions = await this.listSessions({ limit: 80 });
    const data = sessions.map((session) => sessionToThread(session));
    const byId = new Map(data.map((thread) => [thread.id, thread]));
    for (const runtime of this.runtimes.values()) {
      let thread = byId.get(runtime.threadId);
      if (!thread) {
        thread = sessionToThread({
          sessionId: runtime.threadId,
          summary: runtime.preview || '新会话',
          cwd: runtime.cwd,
          createdAt: runtime.createdAt,
          lastModified: Date.now(),
        });
        data.push(thread);
        byId.set(thread.id, thread);
      }
      thread.status = runtime.activeTurn ? { type: 'active' } : { type: 'idle' };
      thread.updatedAt = Math.round(Date.now() / 1000);
    }
    return { data };
  }

  async openThread(threadId) {
    const info = await this.getSessionInfo(threadId);
    if (!info) throw new Error(`${this.label} session not found`);
    const persistedTurns = await this.#persistedTurns(threadId, info);
    const thread = sessionToThread(info, [...persistedTurns]);
    const runtime = this.runtimes.get(threadId);
    if (runtime?.activeTurn) {
      thread.turns.push(runtime.activeTurn, ...runtime.pendingTurns);
      thread.status = { type: 'active' };
    }
    return { thread };
  }

  async newThread({ cwd, text }) {
    this.#assertOpen();
    const threadId = crypto.randomUUID();
    const runtime = this.#startRuntime({ threadId, cwd, resume: false });
    const { turn } = this.#enqueue(runtime, text, 'next');
    return {
      thread: sessionToThread({
        sessionId: threadId,
        summary: text.trim().slice(0, 120),
        cwd,
        createdAt: Date.now(),
        lastModified: Date.now(),
      }, [turn]),
      turn,
    };
  }

  async sendMessage({ threadId, mode, text }) {
    this.#assertOpen();
    let runtime = this.runtimes.get(threadId);
    if (!runtime) {
      const info = await this.getSessionInfo(threadId);
      if (!info) throw new Error(`${this.label} session not found`);
      runtime = this.#startRuntime({ threadId, cwd: info.cwd, resume: true });
    }
    return this.#enqueue(runtime, text, mode === 'steer' ? 'now' : 'next');
  }

  async interruptTurn({ threadId }) {
    const runtime = this.runtimes.get(threadId);
    if (!runtime?.query) throw new Error('No active turn to interrupt');
    await runtime.query.interrupt();
    return {};
  }

  async respond(id, result) {
    const approval = this.approvals.get(String(id));
    if (!approval) throw new Error('Approval was already resolved or expired');
    this.approvals.delete(String(id));
    approval.cleanup();
    approval.resolve(permissionResult(result, approval));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const runtime of this.runtimes.values()) {
      runtime.closing = true;
      clearTimeout(runtime.idleTimer);
      runtime.input.close();
      runtime.query?.close?.();
    }
    this.runtimes.clear();
    this.transcriptCache.clear();
    this.transcriptLoads.clear();
    for (const approval of this.approvals.values()) {
      approval.cleanup();
      approval.resolve(withToolUseId({ behavior: 'deny', message: '远程会话已关闭', interrupt: true }, approval.options));
    }
    this.approvals.clear();
  }

  // 活跃会话的 transcript 每秒都在变长, revision 必然失效, 于是整份重读:
  // 实测 3.9MB 的会话每次 ~37ms, 占 openThread 54ms 的大头。文件只会追加,
  // 所以命中过缓存之后只读新增的那段字节, 解析后接到已缓存的消息上。
  // 任何一处对不上 (路径推不出、文件缩了、某行解析失败) 都回落整份读取。
  async #appendedTranscript(threadId, info, cached) {
    if (!this.transcriptFile || !this.readTranscriptRange) return null;
    if (!Array.isArray(cached?.messages) || !Number.isFinite(cached?.size)) return null;
    const size = Number(info?.fileSize);
    if (!Number.isFinite(size) || size <= cached.size) return null;
    const file = this.transcriptFile(threadId, info);
    if (!file) return null;
    // 多读前一个字节: 全量回落时记下的 size 取自 info.fileSize, 可能正好落在一行
    // 中间 (写入方还没写完那行)。要求它是换行符, 否则宁可回落, 不冒从行中间接续
    // 却恰好解析成功的风险。
    let chunk;
    try {
      chunk = await this.readTranscriptRange(file, cached.size - 1, size);
    } catch {
      return null;
    }
    if (typeof chunk !== 'string' || chunk[0] !== '\n') return null;
    chunk = chunk.slice(1);
    if (!chunk) return null;
    // 末行可能只写了一半, 只消费到最后一个换行为止; 剩下的等下一轮连同后续一起读。
    const lastBreak = chunk.lastIndexOf('\n');
    if (lastBreak < 0) return null;
    const consumed = chunk.slice(0, lastBreak + 1);
    const appended = [];
    for (const line of consumed.split('\n')) {
      if (!line.trim()) continue;
      try {
        appended.push(JSON.parse(line));
      } catch {
        return null;
      }
    }
    const messages = [...cached.messages, ...appended];
    return {
      messages,
      turns: transcriptToTurns(messages),
      size: cached.size + Buffer.byteLength(consumed),
    };
  }

  async #persistedTurns(threadId, info) {
    const revision = transcriptRevision(info);
    const cached = revision ? this.transcriptCache.get(threadId) : null;
    if (cached?.revision === revision) {
      this.transcriptCache.delete(threadId);
      this.transcriptCache.set(threadId, cached);
      return cached.turns;
    }

    const appended = await this.#appendedTranscript(threadId, info, cached);
    if (appended) {
      this.transcriptCache.delete(threadId);
      this.transcriptCache.set(threadId, { revision, ...appended });
      while (this.transcriptCache.size > MAX_TRANSCRIPT_CACHE_ENTRIES) {
        this.transcriptCache.delete(this.transcriptCache.keys().next().value);
      }
      return appended.turns;
    }

    const loadKey = revision ? `${threadId}\0${revision}` : null;
    let load = loadKey ? this.transcriptLoads.get(loadKey) : null;
    if (!load) {
      load = Promise.resolve(this.getSessionMessages(threadId, { dir: info.cwd }))
        .then((messages) => ({ messages, turns: transcriptToTurns(messages) }));
      if (loadKey) {
        this.transcriptLoads.set(loadKey, load);
        load.finally(() => {
          if (this.transcriptLoads.get(loadKey) === load) this.transcriptLoads.delete(loadKey);
        }).catch(() => {});
      }
    }
    const { messages, turns } = await load;
    if (revision) {
      this.transcriptCache.delete(threadId);
      this.transcriptCache.set(threadId, {
        revision, turns, messages, size: Number(info?.fileSize),
      });
      while (this.transcriptCache.size > MAX_TRANSCRIPT_CACHE_ENTRIES) {
        this.transcriptCache.delete(this.transcriptCache.keys().next().value);
      }
    }
    return turns;
  }

  #assertOpen() {
    if (this.closed) throw new Error(`${this.label} backend is closed`);
  }

  #startRuntime({ threadId, cwd, resume }) {
    const input = new AsyncInputQueue();
    const runtime = {
      threadId,
      cwd,
      input,
      query: null,
      activeTurn: null,
      pendingTurns: [],
      textItem: null,
      tools: new Map(),
      closing: false,
      idleTimer: null,
      preview: '',
      createdAt: Date.now(),
    };
    const options = {
      ...this.queryOptions(),
      cwd,
      includePartialMessages: true,
      permissionMode: 'default',
      canUseTool: (toolName, toolInput, permissionOptions) => (
        this.#requestPermission(runtime, toolName, toolInput, permissionOptions)
      ),
    };
    if (resume) options.resume = threadId;
    else options.sessionId = threadId;
    runtime.query = this.query({ prompt: input, options });
    this.runtimes.set(threadId, runtime);
    this.#consume(runtime);
    return runtime;
  }

  #enqueue(runtime, text, priority) {
    const cleanText = String(text || '').trim();
    if (!cleanText) throw new Error('Message cannot be empty');
    if (!runtime.preview) runtime.preview = cleanText.slice(0, 120);
    clearTimeout(runtime.idleTimer);
    runtime.idleTimer = null;
    const queued = Boolean(runtime.activeTurn);
    const now = Date.now();
    const turn = {
      id: crypto.randomUUID(),
      status: 'inProgress',
      startedAt: Math.round(now / 1000),
      items: [],
    };
    const userItem = {
      id: crypto.randomUUID(),
      type: 'userMessage',
      content: [{ type: 'text', text: cleanText }],
    };
    turn.items.push(userItem);
    if (runtime.activeTurn) runtime.pendingTurns.push(turn);
    else runtime.activeTurn = turn;
    this.#notify('turn/started', { threadId: runtime.threadId, turn });
    this.#notify('item/started', {
      threadId: runtime.threadId, turnId: turn.id, item: userItem, startedAtMs: now,
    });
    this.#notify('item/completed', {
      threadId: runtime.threadId, turnId: turn.id, item: userItem, completedAtMs: now,
    });
    runtime.input.push({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: cleanText }] },
      parent_tool_use_id: null,
      priority,
      uuid: turn.id,
      session_id: runtime.threadId,
    });
    return { turn, queued };
  }

  async #consume(runtime) {
    try {
      for await (const message of runtime.query) this.#handleSdkMessage(runtime, message);
      if (!runtime.closing && runtime.activeTurn) {
        this.#finishTurn(runtime, { is_error: true, errors: [`${this.label} process stopped unexpectedly`] });
      }
    } catch (error) {
      if (!runtime.closing) {
        this.#notify('error', { threadId: runtime.threadId, message: error.message || String(error) });
        if (runtime.activeTurn) this.#finishTurn(runtime, { is_error: true, errors: [error.message || String(error)] });
      }
    } finally {
      if (this.runtimes.get(runtime.threadId) === runtime) this.runtimes.delete(runtime.threadId);
    }
  }

  #handleSdkMessage(runtime, message) {
    if (!message || !runtime.activeTurn) return;
    if (message.type === 'stream_event') {
      const delta = message.event?.delta;
      if (message.event?.type === 'content_block_delta' && delta?.type === 'text_delta' && delta.text) {
        this.#appendAgentText(runtime, delta.text);
      }
      return;
    }
    if (message.type === 'assistant') {
      for (const block of contentBlocks(message)) {
        if (block?.type === 'text' && block.text) {
          const current = runtime.textItem?.text || '';
          if (!current) this.#appendAgentText(runtime, block.text);
          else if (block.text.startsWith(current)) this.#appendAgentText(runtime, block.text.slice(current.length));
          else if (!current.includes(block.text)) this.#appendAgentText(runtime, `\n${block.text}`);
        } else if (block?.type === 'tool_use') {
          this.#startTool(runtime, block);
        }
      }
      return;
    }
    if (message.type === 'user') {
      for (const block of contentBlocks(message)) {
        if (block?.type === 'tool_result') this.#completeTool(runtime, block);
      }
      return;
    }
    if (message.type === 'result') {
      this.#finishTurn(runtime, message);
      return;
    }
    if (message.type === 'system' && message.subtype === 'status') {
      this.#notify('thread/status/changed', {
        threadId: runtime.threadId,
        status: { type: message.status || 'active' },
      });
    }
  }

  #appendAgentText(runtime, delta) {
    if (!delta) return;
    const turn = runtime.activeTurn;
    if (!runtime.textItem) {
      runtime.textItem = { id: crypto.randomUUID(), type: 'agentMessage', text: '' };
      turn.items.push(runtime.textItem);
      this.#notify('item/started', {
        threadId: runtime.threadId,
        turnId: turn.id,
        item: runtime.textItem,
        startedAtMs: Date.now(),
      });
    }
    runtime.textItem.text += delta;
    this.#notify('item/agentMessage/delta', {
      threadId: runtime.threadId,
      turnId: turn.id,
      itemId: runtime.textItem.id,
      delta,
    });
  }

  #startTool(runtime, block) {
    const id = block.id || crypto.randomUUID();
    if (runtime.tools.has(id)) return;
    const item = {
      id,
      type: 'mcpToolCall',
      server: this.provider,
      tool: block.name || 'Tool',
      arguments: block.input || {},
      status: 'inProgress',
    };
    runtime.tools.set(id, item);
    runtime.activeTurn.items.push(item);
    this.#notify('item/started', {
      threadId: runtime.threadId,
      turnId: runtime.activeTurn.id,
      item,
      startedAtMs: Date.now(),
    });
  }

  #completeTool(runtime, block) {
    const item = runtime.tools.get(block.tool_use_id);
    if (!item) return;
    item.status = block.is_error ? 'failed' : 'completed';
    item.result = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
    this.#notify('item/completed', {
      threadId: runtime.threadId,
      turnId: runtime.activeTurn.id,
      item,
      completedAtMs: Date.now(),
    });
    runtime.tools.delete(block.tool_use_id);
  }

  #finishTurn(runtime, result) {
    const turn = runtime.activeTurn;
    if (!turn) return;
    if (!runtime.textItem && result.result) this.#appendAgentText(runtime, result.result);
    if (runtime.textItem) {
      this.#notify('item/completed', {
        threadId: runtime.threadId,
        turnId: turn.id,
        item: runtime.textItem,
        completedAtMs: Date.now(),
      });
    }
    for (const item of runtime.tools.values()) {
      item.status = result.is_error ? 'failed' : 'completed';
      this.#notify('item/completed', {
        threadId: runtime.threadId,
        turnId: turn.id,
        item,
        completedAtMs: Date.now(),
      });
    }
    runtime.tools.clear();
    turn.status = result.is_error || result.subtype?.startsWith('error_') ? 'failed' : 'completed';
    turn.completedAt = Math.round(Date.now() / 1000);
    if (Number.isFinite(result.duration_ms)) turn.durationMs = result.duration_ms;
    if (turn.status === 'failed') turn.error = result.errors?.join('\n') || result.result || 'Agent turn failed';
    this.#notify('turn/completed', { threadId: runtime.threadId, turn });
    runtime.activeTurn = runtime.pendingTurns.shift() || null;
    runtime.textItem = null;
    if (!runtime.activeTurn) this.#scheduleIdleClose(runtime);
  }

  #scheduleIdleClose(runtime) {
    clearTimeout(runtime.idleTimer);
    runtime.idleTimer = setTimeout(() => {
      if (runtime.activeTurn || this.runtimes.get(runtime.threadId) !== runtime) return;
      runtime.closing = true;
      runtime.input.close();
      runtime.query?.close?.();
    }, this.idleTimeoutMs);
    runtime.idleTimer.unref?.();
  }

  #requestPermission(runtime, toolName, input, options = {}) {
    const id = `${this.provider}:${++this.approvalSequence}`;
    return new Promise((resolve) => {
      const onAbort = () => {
        if (!this.approvals.delete(id)) return;
        resolve(withToolUseId({ behavior: 'deny', message: '操作已取消', interrupt: true }, options));
      };
      options.signal?.addEventListener?.('abort', onAbort, { once: true });
      const cleanup = () => options.signal?.removeEventListener?.('abort', onAbort);
      const questions = toolName === 'AskUserQuestion' ? normalizedQuestions(input, this.label) : null;
      this.approvals.set(id, {
        resolve,
        cleanup,
        input,
        options,
        questions,
        kind: questions ? 'userInput' : 'approval',
      });
      this.emit('serverRequest', {
        id,
        method: questions ? 'item/tool/requestUserInput' : 'item/tool/requestApproval',
        params: questions ? {
          threadId: runtime.threadId,
          turnId: runtime.activeTurn?.id,
          itemId: options.toolUseID || crypto.randomUUID(),
          questions,
        } : {
          threadId: runtime.threadId,
          turnId: runtime.activeTurn?.id,
          itemId: options.toolUseID || crypto.randomUUID(),
          toolName,
          input,
          title: options.title || `${this.label} 请求使用 ${toolName}`,
          displayName: options.displayName || toolName,
          description: options.description || options.decisionReason || '',
          canAcceptForSession: Boolean(options.suggestions?.length),
        },
      });
    });
  }

  #notify(method, params) {
    this.emit('notification', { method, params });
  }
}

export const sdkTranscriptToTurns = transcriptToTurns;
