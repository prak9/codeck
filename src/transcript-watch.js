import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const UUID = /^[0-9a-fA-F-]{36}$/;

function firstMatch(root, accept, depth = 4) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch { return null; }
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (depth <= 0) continue;
      const found = firstMatch(target, accept, depth - 1);
      if (found) return found;
    } else if (accept(entry.name)) return target;
  }
  return null;
}

// Transcript 文件是 CLI 自己在写的, 所以它既是内容来源, 也是"有新内容了"的信号。
// 找不到就返回 null —— 调用方据此保持原有轮询, 监听失败绝不能让它反而变慢。
export function findTranscriptFile(provider, threadId, {
  claudeHome = path.join(os.homedir(), '.claude'),
  codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
} = {}) {
  if (!threadId || !UUID.test(threadId)) return null;
  if (provider === 'codex') {
    const suffix = `-${threadId}.jsonl`;
    return firstMatch(
      path.join(codexHome, 'sessions'),
      (name) => name.startsWith('rollout-') && name.endsWith(suffix),
    );
  }
  if (provider === 'claude' || provider === 'qodercli') {
    const target = `${threadId}.jsonl`;
    return firstMatch(path.join(claudeHome, 'projects'), (name) => name === target, 2);
  }
  return null;
}

// fs.watch 在编辑器保存、原子替换等情况下会连发多次; 合并成一次刷新。
export function watchTranscript(file, onChange, { debounceMs = 40, watch = fs.watch } = {}) {
  if (!file) return null;
  let timer = null;
  let watcher;
  try {
    watcher = watch(file, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; onChange(); }, debounceMs);
    });
  } catch {
    return null;
  }
  watcher.on?.('error', () => {});
  return () => {
    if (timer) clearTimeout(timer);
    try { watcher.close(); } catch { /* already closed */ }
  };
}
