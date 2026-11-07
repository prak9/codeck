import { Worker } from 'node:worker_threads';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export function historyRoots(env = process.env) {
  const codex = env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return [
    { provider: 'codex', directory: path.join(codex, 'sessions') },
    { provider: 'codex', directory: path.join(codex, 'archived_sessions') },
    { provider: 'claude', directory: path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects') },
    { provider: 'qodercli', directory: path.join(env.QODER_CONFIG_DIR || path.join(env.QODER_CLI_HOME || os.homedir(), env.QODER_CONFIG_DIR_NAME || '.qoder'), 'projects') },
  ];
}
export function createHistorySearch({ directory, roots = historyRoots() }) {
  let worker, serial = 0, starting;
  const pending = new Map();
  async function start() {
    if (worker) return worker;
    if (!starting) starting = (async () => {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.chmod(directory, 0o700);
      const w = new Worker(new URL('./history-search-worker.js', import.meta.url), { workerData: { directory, roots }, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 256 } });
      worker = w;
      w.on('message', m => { const entry = pending.get(m.id); if (!entry) return; pending.delete(m.id); clearTimeout(entry.timer); m.error ? entry.reject(new Error(m.error)) : entry.resolve(m.result); });
      const failed = error => {
        if (worker !== w) return;
        worker = null;
        for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); } pending.clear();
      };
      w.on('error', failed); w.on('exit', () => failed(new Error('历史索引进程已退出，请重试读取')));
      return w;
    })().finally(() => { starting = null; });
    return starting;
  }
  async function call(method, params) {
    const w = await start(), id = ++serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('历史查询超时；索引仍在后台进行')); }, 15_000);
      pending.set(id, { resolve, reject, timer }); w.postMessage({ id, method, params });
    });
  }
  return {
    search: (query, options) => call('search', { query, options }),
    context: id => call('context', { id }),
    async link({ provider, threadId, repo, commit }) {
      if (!['codex', 'claude', 'qodercli'].includes(provider) || typeof threadId !== 'string' || !threadId || threadId.length > 256
        || !path.isAbsolute(repo || '') || !/^[0-9a-f]{7,40}$/i.test(commit || '')) throw new Error('请提供 provider、threadId、项目绝对路径和提交 SHA');
      const { stdout: top } = await exec('git', ['-C', repo, 'rev-parse', '--show-toplevel'], { timeout: 5000 });
      const actual = await fs.realpath(top.trim());
      const { stdout } = await exec('git', ['-C', actual, 'show', '-s', '--format=%H%n%s', `${commit}^{commit}`], { timeout: 5000, maxBuffer: 64 * 1024 });
      const [sha, subject] = stdout.trimEnd().split('\n');
      return call('link', { provider, threadId, repo: actual, sha, subject });
    },
    async close() { if (starting) await starting; if (worker) await worker.terminate(); },
  };
}
