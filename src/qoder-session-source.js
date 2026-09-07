import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { getSessionMessages } from '@qoder-ai/qoder-agent-sdk';
import { stripTerminalInputResidue } from '../public/terminal-input.js';

const RECEIPT_TTL_MS = 24 * 60 * 60_000;
const RECEIPT_LIMIT = 1024;
const CONFIRMATION_WAIT_MS = 30_000;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function userText(entry) {
  if (entry?.type !== 'user' || entry.isMeta || entry.isSidechain || entry.teamName
    || entry.parent_tool_use_id || typeof entry.uuid !== 'string') return '';
  const content = entry.message?.content;
  if (typeof content === 'string') return stripTerminalInputResidue(content.trim());
  if (!Array.isArray(content) || content.some(block => block?.type === 'tool_result')) return '';
  return stripTerminalInputResidue(content.filter(block => block?.type === 'text')
    .map(block => block.text || '').join('').trim());
}

// Keep SDK branch/compaction semantics for display. Delivery evidence instead
// comes from the immutable prefix + appended user records, before SDK filtering.
export class QoderSessionSource {
  constructor({ configDir = process.env.QODER_CONFIG_DIR
    || path.join(process.env.QODER_CLI_HOME || os.homedir(), process.env.QODER_CONFIG_DIR_NAME || '.qoder'), now = Date.now } = {}) {
    this.configDir = configDir;
    this.now = now;
    this.receipts = new Map();
  }

  async #read(threadId, options, capture) {
    return getSessionMessages(threadId, {
      ...options,
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
          const snapshot = { file, identity, bytes, records };
          capture?.(snapshot);
          this.#observe(threadId, snapshot);
          return records.map(record => record.entry);
        },
      },
    });
  }

  getSessionMessages(threadId, options) { return this.#read(threadId, options); }

  async prepare({ threadId, cwd, text }) {
    let baseline;
    await this.#read(threadId, { dir: cwd }, ({ file, identity, bytes, records }) => {
      baseline = {
        file, identity, offset: bytes.length, hash: hash(bytes),
        seen: records.filter(({ entry }) => userText(entry) === text).map(({ entry }) => entry.uuid),
      };
    });
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

  unconfirmed(threadId) {
    this.#prune();
    return [...this.receipts.values()].filter(receipt => receipt.threadId === threadId
      && !receipt.itemId && this.now() - receipt.createdAt >= CONFIRMATION_WAIT_MS)
      .map(receipt => receipt.commandId);
  }

  #prune() {
    for (const [id, receipt] of this.receipts) {
      if (receipt.expiresAt <= this.now()) this.receipts.delete(id);
    }
  }

  close() { this.receipts.clear(); }
}
