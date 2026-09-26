import { serialize, deserialize } from 'node:v8';

// Keep only detached live windows, not references into full SDK/JSON graphs.
// Encoded bytes give the cache an actual size limit (in addition to entry count).
// Reject oversized windows before serialization to avoid another huge copy.
function fitsWindow(value, budget) {
  const pending = [value];
  const seen = new Set();
  while (pending.length && budget >= 0) {
    const item = pending.pop();
    if (typeof item === 'string') budget -= item.length * 2 + 16;
    else if (item && typeof item === 'object' && !seen.has(item)) {
      seen.add(item);
      budget -= 32;
      for (const key of Object.keys(item)) {
        budget -= key.length * 2 + 16;
        if (budget < 0) return false;
        pending.push(item[key]);
      }
    } else budget -= 16;
  }
  return budget >= 0;
}

export class QoderHistoryWindowCache {
  constructor({ maxBytes = 32 * 1024 * 1024, maxEntries = 16 } = {}) {
    this.maxBytes = maxBytes;
    this.maxEntries = maxEntries;
    this.entries = new Map();
    this.bytes = 0;
    this.hits = 0;
    this.misses = 0;
  }

  get(threadId, revision, limit) {
    const entry = this.entries.get(threadId);
    if (!entry || entry.revision !== revision || entry.limit !== limit) {
      this.misses += 1;
      return null;
    }
    this.entries.delete(threadId);
    this.entries.set(threadId, entry);
    this.hits += 1;
    return deserialize(entry.data);
  }

  delete(threadId) {
    const entry = this.entries.get(threadId);
    if (entry) this.bytes -= entry.data.length;
    this.entries.delete(threadId);
  }

  set(threadId, revision, limit, result) {
    this.delete(threadId);
    if (!revision || !fitsWindow(result, this.maxBytes)) return;
    const data = serialize(result);
    if (data.length > this.maxBytes) return;
    this.entries.set(threadId, { revision, limit, data });
    this.bytes += data.length;
    while (this.bytes > this.maxBytes || this.entries.size > this.maxEntries) {
      this.delete(this.entries.keys().next().value);
    }
  }
}
