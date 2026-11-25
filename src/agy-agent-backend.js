import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import path from 'node:path';

const conversationId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;

// Read a single protobuf field from AGY's stored step, skipping unrelated fields.
function stepField(bytes, wanted, wireType = 2) {
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
    if (wire === 0) {
      const value = varint();
      if (wireType === 0 && Math.floor(tag / 8) === wanted) return value;
    }
    else if (wire === 2) {
      const length = varint();
      const start = offset;
      offset += length;
      if (offset > bytes.length) throw new Error('AGY 历史字段超出记录范围');
      if (wireType === 2 && Math.floor(tag / 8) === wanted) return bytes.subarray(start, offset);
    } else if (wire === 1 || wire === 5) offset += wire === 1 ? 8 : 4;
    else throw new Error('AGY 历史字段格式不受支持');
  }
  return null;
}

export class AgyAgentBackend extends EventEmitter {
  label = 'Antigravity';
  capabilities = { structuredTranscript: true, directTmuxInput: true, liveEvents: false,
    turnImages: false, slashCommands: true, attachments: false };

  constructor(directory = path.join(homedir(), '.gemini/antigravity-cli/conversations')) {
    super();
    this.directory = directory;
  }

  close() { this.removeAllListeners(); }

  listThreads() { return { data: [] }; } // The registry lists attached tmux sessions.

  loadThreadHistory(id, { beforeTurnId, limit = 80 } = {}) {
    if (!conversationId.test(id)) throw new Error('AGY 对话 ID 无效');
    const before = beforeTurnId == null || beforeTurnId === '' ? Number.MAX_SAFE_INTEGER : Number(beforeTurnId);
    if (!Number.isSafeInteger(before) || before < 0) throw new Error('AGY 历史位置无效');
    const db = new DatabaseSync(path.join(this.directory, id + '.db'), { readOnly: true });
    try {
      db.exec('BEGIN');
      const anchors = db.prepare('SELECT idx FROM steps WHERE step_type = 14 AND idx < ? ORDER BY idx DESC LIMIT ?').all(before, limit + 1);
      const turns = [];
      if (anchors.length) {
        const first = anchors[Math.min(limit, anchors.length) - 1].idx;
        const rows = db.prepare('SELECT idx, step_type, step_format, step_payload FROM steps WHERE idx >= ? AND idx < ? AND step_type IN (14,15,17) ORDER BY idx');
        for (const row of rows.iterate(first, before)) {
          if (row.step_format !== 0) throw new Error('AGY 对话记录版本不受支持');
          const itemId = 'agy-step-' + row.idx;
          if (row.step_type === 17) {
            const errorMessage = stepField(row.step_payload, 24);
            if (!errorMessage || !stepField(errorMessage, 5, 0)) continue;
            // Only user_error_message is public. Other fields can contain raw requests and internal diagnostics.
            const details = stepField(errorMessage, 3);
            const message = details && stepField(details, 1);
            const text = message && Buffer.from(message).toString('utf8').trim();
            turns.at(-1).items.push({ id: itemId, type: 'agentError', text: text || 'AGY 执行出错，未提供详细说明。' });
            continue;
          }
          const user = row.step_type === 14;
          const payload = stepField(row.step_payload, user ? 19 : 20);
          const body = payload && stepField(payload, user ? 2 : 1);
          const text = body && Buffer.from(body).toString('utf8');
          if (user) turns.push({ id: String(row.idx), items: [] });
          if (!text) continue;
          turns.at(-1).items.push(user
            ? { id: itemId, type: 'userMessage', content: [{ type: 'text', text }] }
            : { id: itemId, type: 'agentMessage', text });
        }
        for (const turn of turns) {
          if (turn.items.at(-1)?.type === 'agentError') turn.status = 'failed';
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
