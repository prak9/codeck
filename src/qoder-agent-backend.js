import { Worker } from 'node:worker_threads';
import { SdkAgentBackend } from './sdk-agent-backend.js';

export class QoderAgentBackend extends SdkAgentBackend {
  constructor({ configDir, readTimeoutMs = 30_000, ...options } = {}) {
    super({ ...options, provider: 'qodercli', label: 'QoderCLI',
      listSessions: params => this.read('sessions', params),
      getSessionInfo: id => this.read('info', { threadId: id }) });
    this.configDir = configDir;
    this.readTimeoutMs = readTimeoutMs;
    this.reader = null;
    this.readSequence = 0;
    this.pendingReads = new Map();
    this.openReads = new Map();
    this.latestReads = new Map();
    this.readErrors = new Map();
    this.readReceipts = new Map();
  }

  read(method, params = {}) {
    if (this.closed) return Promise.reject(new Error('QoderCLI backend is closed'));
    if (!this.reader) {
      const reader = new Worker(new URL('./qoder-read-worker.js', import.meta.url), {
        workerData: { configDir: this.configDir }, execArgv: [],
      });
      this.reader = reader;
      reader.on('message', message => {
        const pending = this.pendingReads.get(message.id);
        if (!pending) return;
        this.pendingReads.delete(message.id);
        clearTimeout(pending.timer);
        if (message.durationMs >= 1000) console.warn(`[qoder-read] ${pending.method} ${Math.round(message.durationMs)}ms`);
        if (message.error) pending.reject(new Error(message.error));
        else pending.resolve(message.result);
        if (!this.pendingReads.size) reader.unref();
      });
      reader.on('error', error => this.#stopReader(reader, error));
      reader.on('exit', code => this.#stopReader(reader, new Error(`Qoder history reader exited (${code})`)));
    }
    const reader = this.reader;
    reader.ref();
    const id = ++this.readSequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.#stopReader(reader, new Error('Qoder 历史读取超时，请重试')), this.readTimeoutMs);
      this.pendingReads.set(id, { resolve, reject, timer, method });
      try { reader.postMessage({ id, method, params }); }
      catch (error) {
        this.pendingReads.delete(id);
        clearTimeout(timer);
        if (!this.pendingReads.size) reader.unref();
        reject(error);
      }
    });
  }

  #stopReader(reader, error) {
    if (this.reader !== reader) return;
    this.reader = null;
    for (const pending of this.pendingReads.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingReads.clear();
    reader.terminate().catch(() => {});
  }

  async openThread(threadId, { turnLimit = 20 } = {}) {
    const key = `${threadId}:${turnLimit}`;
    const previousError = this.readErrors.get(key);
    if (previousError) {
      this.readErrors.delete(key);
      // A deferred failure must reach the snapshot/UI, not just a stream-error
      // callback that the browser may suppress while reconnecting.
      return this.#withRuntime(threadId, { thread: {
        ...(this.latestReads.get(key)?.thread || { id: threadId, turns: [], truncated: true }),
        historyLoading: true, historyError: `${previousError.message}；已保留最近内容，正在重试。`,
      } });
    }
    let loading = this.openReads.get(key);
    if (!loading) {
      const receipts = this.#receipts(threadId);
      loading = this.read('open', { threadId, limit: turnLimit, receipts }).then(result => {
        this.latestReads.delete(key);
        this.latestReads.set(key, result);
        if (this.latestReads.size > 16) this.latestReads.delete(this.latestReads.keys().next().value);
        return result;
      }).catch(error => {
        this.readErrors.set(key, error);
        if (this.readErrors.size > 16) this.readErrors.delete(this.readErrors.keys().next().value);
        throw error;
      }).finally(() => { if (this.openReads.get(key) === loading) this.openReads.delete(key); });
      this.openReads.set(key, loading);
    }
    let timer;
    let result;
    try {
      result = await Promise.race([loading, new Promise(resolve => {
        timer = setTimeout(() => resolve(null), 100);
      })]);
    } finally { clearTimeout(timer); }
    if (!result) {
      const cached = this.latestReads.get(key);
      result = { thread: { ...(cached?.thread || { id: threadId, turns: [], truncated: true }), historyLoading: true } };
    }
    return this.#withRuntime(threadId, result);
  }

  #withRuntime(threadId, result) {
    const thread = { ...result.thread, turns: [...result.thread.turns] };
    const runtime = this.runtimes.get(threadId);
    if (runtime?.activeTurn) {
      thread.turns.push(runtime.activeTurn, ...runtime.pendingTurns);
      thread.status = { type: 'active' };
    }
    return { thread };
  }

  #receipts(threadId) {
    for (const [id, receipt] of this.readReceipts) if (receipt.expiresAt <= Date.now()) this.readReceipts.delete(id);
    return [...this.readReceipts.values()].filter(receipt => receipt.threadId === threadId);
  }

  prepareSessionMessage(params) { return this.read('prepare', params); }
  recordSessionMessage(params) {
    if (!params.commandId || params.text?.startsWith('/') || this.readReceipts.has(params.commandId)) return;
    this.readReceipts.set(params.commandId, { ...params, expiresAt: Date.now() + 24 * 60 * 60_000 });
    if (this.readReceipts.size > 1024) this.readReceipts.delete(this.readReceipts.keys().next().value);
  }
  loadThreadHistory(threadId, options = {}) {
    return this.read('history', { ...options, threadId, receipts: this.#receipts(threadId) });
  }
  readLatestAgentOutput(threadId) { return this.read('latest', { threadId }); }

  close() {
    super.close();
    if (this.reader) this.#stopReader(this.reader, new Error('QoderCLI backend is closed'));
    this.latestReads.clear();
    this.readErrors.clear();
    this.readReceipts.clear();
  }
}
