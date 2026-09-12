import { parentPort, workerData } from 'node:worker_threads';
import path from 'node:path';
import { QoderSessionSource } from './qoder-session-source.js';
import { QoderSessionCatalog } from './qoder-transcript.js';
import { SdkAgentBackend } from './sdk-agent-backend.js';
import { latestAgentOutputText } from '../public/remote-copy.js';

const source = new QoderSessionSource({ configDir: workerData.configDir, sessionFile: id => catalog.files.get(id) });
const catalog = new QoderSessionCatalog(source.configDir);
const backend = new SdkAgentBackend({ provider: 'qodercli', label: 'QoderCLI', sessionSource: source,
  getSessionInfo: id => catalog.get(id), listSessions: options => catalog.list(options) });
const recorded = new Set();
let queue = Promise.resolve();

async function dispatch(method, params) {
  for (const receipt of params.receipts || []) {
    if (recorded.has(receipt.commandId)) continue;
    backend.recordSessionMessage(receipt);
    recorded.add(receipt.commandId);
    if (recorded.size > 1024) recorded.delete(recorded.values().next().value);
  }
  if (method === 'info') return catalog.get(params.threadId);
  if (method === 'sessions') return catalog.list(params);
  if (method === 'prepare') return backend.prepareSessionMessage(params);
  if (method === 'stats') return { ...source.readStats };
  const result = await backend.openThread(params.threadId, { deferCompactionRestore: method === 'open' });
  if (method === 'latest') return { text: latestAgentOutputText(result.thread.turns) };
  const turns = result.thread.turns;
  const limit = Math.max(1, Math.min(200, params.limit || 20));
  if (method === 'history') {
    if (result.thread.historyError) throw new Error(result.thread.historyError);
    const end = params.beforeTurnId ? turns.findIndex(turn => turn.id === params.beforeTurnId) : turns.length;
    if (end < 0) throw new Error('Thread history anchor is no longer present');
    const start = Math.max(0, end - limit);
    const page = turns.slice(start, end);
    return { turns: page, truncated: start > 0, oldestTurnId: page[0]?.id || null };
  }
  const kept = turns.slice(-limit);
  return { thread: { ...result.thread, turns: kept,
    truncated: Boolean(result.thread.truncated || turns.length > limit), oldestTurnId: kept[0]?.id || null } };
}

// One reader owns file snapshots; concurrent revisions do not multiply 115 MB
// parses. Send/stop and terminal streaming remain on the parent event loop.
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
