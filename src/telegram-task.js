import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveSessionClientCommand, validateSessionName } from './tmux.js';
const exec = promisify(execFile);
const quote = text => `'${text.replaceAll("'", "'\\''")}'`;

export async function createTelegramTask({ name, provider, cwd, text }, run = exec) {
  try {
    if (!validateSessionName(name) || !['codex', 'claude', 'qodercli'].includes(provider)) throw new Error('无效的新会话参数');
    if (typeof text !== 'string' || !text.trim() || text.includes('\0')) throw new Error('新任务目标无效');
    if (!(await fs.stat(cwd)).isDirectory()) throw new Error('项目目录不存在');
  } catch (error) { error.notStarted = true; throw error; }
  // Pass the prompt as a quoted CLI argument to the new pane's startup shell.
  // No race with terminal scrolling/paste, and a literal leading '-' stays data.
  const command = `${resolveSessionClientCommand(provider)} -- ${quote(text)}; exec bash -l`;
  const result = await run('tmux', ['new-session', '-d', '-s', name, '-c', cwd, '-P', '-F', '#{pane_id}', command]);
  const paneId = result.stdout?.trim();
  if (!/^%\d+$/.test(paneId || '')) throw new Error('创建结果未确认，请检查会话列表，不要重复创建');
  return { provider, threadId: null, tmuxSession: name, paneId };
}
