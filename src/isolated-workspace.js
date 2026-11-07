import path from 'node:path';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export async function createIsolatedWorkspace({ cwd, worktree }) {
  if (!path.isAbsolute(cwd || '') || !path.isAbsolute(worktree || '')) throw new Error('独立工作区和项目需使用绝对路径');
  try { await fs.lstat(worktree); throw new Error('独立工作区路径已存在，不会覆盖'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Detached checkout avoids inventing branch names or touching the main index.
  await exec('git', ['-C', cwd, 'worktree', 'add', '--detach', '--', worktree, 'HEAD']);
  return worktree;
}
