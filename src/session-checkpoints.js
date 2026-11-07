import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { sessionExecutionState } from '../public/execution-status.js';

const identity = s => JSON.stringify([s.createdAt, s.agent?.kind, s.agent?.id]);
export async function createCheckpoints(file) {
  let state = {};
  try { state = JSON.parse(await fs.readFile(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  let queue = Promise.resolve();
  function change(update) {
    const pending = queue.catch(() => {}).then(async () => {
      const next = structuredClone(state);
      update(next);
      if (JSON.stringify(next) === JSON.stringify(state)) return;
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const temporary = `${file}.${crypto.randomUUID()}.tmp`;
      try { await fs.writeFile(temporary, JSON.stringify(next), { mode: 0o600 }); await fs.rename(temporary, file); state = next; }
      finally { await fs.rm(temporary, { force: true }); }
    });
    queue = pending; return pending;
  }
  function entry(next, session) {
    const id = identity(session);
    if (next[session.name]?.identity !== id) Object.defineProperty(next, session.name, { enumerable: true, writable: true, configurable: true, value: { identity: id, text: '', updatedAt: null, attention: null } });
    return next[session.name];
  }
  const notice = kind => ({ id: crypto.randomUUID(), kind, at: new Date().toISOString() });
  return {
    get(session) { const value = state[session.name]; return value?.identity === identity(session) ? structuredClone(value) : null; },
    set(session, value) {
      if (typeof value?.text !== 'string' || value.text.length > 1000) throw new Error('进度需要不超过1000字的文本');
      return change(next => {
        const item = entry(next, session);
        item.text = value.text.trim(); item.updatedAt = new Date().toISOString();
        if (value.attention === true) item.attention = notice('review');
      });
    },
    observeTurn(session, turn) { return change(next => {
      if (!turn?.id) return;
      const item = entry(next, session);
      if (turn.error || ['failed', 'errored'].includes(turn.status)) {
        if (item.failedTurn !== turn.id) item.attention = notice('failed');
        item.failedTurn = turn.id;
      }
    }); },
    ack(session, id) { return change(next => {
      const item = entry(next, session);
      if (item.attention?.id === id && item.attention.kind !== 'question') item.attention = null;
    }); },
    observe(sessions) { return change(next => {
      for (const name of Object.keys(next)) if (!sessions.some(s => s.name === name)) delete next[name];
      for (const session of sessions) {
        const item = entry(next, session), status = sessionExecutionState(session);
        const question = session.agent?.question?.id || session.pendingApprovalId;
        if (question) {
          if (item.question !== String(question)) item.attention = notice('question');
        } else if (['working', 'background'].includes(status)) item.attention = null;
        else if (['working', 'background'].includes(item.status) && status === 'idle') item.attention = notice('ended');
        else if (item.attention?.kind === 'question') item.attention = null;
        item.question = question ? String(question) : null;
        item.status = status;
      }
    }); },
  };
}
