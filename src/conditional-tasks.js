import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
const validId = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

// Exit zero + a stable nonempty event key means work exists. No shell evaluation.
export function runPrecheck(task, { timeout = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(task.check[0], task.check.slice(1), { cwd: task.cwd, detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '', bytes = 0, finished = false;
    const timer = setTimeout(() => finish(new Error('条件检查超时')), timeout);
    function finish(error, value) {
      if (finished) return;
      finished = true; clearTimeout(timer);
      // A check must not leave grandchildren holding pipes or running after timeout.
      if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') error ||= e; } }
      if (error) reject(error); else resolve(value);
    }
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 64 * 1024) return finish(new Error('条件检查输出过大'));
      output += chunk.toString();
    });
    child.on('error', error => finish(error));
    child.on('close', code => finish(null, code === 0 ? output.trim() || null : null));
  });
}

export async function createConditionalTasks({ directory, send, idle, precheck = runPrecheck, settled = async () => false, now = Date.now }) {
  let tasks = {};
  const file = path.join(directory, 'tasks.json');
  try { tasks = JSON.parse(await fs.readFile(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  let queue = Promise.resolve(), ticking = null;
  const serialize = fn => { const pending = queue.catch(() => {}).then(fn); queue = pending; return pending; };
  async function save(next) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temp = `${file}.${crypto.randomUUID()}.tmp`;
    try { await fs.writeFile(temp, JSON.stringify(next), { mode: 0o600 }); await fs.rename(temp, file); tasks = next; }
    finally { await fs.rm(temp, { force: true }); }
  }
  async function run() {
    const reserved = new Set();
    for (const task of Object.values(tasks)) {
      if (!['accepted', 'dispatching', 'unknown'].includes(task.last?.status)) continue;
      let finished = false;
      if (task.last.status === 'accepted') {
        try { finished = await settled(task, task.last); } catch { /* Unknown remains reserved. */ }
      }
      if (finished) {
        const next = structuredClone(tasks); next[task.id].last.status = 'finished'; await save(next);
      } else reserved.add(JSON.stringify([task.provider, task.threadId, task.session]));
    }
    for (const task of Object.values(tasks)) {
      if (!task.enabled || task.nextAt > now() || ['dispatching', 'unknown'].includes(task.last?.status)) continue;
      const targetKey = JSON.stringify([task.provider, task.threadId, task.session]);
      if (reserved.has(targetKey)) continue;
      const next = structuredClone(tasks), current = next[task.id];
      current.nextAt = now() + task.everyMinutes * 60_000;
      try {
        const event = await precheck(task);
        if (!event) current.last = { status: 'skipped', at: now() };
        else if (task.events.includes(event)) current.last = { status: 'unchanged', at: now() };
        else if (!await idle(task)) current.last = { status: 'busy', at: now() };
        else {
          const commandId = `schedule-${crypto.randomUUID()}`;
          current.last = { status: 'dispatching', at: now(), event, commandId };
          current.events.push(event);
          // Persist intent before crossing the external-effect boundary. Crash means unknown.
          await save(next); reserved.add(targetKey);
          try {
            await send(task, commandId, event);
            current.last.status = 'accepted';
          } catch (error) { current.last.status = 'unknown'; current.last.error = error.message; }
        }
      } catch (error) { current.last = { status: 'check_error', error: error.message, at: now() }; }
      await save(next);
    }
  }
  return {
    async list() { await queue.catch(() => {}); return structuredClone(Object.values(tasks)); },
    put(id, value) { return serialize(async () => {
      if (!validId.test(id) || !Number.isFinite(value?.everyMinutes) || value.everyMinutes <= 0
        || typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.length > 12000
        || !Array.isArray(value.check) || !value.check.length || value.check.some(v => typeof v !== 'string' || v.includes('\0'))
        || !path.isAbsolute(value.check[0]) || !path.isAbsolute(value.cwd || '')
        || !value.session || !value.threadId || !['codex', 'claude', 'qodercli'].includes(value.provider)) throw new Error('无效的条件任务参数');
      const next = structuredClone(tasks), old = Object.hasOwn(next, id) ? next[id] : null;
      if (['accepted', 'dispatching', 'unknown'].includes(old?.last?.status)) throw new Error('上次投递未确认，请核实会话；删除任务后才可重新配置');
      Object.defineProperty(next, id, { enumerable: true, writable: true, configurable: true, value: {
        id, everyMinutes: value.everyMinutes, session: value.session, threadId: value.threadId, provider: value.provider,
        prompt: value.prompt, check: value.check, cwd: value.cwd, enabled: value.enabled !== false,
        nextAt: now(), events: old?.events || [], last: old?.last || null,
      } });
      await save(next); return structuredClone(next[id]);
    }); },
    remove(id) { return serialize(async () => { const next = structuredClone(tasks); delete next[id]; await save(next); }); },
    tick() { if (!ticking) ticking = serialize(run).finally(() => { ticking = null; }); return ticking; },
  };
}
