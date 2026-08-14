import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const SESSION_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;
const CLIENTS = ['shell', 'codex', 'claude'];

export function validateSessionName(name) {
  return typeof name === 'string' && SESSION_NAME.test(name);
}

export function validateClient(client) {
  return CLIENTS.includes(client);
}

export function parseSessions(output) {
  if (!output.trim()) return [];
  return output.trim().split('\n').map((line) => {
    const [name, windows, attached, created, activity] = line.split('\t');
    return {
      name,
      windows: Number(windows),
      attached: Number(attached),
      createdAt: Number(created) * 1000,
      activityAt: Number(activity) * 1000,
    };
  });
}

export async function listSessions() {
  try {
    const { stdout } = await exec('tmux', [
      'list-sessions', '-F',
      '#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_created}\t#{session_activity}',
    ]);
    return parseSessions(stdout).sort((a, b) => b.activityAt - a.activityAt);
  } catch (error) {
    if (error.code === 1) return [];
    throw error;
  }
}

export async function createSession({ name, client = 'shell', cwd }) {
  if (!validateSessionName(name)) throw new Error('会话名只能包含字母、数字、点、短横线或下划线，最长 64 个字符');
  if (!validateClient(client)) throw new Error('未知的终端类型');

  const args = ['new-session', '-d', '-s', name];
  if (cwd) args.push('-c', cwd);
  await exec('tmux', args);
  if (client !== 'shell') await exec('tmux', ['send-keys', '-t', `${name}:0.0`, client, 'Enter']);
}

export async function killSession(name) {
  if (!validateSessionName(name)) throw new Error('无效的会话名');
  await exec('tmux', ['kill-session', '-t', name]);
}
