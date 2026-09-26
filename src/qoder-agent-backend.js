import { Worker } from 'node:worker_threads';
import { SdkAgentBackend } from './sdk-agent-backend.js';

// Keep potentially multi-second parses and their oversized caches off the
// interactive lane. Two display workers bound concurrency regardless of sessions.
const LARGE_HISTORY_BYTES = 16 * 1024 * 1024;

export class QoderAgentBackend extends SdkAgentBackend {
  constructor({ configDir, readTimeoutMs = 30_000, ...options } = {}) {
    super({ ...options, provider: 'qodercli', label: 'QoderCLI',
      listSessions: params => this.read('sessions', params),
      getSessionInfo: id => this.read('info', { threadId: id }) });
    this.configDir = configDir;
    this.readTimeoutMs = readTimeoutMs;
    this.reader = null;
    this.largeReader = null;
    this.preparer = null;
    this.readSequence = 0;
    this.pendingReads = new Map();
    this.openReads = new Map();
    this.openReadReceipts = new WeakMap();
    this.latestReads = new Map();
    this.readyReads = new Set();
    this.readErrors = new Map();
    this.readReceipts = new Map();
  }

  read(method, params = {}) {
    if (this.closed) return Promise.reject(new Error('QoderCLI backend is closed'));
    if (params.threadId && ['open', 'history', 'latest', 'stats'].includes(method)) {
      // Metadata reads only bounded head/tail samples, never the full transcript.
      // Recheck size so a growing transcript can migrate out of the small lane.
      return this.#read('reader', 'info', { threadId: params.threadId }).then(info =>
        this.#read(info?.fileSize > LARGE_HISTORY_BYTES ? 'largeReader' : 'reader', method, params));
    }
    if (method === 'stats' && this.largeReader) {
      return Promise.all(['reader', 'largeReader'].map(lane => this.#read(lane, method, params)))
        .then(stats => ({ readBytes: stats.reduce((sum, value) => sum + value.readBytes, 0),
          parsedRecords: stats.reduce((sum, value) => sum + value.parsedRecords, 0),
          windowHits: stats.reduce((sum, value) => sum + value.windowHits, 0),
          windowMisses: stats.reduce((sum, value) => sum + value.windowMisses, 0),
          windowBytes: stats.reduce((sum, value) => sum + value.windowBytes, 0) }));
    }
    return this.#read(method === 'prepare' ? 'preparer' : 'reader', method, params);
  }

  #read(lane, method, params) {
    if (this.closed) return Promise.reject(new Error('QoderCLI backend is closed'));
    // Separate queues and event loops: input-log parsing must neither block the
    // service nor wait for display/history parsing. All lanes are read-only.
    if (!this[lane]) {
      const reader = new Worker(new URL('./qoder-read-worker.js', import.meta.url), {
        workerData: { configDir: this.configDir }, execArgv: [],
      });
      this[lane] = reader;
      reader.on('message', message => {
        const pending = this.pendingReads.get(message.id);
        if (!pending || pending.reader !== reader) return;
        this.pendingReads.delete(message.id);
        clearTimeout(pending.timer);
        if (message.durationMs >= 1000) console.warn(`[qoder-read] ${pending.method} ${Math.round(message.durationMs)}ms`);
        if (message.error) pending.reject(new Error(message.error));
        else pending.resolve(message.result);
        if (![...this.pendingReads.values()].some(pending => pending.reader === reader)) reader.unref();
      });
      reader.on('error', error => this.#stopReader(reader, error));
      reader.on('exit', code => this.#stopReader(reader, new Error(`Qoder history reader exited (${code})`)));
    }
    const reader = this[lane];
    reader.ref();
    const id = ++this.readSequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.#stopReader(reader, new Error(
        method === 'prepare' ? 'Qoder 发送准备超时，请重试' : 'Qoder 历史读取超时，请重试',
      )), this.readTimeoutMs);
      this.pendingReads.set(id, { resolve, reject, timer, method, reader });
      try { reader.postMessage({ id, method, params }); }
      catch (error) {
        this.pendingReads.delete(id);
        clearTimeout(timer);
        if (![...this.pendingReads.values()].some(pending => pending.reader === reader)) reader.unref();
        reject(error);
      }
    });
  }

  #stopReader(reader, error) {
    if (this.reader === reader) this.reader = null;
    else if (this.largeReader === reader) this.largeReader = null;
    else if (this.preparer === reader) this.preparer = null;
    else return;
    for (const [id, pending] of this.pendingReads) {
      if (pending.reader !== reader) continue;
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pendingReads.delete(id);
    }
    reader.terminate().catch(() => {});
  }

  async openThread(threadId, { turnLimit = 20, waitForReady = false } = {}) {
    const key = `${threadId}:${turnLimit}`;
    // A read that finished between polls must be delivered once before starting
    // another refresh; otherwise every slow poll reintroduces historyLoading.
    if (!waitForReady && this.readyReads.delete(key)) return this.#withRuntime(threadId, this.latestReads.get(key));
    const previousError = this.readErrors.get(key);
    if (waitForReady) this.readErrors.delete(key);
    if (previousError && !waitForReady) {
      this.readErrors.delete(key);
      // A deferred failure must reach the snapshot/UI, not just a stream-error
      // callback that the browser may suppress while reconnecting.
      return this.#withRuntime(threadId, { thread: {
        ...(this.latestReads.get(key)?.thread || { id: threadId, turns: [], truncated: true }),
        historyLoading: true, historyError: `${previousError.message}；已保留最近内容，正在重试。`,
      } });
    }
    let loading = this.openReads.get(key);
    if (waitForReady && loading && this.#receipts(threadId).some(receipt =>
      !this.openReadReceipts.get(loading)?.has(receipt.commandId))) {
      // A display read started before recovery registered its receipt cannot
      // prove delivery. Finish it, then share/start a read that includes it.
      await loading;
      return this.openThread(threadId, { turnLimit, waitForReady });
    }
    if (!loading) {
      const receipts = this.#receipts(threadId);
      loading = this.read('open', { threadId, limit: turnLimit, receipts }).then(result => {
        this.latestReads.delete(key);
        this.latestReads.set(key, result);
        this.readyReads.add(key);
        if (this.latestReads.size > 16) {
          const oldest = this.latestReads.keys().next().value;
          this.latestReads.delete(oldest);
          this.readyReads.delete(oldest);
        }
        return result;
      }).catch(error => {
        this.readErrors.set(key, error);
        if (this.readErrors.size > 16) this.readErrors.delete(this.readErrors.keys().next().value);
        throw error;
      }).finally(() => { if (this.openReads.get(key) === loading) this.openReads.delete(key); });
      this.openReads.set(key, loading);
      this.openReadReceipts.set(loading, new Set(receipts.map(receipt => receipt.commandId)));
    }
    // Explicit configuration recovery needs the result of this read, not the
    // display feed's consumable ready flag. The worker retains its normal timeout.
    if (waitForReady) return this.#withRuntime(threadId, await loading);
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
    } else if (this.latestReads.get(key) === result) this.readyReads.delete(key);
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

  async prepareSessionMessage(params) {
    if (this.closed) throw new Error('QoderCLI backend is closed');
    if (!params.commandId || params.text.startsWith('/')) return undefined;
    return this.read('prepare', params);
  }
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
    if (this.preparer) this.#stopReader(this.preparer, new Error('QoderCLI backend is closed'));
    if (this.reader) this.#stopReader(this.reader, new Error('QoderCLI backend is closed'));
    if (this.largeReader) this.#stopReader(this.largeReader, new Error('QoderCLI backend is closed'));
    this.latestReads.clear();
    this.readyReads.clear();
    this.readErrors.clear();
    this.readReceipts.clear();
  }
}
