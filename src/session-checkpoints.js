import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { sessionExecutionState } from '../public/execution-status.js';

const identity = s => JSON.stringify([s.createdAt, s.agent?.kind, s.agent?.id]);
const sameSession = (value, session) => {
  try { const [created, provider] = JSON.parse(value.identity); return created === (session.createdAt ?? null) && provider === (session.agent?.kind ?? null); }
  catch { return false; }
};
function progressRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('任务进度需要对象');
  const result = {};
  for (const key of ['goal', 'verified', 'current', 'next', 'needsUser', 'constraints']) {
    if (value[key] == null) continue;
    if (typeof value[key] !== 'string' || value[key].length > 4000) throw new TypeError('进度字段需为不超过4000字的文本');
    result[key] = value[key].trim();
  }
  if (value.evidence != null) {
    if (!Array.isArray(value.evidence) || value.evidence.length > 30) throw new TypeError('成果链接格式无效');
    result.evidence = value.evidence.map(item => {
      if (typeof item?.label !== 'string' || !item.label.trim() || item.label.length > 200
        || typeof item.url !== 'string' || item.url.length > 2000 || !/^(?:https:\/\/|\/pages\/)/u.test(item.url)
        || /[\s\\]/u.test(item.url)) throw new TypeError('成果链接仅支持HTTPS或本站发布页');
      return { label: item.label.trim(), url: item.url, ...(typeof item.version === 'string' ? { version: item.version.slice(0, 256) } : {}) };
    });
  }
  return result;
}
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
  function entry(next, session, replace = false) {
    const previous = next[session.name], id = identity(session);
    if (!previous || !sameSession(previous, session) || replace) {
      const archives = previous ? [...(previous.archives || []), Object.fromEntries(Object.entries(previous).filter(([key]) => key !== 'archives'))] : [];
      Object.defineProperty(next, session.name, { enumerable: true, writable: true, configurable: true,
        value: { identity: id, text: '', updatedAt: null, attention: null, taskId: crypto.randomUUID(), archives, ...(previous?.identity === id && previous.failedTurn ? { failedTurn: previous.failedTurn } : {}) } });
    }
    return next[session.name];
  }
  const notice = kind => ({ id: crypto.randomUUID(), kind, at: new Date().toISOString() });
  return {
    get(session) {
      const value = state[session.name]; if (!value || !sameSession(value, session)) return null;
      const { archives, ...record } = structuredClone(value);
      const stale = record.identity !== identity(session);
      return { ...record, stale, ...(stale ? { attention: null } : {}) };
    },
    set(session, value) {
      if (typeof value?.text !== 'string' || value.text.length > 1000) throw new TypeError('进度需要不超过1000字的文本');
      const progress = value.progress == null ? undefined : progressRecord(value.progress);
      return change(next => {
        const prior = next[session.name];
        const item = entry(next, session, value.newTask === true || (prior && prior.identity !== identity(session)));
        if (progress) item.progress = progress;
        item.text = value.text.trim(); item.updatedAt = new Date().toISOString();
        if (value.attention === true || item.progress?.needsUser) item.attention = notice('review');
        else if (item.attention?.kind === 'review') item.attention = null;
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
      for (const session of sessions) {
        const item = entry(next, session), status = sessionExecutionState(session);
        const question = session.agent?.question?.id || session.pendingApprovalId;
        if (question) {
          if (item.question !== String(question)) item.attention = notice('question');
        } else if (['working', 'background'].includes(status) && !item.progress?.needsUser && item.attention?.kind !== 'review') item.attention = null;

        else if (item.attention?.kind === 'question') item.attention = null;
        item.question = question ? String(question) : null;
        item.status = status;
      }
    }); },
  };
}
