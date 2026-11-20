import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import path from 'node:path';

const conversationId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;

// AGY's steps table stores protobuf messages. Read only the length-delimited
// fields for user input and visible assistant text, skipping metadata and tools.
function bytesField(bytes, wanted) {
  let offset = 0;
  function varint() {
    let value = 0;
    for (let shift = 0; shift < 70 && offset < bytes.length; shift += 7) {
      const byte = bytes[offset++];
      value += (byte & 127) * 2 ** shift;
      if (byte < 128) return value;
    }
    throw new Error('AGY 历史记录的整数编码无效');
  }
  while (offset < bytes.length) {
    const tag = varint();
    const wire = tag % 8;
    if (wire === 0) varint();
    else if (wire === 2) {
      const length = varint();
      const start = offset;
      offset += length;
      if (offset > bytes.length) throw new Error('AGY 历史字段超出记录范围');
      if (Math.floor(tag / 8) === wanted) return bytes.subarray(start, offset);
    } else if (wire === 1 || wire === 5) offset += wire === 1 ? 8 : 4;
    else throw new Error('AGY 历史字段格式不受支持');
  }
  return null;
}

export class AgyAgentBackend extends EventEmitter {
  label = 'Antigravity';
  capabilities = { structuredTranscript: true, directTmuxInput: true, liveEvents: false,
    turnImages: false, slashCommands: false, attachments: false };

  constructor(directory = path.join(homedir(), '.gemini/antigravity-cli/conversations')) {
    super();
    this.directory = directory;
  }

  close() { this.removeAllListeners(); }

  listThreads() { return { data: [] }; } // The registry lists attached tmux sessions.

  loadThreadHistory(id, { beforeTurnId, limit = 80 } = {}) {
    if (!conversationId.test(id)) throw new Error('AGY 对话 ID 无效');
    const before = beforeTurnId == null ? Number.MAX_SAFE_INTEGER : Number(beforeTurnId);
    if (!Number.isSafeInteger(before) || before < 0) throw new Error('AGY 历史位置无效');
    const db = new DatabaseSync(path.join(this.directory, id + '.db'), { readOnly: true });
    try {
      db.exec('BEGIN');
      const anchors = db.prepare('SELECT idx FROM steps WHERE step_type = 14 AND idx < ? ORDER BY idx DESC LIMIT ?').all(before, limit + 1);
      const turns = [];
      if (anchors.length) {
        const first = anchors[Math.min(limit, anchors.length) - 1].idx;
        const rows = db.prepare('SELECT idx, step_type, step_format, step_payload FROM steps WHERE idx >= ? AND idx < ? AND step_type IN (14,15) ORDER BY idx');
        for (const row of rows.iterate(first, before)) {
          if (row.step_format !== 0) throw new Error('AGY 对话记录版本不受支持');
          const user = row.step_type === 14;
          const payload = bytesField(row.step_payload, user ? 19 : 20);
          const body = payload && bytesField(payload, user ? 2 : 1);
          const text = body && Buffer.from(body).toString('utf8');
          if (user) turns.push({ id: String(row.idx), items: [] });
          if (!text) continue;
          const itemId = 'agy-step-' + row.idx;
          turns.at(-1).items.push(user
            ? { id: itemId, type: 'userMessage', content: [{ type: 'text', text }] }
            : { id: itemId, type: 'agentMessage', text });
        }
      }
      return { turns, truncated: anchors.length > limit, oldestTurnId: turns[0]?.id || null };
    } finally { db.close(); }
  }

  openThread(id, { turnLimit = 80 } = {}) {
    if (/^tmux:agy:[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/u.test(id)) {
      return { thread: { id, turns: [], readOnly: true } };
    }
    return { thread: { id, ...this.loadThreadHistory(id, { limit: turnLimit }), readOnly: true } };
  }
}
