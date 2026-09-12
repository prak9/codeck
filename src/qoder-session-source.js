import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { setImmediate as yieldToIO } from 'node:timers/promises';
import { getSessionMessages } from '@qoder-ai/qoder-agent-sdk';
import { stripTerminalInputResidue } from '../public/terminal-input.js';

const RECEIPT_TTL_MS = 24 * 60 * 60_000;
const RECEIPT_LIMIT = 1024;
const CONFIRMATION_WAIT_MS = 30_000;
const COMPACTION_HISTORY_CACHE_LIMIT = 16;
const COMPACTION_RESTORE_STATE_LIMIT = 16;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function mergeMessages(earlier, later) {
  const seen = new Set();
  return [...earlier, ...later].filter((message) => {
    if (!message?.uuid || !seen.has(message.uuid)) {
      if (message?.uuid) seen.add(message.uuid);
      return true;
    }
    return false;
  });
}

function messageWindow(messages, { offset = 0, limit } = {}) {
  const start = Math.max(0, offset);
  return limit !== undefined && limit > 0
    ? messages.slice(start, start + limit) : start > 0 ? messages.slice(start) : messages;
}

function buildCompactContext(records) {
  const compactSummaryIds = new Set();
  const boundaryByUuid = new Map();
  const uuidToIndexes = new Map();
  for (let index = 0; index < records.length; index += 1) {
    const entry = records[index]?.entry;
    const uuid = typeof entry?.uuid === 'string' ? entry.uuid : null;
    if (!uuid) continue;
    const list = uuidToIndexes.get(uuid);
    if (list) list.push(index);
    else uuidToIndexes.set(uuid, [index]);
    if (entry?.isCompactSummary === true) compactSummaryIds.add(uuid);
    if (entry?.type === 'system' && entry?.subtype === 'compact_boundary') {
      boundaryByUuid.set(uuid, {
        index,
        logicalParentUuid: typeof entry.logicalParentUuid === 'string' ? entry.logicalParentUuid : null,
      });
    }
  }
  return { records, compactSummaryIds, boundaryByUuid, uuidToIndexes };
}

function latestIndexBefore(indexes, beforeIndex) {
  if (!Array.isArray(indexes) || !Number.isSafeInteger(beforeIndex)) return null;
  for (let i = indexes.length - 1; i >= 0; i -= 1) {
    if (indexes[i] < beforeIndex) return indexes[i];
  }
  return null;
}

function activeCompactBoundaryIds(messages, context) {
  const activeBoundaryIds = new Set();
  const boundaries = context?.boundaryByUuid || new Map();
  for (const message of Array.isArray(messages) ? messages : []) {
    const messageUuid = typeof message?.uuid === 'string' ? message.uuid : null;
    if (message?.type === 'system' && message?.subtype === 'compact_boundary'
      && messageUuid && boundaries.has(messageUuid)) {
      activeBoundaryIds.add(messageUuid);
      continue;
    }
    const indexes = context?.uuidToIndexes.get(messageUuid);
    const raw = context?.records[indexes?.at(-1)]?.entry;
    const parentBoundaryUuid = raw?.parentUuid;
    if (raw?.isCompactSummary === true
      && parentBoundaryUuid && boundaries.has(parentBoundaryUuid)) {
      activeBoundaryIds.add(parentBoundaryUuid);
    }
  }
  return activeBoundaryIds;
}

async function readInputLog(file) {
  try {
    const entries = JSON.parse(await fs.readFile(file, 'utf8'));
    return Array.isArray(entries) ? entries : null;
  } catch (error) { return error.code === 'ENOENT' ? [] : null; }
}

function userText(entry) {
  if (entry?.type !== 'user' || entry.isMeta || entry.isCompactSummary || entry.isSidechain || entry.teamName
    || entry.parent_tool_use_id || typeof entry.uuid !== 'string') return '';
  const content = entry.message?.content;
  if (typeof content === 'string') return stripTerminalInputResidue(content.trim());
  if (!Array.isArray(content) || content.some(block => block?.type === 'tool_result')) return '';
  return stripTerminalInputResidue(content.filter(block => block?.type === 'text')
    .map(block => block.text || '').join('').trim());
}

