import { parentPort, workerData } from 'node:worker_threads';
import path from 'node:path';
import { HistoryIndex } from './history-index.js';
const index = new HistoryIndex(path.join(workerData.directory, 'history.sqlite'));
let indexing = null, lastRefresh = 0;
function refresh() {
  if (!indexing && Date.now() - lastRefresh >= 15_000) {
    indexing = index.refresh(workerData.roots).catch(() => {}).finally(() => { indexing = null; lastRefresh = Date.now(); });
  }
}
parentPort.on('message', ({ id, method, params }) => {
  try {
    if (method === 'search') refresh();
    const result = method === 'search' ? index.search(params.query, params.options)
      : method === 'context' ? index.context(params.id)
        : method === 'link' ? index.link(params) : (() => { throw new Error('未知索引操作'); })();
    parentPort.postMessage({ id, result });
  } catch (e) { parentPort.postMessage({ id, error: e.message }); }
});
