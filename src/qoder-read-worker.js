import { parentPort, workerData } from 'node:worker_threads';
import path from 'node:path';
import { QoderSessionSource } from './qoder-session-source.js';
import { QoderSessionCatalog } from './qoder-transcript.js';
import { SdkAgentBackend } from './sdk-agent-backend.js';
import { latestAgentOutputText } from '../public/remote-copy.js';
import { QoderHistoryWindowCache } from './qoder-history-window.js';

const source = new QoderSessionSource({ configDir: workerData.configDir, sessionFile: id => catalog.files.get(id) });
const catalog = new QoderSessionCatalog(source.configDir);
const backend = new SdkAgentBackend({ provider: 'qodercli', label: 'QoderCLI', sessionSource: source,
  getSessionInfo: id => catalog.get(id), listSessions: options => catalog.list(options) });
const recorded = new Set();
const windows = new QoderHistoryWindowCache();
let queue = Promise.resolve();

async function dispatch(method, params) {
  for (const receipt of params.receipts || []) {
    if (recorded.has(receipt.commandId)) continue;
    backend.recordSessionMessage(receipt);
    // A newly registered receipt must observe the transcript even at the same
    // revision; it may already contain input read before the send RPC returned.
    windows.delete(receipt.threadId);
    recorded.add(receipt.commandId);
    if (recorded.size > 1024) recorded.delete(recorded.values().next().value);
  }
  if (method === 'info') return catalog.get(params.threadId);
  if (method === 'sessions') return catalog.list(params);
  if (method === 'prepare') return backend.prepareSessionMessage(params);
  if (method === 'stats') return { ...source.readStats,
    windowHits: windows.hits, windowMisses: windows.misses, windowBytes: windows.bytes };
  const limit = Math.max(1, Math.min(200, params.limit || 20));
  const info = method === 'open' ? await catalog.get(params.threadId) : null;
  const revision = info?.transcriptRevision;
  const cached = revision ? windows.get(params.threadId, revision, limit) : null;
  if (cached) {
    // Input logs can advance without a transcript revision. Always refresh
    // delivery state and its timeouts. Runtime is merged by the parent.
    cached.thread.receivedDeliveryIds = await source.received(params.threadId);
    cached.thread.deliveryConfirmations = source.confirmations(params.threadId);
    cached.thread.unconfirmedDeliveryIds = source.unconfirmed(params.threadId);
    return cached;
  }
  const result = await backend.openThread(params.threadId, { deferCompactionRestore: method === 'open' });
  if (method === 'latest') return { text: latestAgentOutputText(result.thread.turns) };
  const turns = result.thread.turns;
  if (method === 'history') {
    if (result.thread.historyError) throw new Error(result.thread.historyError);
    const end = params.beforeTurnId ? turns.findIndex(turn => turn.id === params.beforeTurnId) : turns.length;
    if (end < 0) throw new Error('Thread history anchor is no longer present');
    const start = Math.max(0, end - limit);
    const page = turns.slice(start, end);
    return { turns: page, truncated: start > 0, oldestTurnId: page[0]?.id || null };
  }
  const kept = turns.slice(-limit);
  const window = { thread: { ...result.thread, turns: kept,
    truncated: Boolean(result.thread.truncated || turns.length > limit), oldestTurnId: kept[0]?.id || null } };
  // The backend caches only complete restorations. Do not freeze a partial/error
  // result or associate a concurrently changing file with an older revision.
  if (!result.thread.historyError && revision
    && backend.transcriptCache.get(params.threadId)?.revision === revision
    && (await catalog.get(params.threadId))?.transcriptRevision === revision) {
    windows.set(params.threadId, revision, limit, window);
  }
  return window;
}

// Each lane owns its snapshots and serializes revisions. The parent isolates
// large histories and input preparation from small histories/metadata, so neither
// expensive parse blocks the interactive lane or the service event loop.
parentPort.on('message', ({ id, method, params }) => {
  queue = queue.then(async () => {
    const started = performance.now();
    try { parentPort.postMessage({ id, result: await dispatch(method, params), durationMs: performance.now() - started }); }
    catch (error) { parentPort.postMessage({ id, error: error.message, durationMs: performance.now() - started }); }
    finally {
      // The generic SDK backend retains many normalized threads. Here those can
      // each contain 115 MB, so let the bounded raw-file cache own their lifetime.
      const retained = new Set([...source.transcripts.entries.keys()].map(file => path.basename(file, '.jsonl')));
      for (const id of backend.transcriptCache.keys()) if (!retained.has(id)) backend.transcriptCache.delete(id);
      for (const id of source.compactionRestoreState.keys()) if (!retained.has(id)) source.compactionRestoreState.delete(id);
      for (const key of source.compactionHistory.keys()) if (!retained.has(key.split('\0')[0])) source.compactionHistory.delete(key);
    }
  });
});
