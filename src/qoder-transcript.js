import fs from 'node:fs/promises';
import path from 'node:path';
import { getSessionInfo } from '@qoder-ai/qoder-agent-sdk';

const SAMPLE_BYTES = 4096;
const CACHE_BYTES = 160 * 1024 * 1024;

async function range(handle, start, length) {
  const buffer = Buffer.alloc(length);
  let total = 0;
  while (total < length) {
    const { bytesRead } = await handle.read(buffer, total, length - total, start + total);
    if (!bytesRead) break;
    total += bytesRead;
  }
  return buffer.subarray(0, total);
}

export class QoderTranscriptCache {
  constructor() {
    this.entries = new Map();
    this.loads = new Map();
    this.stats = { readBytes: 0, parsedRecords: 0 };
  }

  load(file, { fresh = false } = {}) {
    if (!fresh && this.loads.has(file)) return this.loads.get(file);
    const pending = this.#load(file, fresh).finally(() => {
      if (this.loads.get(file) === pending) this.loads.delete(file);
    });
    this.loads.set(file, pending);
    return pending;
  }

  async #load(file, fresh) {
    const handle = await fs.open(file, 'r');
    try {
      const stat = await handle.stat();
      const identity = `${stat.dev}:${stat.ino}`;
      let previous = this.entries.get(file);
      if (previous?.identity !== identity || stat.size < previous.bytes.length) previous = null;
      if (!fresh && previous && stat.size === previous.bytes.length && stat.mtimeMs === previous.mtimeMs
        && stat.ctimeMs === previous.ctimeMs) return previous;
      if (!fresh && previous && stat.size === previous.bytes.length) previous = null;
      let verified;
      if (fresh) {
        verified = await range(handle, 0, stat.size);
        this.stats.readBytes += verified.length;
        if (previous && !verified.subarray(0, previous.bytes.length).equals(previous.bytes)) previous = null;
      }
      if (previous && !fresh) {
        // Qoder appends its transcript. Check both ends before reusing its prefix;
        // delivery evidence requests always read fresh, independently of this cache.
        const size = previous.bytes.length;
        const length = Math.min(SAMPLE_BYTES, size);
        const head = await range(handle, 0, length);
        const tail = await range(handle, size - length, length);
        this.stats.readBytes += head.length + tail.length;
        if (!head.equals(previous.bytes.subarray(0, length))
          || !tail.equals(previous.bytes.subarray(size - length))) previous = null;
      }
      const start = previous?.bytes.length || 0;
      const added = verified ? verified.subarray(start) : await range(handle, start, stat.size - start);
      if (!verified) this.stats.readBytes += added.length;
      const bytes = verified || (previous ? Buffer.concat([previous.bytes, added]) : added);
      const records = previous ? [...previous.records] : [];
      if (previous?.finalRecord) records.pop();
      let offset = previous?.parsedUntil || 0;
      const text = bytes.subarray(offset).toString('utf8');
      const lines = text.split('\n');
      let finalRecord = false;
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const final = index === lines.length - 1;
        if (line.trim()) {
          try {
            const entry = JSON.parse(line);
            if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
              records.push({ offset, entry });
              if (final) finalRecord = true;
              this.stats.parsedRecords += 1;
            }
          } catch { /* A malformed completed line loses only itself. */ }
        }
        if (!final) offset += Buffer.byteLength(line) + 1;
      }
      const snapshot = { file, identity, bytes, records, parsedUntil: offset, finalRecord,
        mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
      this.entries.delete(file);
      this.entries.set(file, snapshot);
      let retained = [...this.entries.values()].reduce((sum, item) => sum + item.bytes.length, 0);
      while (this.entries.size > 1 && (retained > CACHE_BYTES || this.entries.size > 3)) {
        const first = this.entries.keys().next().value;
        retained -= this.entries.get(first).bytes.length;
        this.entries.delete(first);
      }
      return snapshot;
    } finally { await handle.close(); }
  }

  clear() { this.entries.clear(); }
}

// Discover only file names and stat the exact UUID. Never parse every session in
// the project library just to open one already-identified tmux conversation.
export class QoderSessionCatalog {
  constructor(configDir) {
    this.root = path.join(configDir, 'projects');
    this.files = new Map();
    this.info = new Map();
  }

  async get(threadId) {
    if (!/^[a-fA-F0-9-]{36}$/u.test(threadId)) return undefined;
    let file = this.files.get(threadId);
    if (file) {
      try { return await this.#info(file, threadId); }
      catch (error) { if (error.code !== 'ENOENT') throw error; this.files.delete(threadId); }
    }
    let directories;
    try { directories = await fs.readdir(this.root, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
    for (const directory of directories) {
      if (!directory.isDirectory() && !directory.isSymbolicLink()) continue;
      file = path.join(this.root, directory.name, `${threadId}.jsonl`);
      try {
        const info = await this.#info(file, threadId);
        this.files.set(threadId, file);
        if (this.files.size > 128) this.files.delete(this.files.keys().next().value);
        return info;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }

  async list({ limit = 80 } = {}) {
    let directories;
    try { directories = await fs.readdir(this.root, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const candidates = [];
    for (const directory of directories) {
      if (!directory.isDirectory() && !directory.isSymbolicLink()) continue;
      const folder = path.join(this.root, directory.name);
      for (const name of await fs.readdir(folder)) {
        if (!/^[a-fA-F0-9-]{36}\.jsonl$/u.test(name)) continue;
        const file = path.join(folder, name);
        try { candidates.push({ file, id: name.slice(0, -6), stat: await fs.stat(file) }); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
    candidates.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    const result = [];
    for (const { file, id } of candidates.slice(0, limit)) result.push(await this.#info(file, id));
    return result;
  }

  async #info(file, threadId) {
    const handle = await fs.open(file, 'r');
    try {
      const stat = await handle.stat();
      const revision = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
      const cached = this.info.get(file);
      if (cached?.revision === revision) return cached.value;
      const length = Math.min(stat.size, 64 * 1024);
      const head = await range(handle, 0, length);
      const tail = stat.size > length ? await range(handle, stat.size - length, length) : null;
      const lines = head.toString('utf8').split('\n');
      if (tail) { lines.pop(); lines.push(...tail.toString('utf8').split('\n').slice(1)); }
      const records = lines.flatMap(line => {
        try { const entry = JSON.parse(line); return entry && typeof entry === 'object' ? [entry] : []; }
        catch { return []; }
      });
      const parsed = await getSessionInfo(threadId, { sessionStore: { load: async () => records } });
      const cwd = parsed?.cwd || records.flatMap(entry => entry.directories || []).find(value => typeof value === 'string');
      // Path identity was proven by its UUID. Missing metadata must not bind a
      // different session or silently invent a cwd.
      const value = { ...cached?.value, ...parsed, sessionId: threadId,
        ...(cwd ? { cwd } : {}), summary: parsed?.summary || cached?.value?.summary || threadId,
        fileSize: stat.size, lastModified: Math.max(stat.mtimeMs, stat.ctimeMs) };
      this.files.set(threadId, file);
      if (this.files.size > 128) this.files.delete(this.files.keys().next().value);
      this.info.delete(file);
      this.info.set(file, { revision, value });
      if (this.info.size > 128) this.info.delete(this.info.keys().next().value);
      return value;
    } finally { await handle.close(); }
  }
}
