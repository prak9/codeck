import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
const MAX_LINE = 16 * 1024 * 1024;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function message(entry, provider) {
  const value = provider === 'codex' && entry.type === 'response_item' ? entry.payload : provider !== 'codex' ? entry.message : null;
  if (!value || !['user', 'assistant'].includes(value.role) || entry.isSidechain || entry.isMeta || entry.isCompactSummary) return null;
  const content = value.content;
  if (Array.isArray(content) && content.some(b => b?.type === 'tool_result')) return null;
  const text = typeof content === 'string' ? content : Array.isArray(content)
    ? content.filter(b => ['text', 'input_text', 'output_text'].includes(b?.type) && typeof b.text === 'string').map(b => b.text).join('\n') : '';
  return text.trim() ? { role: value.role, text } : null;
}
async function filesIn(directory) {
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const files = [];
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const file = path.join(directory, e.name);
    if (e.isDirectory()) files.push(...await filesIn(file));
    else if (e.isFile() && e.name.endsWith('.jsonl')) files.push(file);
  }
  return files;
}
async function boundary(handle, offset) {
  const bytes = Buffer.alloc(Math.min(128, offset));
  await handle.read(bytes, 0, bytes.length, offset - bytes.length);
  return hash(bytes);
}
export class HistoryIndex {
  constructor(file) {
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
      CREATE TABLE IF NOT EXISTS files(file TEXT PRIMARY KEY, provider TEXT, ino TEXT, size INTEGER, mtime REAL, offset INTEGER, boundary TEXT, threadId TEXT, cwd TEXT, skipped INTEGER);
      CREATE VIRTUAL TABLE IF NOT EXISTS messages USING fts5(docId UNINDEXED, file UNINDEXED, provider UNINDEXED, threadId UNINDEXED, cwd UNINDEXED, role UNINDEXED, at UNINDEXED, offset UNINDEXED, text, tokenize='trigram');
      CREATE TABLE IF NOT EXISTS commits(provider TEXT, threadId TEXT, repo TEXT, sha TEXT, subject TEXT, linkedAt TEXT, PRIMARY KEY(provider,threadId,repo,sha));`);
    this.status = { indexing: false, scanned: 0, total: 0, error: null, updatedAt: null };
  }
  close() { this.db.close(); }
  async refresh(roots) {
    this.status = { ...this.status, indexing: true, scanned: 0, total: 0, error: null };
    try {
      const files = [];
      for (const root of roots) for (const file of await filesIn(root.directory)) files.push({ file, provider: root.provider });
      this.status.total = files.length;
      for (const item of files) { await this.indexFile(item); this.status.scanned++; }
      const present = new Set(files.map(f => f.file));
      for (const row of this.db.prepare('SELECT file FROM files').all()) if (!present.has(row.file)) {
        this.db.prepare('DELETE FROM messages WHERE file=?').run(row.file);
        this.db.prepare('DELETE FROM files WHERE file=?').run(row.file);
      }
      this.status.updatedAt = new Date().toISOString();
    } catch (e) { this.status.error = e.message; throw e; }
    finally { this.status.indexing = false; }
  }
  async indexFile({ file, provider }) {
    let handle;
    try { handle = await fs.open(file, 'r'); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
    try {
      const stat = await handle.stat(), old = this.db.prepare('SELECT * FROM files WHERE file=?').get(file);
      if (old && old.ino === String(stat.ino) && old.size === stat.size && old.mtime === stat.mtimeMs) return;
      const append = old && old.ino === String(stat.ino) && stat.size > old.size && old.boundary === await boundary(handle, old.offset);
      let offset = append ? old.offset : 0, readAt = offset, parts = [], pendingBytes = 0, oversized = false;
      let threadId = append ? old.threadId : path.basename(file, '.jsonl'), cwd = append ? old.cwd : '', skipped = append ? old.skipped : 0;
      {
        if (!append) this.db.prepare('DELETE FROM messages WHERE file=?').run(file);
        else this.db.prepare('DELETE FROM messages WHERE file=? AND offset >= ?').run(file, offset);
        const insert = this.db.prepare('INSERT INTO messages(docId,file,provider,threadId,cwd,role,at,offset,text) VALUES(?,?,?,?,?,?,?,?,?)');
        const processLine = (bytes, position) => {
          let entry; try { entry = JSON.parse(bytes.toString('utf8')); } catch { skipped++; return; }
          if (!entry || typeof entry !== 'object') { skipped++; return; }
          const meta = provider === 'codex' ? entry.type === 'session_meta' ? entry.payload : null : entry;
          const id = provider === 'codex' ? meta?.id : meta?.sessionId;
          if (typeof id === 'string' && id.length <= 256) threadId = id;
          if (typeof meta?.cwd === 'string' && meta.cwd.length <= 4096) cwd = meta.cwd;
          const value = message(entry, provider); if (!value) return;
          for (let start = 0; start < value.text.length;) {
            let end = Math.min(start + 4000, value.text.length);
            if (end < value.text.length && /[\uD800-\uDBFF]/.test(value.text[end - 1])) end--;
            insert.run(hash(JSON.stringify([file, provider, position, start, value.text.slice(start, end)])), file, provider, threadId, cwd, value.role, String(entry.timestamp || ''), position, value.text.slice(start, end));
            if (end === value.text.length) break;
            start = end - 200;
          }
        };
        while (readAt < stat.size) {
          const buffer = Buffer.alloc(Math.min(64 * 1024, stat.size - readAt));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, readAt);
          if (!bytesRead) break;
          let start = 0;
          this.db.exec('BEGIN');
          try {
          for (let i = 0; i < bytesRead; i++) if (buffer[i] === 10) {
            const part = buffer.subarray(start, i);
            if (!oversized && pendingBytes + part.length <= MAX_LINE) processLine(Buffer.concat([...parts, part]), offset);
            else skipped++;
            offset = readAt + i + 1; parts = []; pendingBytes = 0; oversized = false; start = i + 1;
          }
          this.db.exec('COMMIT');
          } catch (e) { this.db.exec('ROLLBACK'); throw e; }
          if (!oversized) {
            const rest = buffer.subarray(start, bytesRead);
            if (pendingBytes + rest.length > MAX_LINE) { parts = []; pendingBytes = 0; oversized = true; }
            else if (rest.length) { parts.push(rest); pendingBytes += rest.length; }
          }
          readAt += bytesRead;
        }
        this.db.prepare('INSERT OR REPLACE INTO files VALUES(?,?,?,?,?,?,?,?,?,?)').run(file, provider, String(stat.ino), stat.size, stat.mtimeMs, offset, await boundary(handle, offset), threadId, cwd, skipped);
      }
    } finally { await handle.close(); }
  }
  search(query, { provider = '', limit = 30 } = {}) {
    const q = String(query || '').trim();
    if (!q || q.length > 200) throw new Error('搜索词需要1–200字');
    if (provider && !['codex', 'claude', 'qodercli'].includes(provider)) throw new Error('未知 provider');
    const trigram = [...q].length >= 3;
    const where = trigram ? 'messages MATCH ?' : 'instr(lower(text),lower(?)) > 0';
    const values = [trigram ? `text : "${q.replaceAll('"', '""')}"` : q];
    if (provider) values.push(provider);
    const rows = this.db.prepare(`SELECT docId AS id,provider,threadId,cwd,role,at,offset,text FROM messages WHERE ${where}${provider ? ' AND provider=?' : ''} GROUP BY file,offset ORDER BY at DESC,rowid DESC LIMIT ?`).all(...values, Math.min(100, Math.max(1, Number(limit) || 30)));
    return { results: rows.map(row => {
      const position = Math.max(0, row.text.toLowerCase().indexOf(q.toLowerCase()));
      return { ...row, text: undefined, excerpt: row.text.slice(Math.max(0, position - 100), position + q.length + 200) };
    }), status: { ...this.status, skipped: this.db.prepare('SELECT coalesce(sum(skipped),0) AS n FROM files').get().n } };
  }
  context(id) {
    const row = this.db.prepare('SELECT rowid AS position,* FROM messages WHERE docId=?').get(String(id));
    if (!row) throw new Error('记录不存在或索引已更新，请重新搜索');
    const previous = this.db.prepare('SELECT docId AS id,role,at,text,offset FROM messages WHERE file=? AND rowid < ? ORDER BY rowid DESC LIMIT 3').all(row.file, row.position).reverse();
    const following = this.db.prepare('SELECT docId AS id,role,at,text,offset FROM messages WHERE file=? AND rowid >= ? ORDER BY rowid LIMIT 4').all(row.file, row.position);
    return { provider: row.provider, threadId: row.threadId, cwd: row.cwd, id: row.docId, messages: [...previous, ...following], mentions: [...new Set([...previous, ...following].flatMap(m => m.text.match(/\b[0-9a-f]{7,40}\b/gi) || []))].slice(0, 20), commits: this.db.prepare('SELECT repo,sha,subject,linkedAt FROM commits WHERE provider=? AND threadId=?').all(row.provider, row.threadId) };
  }
  link(value) {
    this.db.prepare('INSERT OR REPLACE INTO commits VALUES(?,?,?,?,?,?)').run(value.provider, value.threadId, value.repo, value.sha, value.subject, new Date().toISOString());
    return value;
  }
}