// Keep SDK branch semantics for display, extending a compacted active chain with
// the SDK-resolved snapshot that immediately preceded its new root. Delivery
// evidence instead comes from immutable source records before SDK filtering.
export class QoderSessionSource {
  constructor({ configDir = process.env.QODER_CONFIG_DIR
    || path.join(process.env.QODER_CLI_HOME || os.homedir(), process.env.QODER_CONFIG_DIR_NAME || '.qoder'), now = Date.now } = {}) {
    this.configDir = configDir;
    this.now = now;
    this.receipts = new Map();
    this.compactionHistory = new Map();
    this.compactionRestoreState = new Map();
    this.closed = false;
  }

  async #read(threadId, options, capture) {
    const {
      includeSystemMessages = false,
      limit,
      offset,
      deferCompactionRestore = false,
      ...sdkOptions
    } = options || {};
    let snapshot;
    const messages = await getSessionMessages(threadId, {
      ...sdkOptions,
      includeSystemMessages: true,
      sessionStore: {
        // Let the SDK compute projectKey, including realpath and long-path hashing.
        // The store branch propagates I/O errors instead of converting them to [].
        load: async ({ projectKey, sessionId }) => {
          if (!/^[a-zA-Z0-9-]+$/u.test(projectKey)
            || !/^[a-fA-F0-9-]{36}$/u.test(sessionId)) throw new Error('Invalid Qoder session path');
          const file = path.join(this.configDir, 'projects', projectKey, `${sessionId}.jsonl`);
          const handle = await fs.open(file, 'r');
          let bytes;
          let identity;
          try {
            const stat = await handle.stat();
            identity = `${stat.dev}:${stat.ino}`;
            bytes = await handle.readFile();
          } finally { await handle.close(); }
          const records = [];
          let offset = 0;
          for (const line of bytes.toString('utf8').split('\n')) {
            if (line.trim()) {
              try {
                const entry = JSON.parse(line);
                if (entry && typeof entry === 'object' && !Array.isArray(entry)) records.push({ offset, entry });
              }
              catch { /* A malformed or partially written line loses only itself. */ }
            }
            offset += Buffer.byteLength(line) + 1;
          }
          snapshot = { file, identity, bytes, records };
          capture?.(snapshot);
          this.#observe(threadId, snapshot);
          return records.map(record => record.entry);
        },
      },
    });
    const compactContext = snapshot ? buildCompactContext(snapshot.records || []) : null;
    const activeBoundaryIds = compactContext ? activeCompactBoundaryIds(messages, compactContext) : new Set();
    let expanded = messages;
    let historyPending = false;
    if (activeBoundaryIds.size) {
      const prefixEnd = Math.max(...[...activeBoundaryIds].map(uuid => {
        const index = compactContext.boundaryByUuid.get(uuid).index;
        return snapshot.records[index + 1]?.offset ?? snapshot.bytes.length;
      }));
      const key = JSON.stringify([snapshot.file, snapshot.identity,
        hash(snapshot.bytes.subarray(0, prefixEnd)), [...activeBoundaryIds].sort()]);
      let state = this.compactionRestoreState.get(threadId);
      if (!state || state.key !== key) {
        state = { key, ready: false, inFlight: null, restored: null };
        this.compactionRestoreState.set(threadId, state);
        this.#trimCompactionRestoreState();
      }
      if (!state.ready && !state.inFlight) {
        // Cache only the immutable historical prefix. Each reader merges its own
        // live chain; append-only output neither restarts nor becomes part of this job.
        state.inFlight = yieldToIO().then(() => this.#restoreCompactionHistory(
          threadId, sdkOptions, snapshot, [],
          compactContext, activeBoundaryIds,
        )).then((restored) => {
          state.ready = true;
          state.restored = restored;
          state.inFlight = null;
          return restored;
        }).catch((error) => {
          state.inFlight = null;
          state.ready = false;
          state.restored = null;
          throw error;
        });
      }
      if (state.ready) {
        expanded = mergeMessages(state.restored || [], messages);
      } else if (deferCompactionRestore) {
        state.inFlight?.catch(() => {});
        expanded = messages;
        historyPending = true;
      } else {
        expanded = mergeMessages(await state.inFlight, messages);
      }
    } else {
      this.compactionRestoreState.delete(threadId);
    }
    const compactSummaryIds = compactContext ? compactContext.compactSummaryIds : new Set();
    // The SDK must see the complete graph so it can resolve branches and compaction
    // boundaries, but its normalized SessionMessage drops this raw metadata.
    const normalized = expanded.map(message => compactSummaryIds.has(message.uuid)
      ? { ...message, isCompactSummary: true } : message)
      .filter(message => includeSystemMessages || message.type !== 'system');
    const result = messageWindow(normalized, { limit, offset });
    // Completeness belongs to this result, not to mutable background job state.
    // Keep the SDK-compatible array shape for existing callers and serialization.
    Object.defineProperty(result, 'historyPending', { value: historyPending });
    return result;
  }

  async #restoreCompactionHistory(threadId, sdkOptions, snapshot, messages, context, activeBoundaryIds, seen = new Set()) {
    let expanded = messages;
    if (!activeBoundaryIds?.size) return expanded;
    for (const boundaryUuid of activeBoundaryIds) {
      if (seen.has(boundaryUuid)) continue;
      const boundary = context?.boundaryByUuid?.get(boundaryUuid);
      if (!boundary) continue;
      const index = boundary.index;
      const record = index >= 0 ? snapshot.records[index] : null;
      const parentUuid = boundary.logicalParentUuid;
      const parentIndex = latestIndexBefore(context?.uuidToIndexes?.get(parentUuid), index);
      if (typeof parentUuid !== 'string'
        || !Number.isSafeInteger(parentIndex) || parentIndex >= index || index <= 0) continue;
      const key = [threadId, snapshot.identity, boundaryUuid, parentUuid, record.offset,
        hash(snapshot.bytes.subarray(0, record.offset))].join('\0');
      let history = this.compactionHistory.get(key);
      if (history) {
        this.compactionHistory.delete(key);
        if (!this.closed) this.compactionHistory.set(key, history);
      } else {
        await yieldToIO();
        const prefix = snapshot.records.slice(0, index).map(({ entry }) => entry);
        history = await getSessionMessages(threadId, {
          ...sdkOptions,
          includeSystemMessages: true,
          sessionStore: { load: async () => [...prefix, {
            type: 'active-leaf', sessionId: threadId, leafUuid: parentUuid, explicit: true,
          }] },
        });
        history = await this.#restoreCompactionHistory(
          threadId, sdkOptions, snapshot, history, context,
          activeCompactBoundaryIds(history, buildCompactContext(snapshot.records.slice(0, index))),
          new Set([...seen, boundaryUuid]),
        );
        if (!this.closed) this.compactionHistory.set(key, history);
        while (this.compactionHistory.size > COMPACTION_HISTORY_CACHE_LIMIT) {
          this.compactionHistory.delete(this.compactionHistory.keys().next().value);
        }
      }
      expanded = mergeMessages(history, expanded);
    }
    return expanded;
  }

  #trimCompactionRestoreState() {
    while (this.compactionRestoreState.size > COMPACTION_RESTORE_STATE_LIMIT) {
      this.compactionRestoreState.delete(this.compactionRestoreState.keys().next().value);
    }
  }

  getSessionMessages(threadId, options) { return this.#read(threadId, options); }

  async prepare({ threadId, cwd, text }) {
    let baseline;
    await this.#read(threadId, { dir: cwd, deferCompactionRestore: true }, ({ file, identity, bytes, records }) => {
      baseline = {
        file, identity, offset: bytes.length, hash: hash(bytes),
        seen: records.filter(({ entry }) => userText(entry) === text).map(({ entry }) => entry.uuid),
      };
    });
    if (baseline) {
      const file = path.join(this.configDir, 'tmp', path.basename(path.dirname(baseline.file)), 'logs.json');
      const entries = await readInputLog(file);
      if (entries) baseline.inputLog = {
        file, count: entries.length, hash: hash(JSON.stringify(entries)),
        lastId: entries.reduce((last, entry) => entry?.sessionId === threadId && Number.isSafeInteger(entry.messageId)
          ? Math.max(last, entry.messageId) : last, -1),
      };
    }
    return baseline;
  }

  record({ threadId, commandId, text, deliveryBaseline }) {
    if (!commandId || text.startsWith('/')) return;
    this.#prune();
    if (this.receipts.has(commandId)) return;
    while (this.receipts.size >= RECEIPT_LIMIT) this.receipts.delete(this.receipts.keys().next().value);
    this.receipts.set(commandId, {
      threadId, commandId, text, baseline: deliveryBaseline,
      createdAt: this.now(), expiresAt: this.now() + RECEIPT_TTL_MS, itemId: null,
    });
  }

  #observe(threadId, { file, identity, bytes, records }) {
    this.#prune();
    const receipts = [...this.receipts.values()].filter(receipt => receipt.threadId === threadId);
    const used = new Set(receipts.map(receipt => receipt.itemId).filter(Boolean));
    for (const receipt of receipts) {
      const base = receipt.baseline;
      if (receipt.itemId || !base || base.file !== file || base.identity !== identity
        || bytes.length < base.offset || hash(bytes.subarray(0, base.offset)) !== base.hash) continue;
      const matched = records.find(({ offset, entry }) => offset >= base.offset
        && (entry.sessionId || entry.session_id) === threadId
        && !used.has(entry.uuid) && !base.seen.includes(entry.uuid)
        && userText(entry) === receipt.text);
      if (!matched) continue;
      receipt.itemId = matched.entry.uuid;
      used.add(receipt.itemId);
      // The UUID is durable evidence for this process; do not retain the baseline.
      delete receipt.baseline;
    }
  }

  confirmations(threadId) {
    this.#prune();
    return [...this.receipts.values()].filter(receipt => receipt.threadId === threadId && receipt.itemId)
      .map(({ commandId, itemId }) => ({ commandId, itemId }));
  }

  // The CLI logs input on submission, before queueing/steering. The conversation
  // JSONL is written later (or has no separate user turn for a steering hint).
  // Poll this independently of transcript revisions; a busy turn may not change.
  async received(threadId) {
    this.#prune();
    const receipts = [...this.receipts.values()].filter(receipt => receipt.threadId === threadId);
    const files = new Set(receipts.filter(receipt => !receipt.itemId && !receipt.inputId)
      .map(receipt => receipt.baseline?.inputLog?.file).filter(Boolean));
    for (const file of files) {
      const entries = await readInputLog(file);
      if (!entries) continue; // A concurrent CLI rewrite can temporarily be incomplete.
      const used = new Set(receipts.map(receipt => receipt.inputId).filter(Boolean));
      for (const receipt of receipts) {
        const base = receipt.baseline?.inputLog;
        if (receipt.itemId || receipt.inputId || base?.file !== file
          || entries.length < base.count || hash(JSON.stringify(entries.slice(0, base.count))) !== base.hash) continue;
        const entry = entries.slice(base.count).find(entry => entry?.sessionId === threadId
          && entry.type === 'user' && Number.isSafeInteger(entry.messageId) && entry.messageId > base.lastId
          && typeof entry.timestamp === 'string' && Number.isFinite(Date.parse(entry.timestamp))
          && typeof entry.message === 'string' && stripTerminalInputResidue(entry.message.trim()) === receipt.text
          && !used.has(`${file}:${entry.messageId}`));
        if (!entry) continue;
        receipt.inputId = `${file}:${entry.messageId}`;
        used.add(receipt.inputId);
      }
    }
    return receipts.filter(receipt => receipt.inputId).map(receipt => receipt.commandId);
  }

  unconfirmed(threadId) {
    this.#prune();
    return [...this.receipts.values()].filter(receipt => receipt.threadId === threadId
      && !receipt.itemId && !receipt.inputId && this.now() - receipt.createdAt >= CONFIRMATION_WAIT_MS)
      .map(receipt => receipt.commandId);
  }

  #prune() {
    for (const [id, receipt] of this.receipts) {
      if (receipt.expiresAt <= this.now()) this.receipts.delete(id);
    }
  }

  close() {
    this.closed = true;
    this.receipts.clear();
    this.compactionHistory.clear();
    this.compactionRestoreState.clear();
  }
}
