import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { detectPaneAgents } from './agents.js';

const exec = promisify(execFile);
const SESSION_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;
const CLIENTS = ['shell', 'codex', 'claude', 'qodercli'];
let supportsLargestSizePromise;

export function validateSessionName(name) {
  return typeof name === 'string' && SESSION_NAME.test(name);
}

export function validateClient(client) {
  return CLIENTS.includes(client);
}

export function supportsLargestSize(version) {
  const match = /tmux\s+(\d+)\.(\d+)/.exec(version);
  return Boolean(match && (Number(match[1]) > 2 || Number(match[1]) === 2 && Number(match[2]) >= 9));
}

export function supportsLargestClientSize() {
  supportsLargestSizePromise ||= exec('tmux', ['-V']).then(({ stdout }) => supportsLargestSize(stdout));
  return supportsLargestSizePromise;
}

export function withoutTmuxEnvironment(environment) {
  const { TMUX: _tmux, TMUX_PANE: _tmuxPane, ...clean } = environment;
  return clean;
}

export function parseSessions(output) {
  if (!output.trim()) return [];
  return output.trim().split('\n').map((line) => {
    const [name, windows, attached, created, activity, width, height, status] = line.split('\t');
    return {
      name,
      windows: Number(windows),
      attached: Number(attached),
      createdAt: Number(created) * 1000,
      activityAt: Number(activity) * 1000,
      width: Number(width),
      height: Number(height) + (status === 'on' ? 1 : 0),
    };
  });
}

function parsePanes(output) {
  if (!output.trim()) return [];
  return output.trim().split('\n').map((line) => {
    const [session, windowActive, paneActive, pid, currentCommand] = line.split('\t');
    return {
      session,
      pid: Number(pid),
      score: Number(windowActive) + Number(paneActive),
      currentCommand: (currentCommand || 'bash').trim().toLowerCase(),
    };
  }).filter((pane) => pane.session);
}

function parseProcesses(output) {
  if (!output.trim()) return [];
  return output.trim().split('\n').map((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+([A-Za-z+]+)\s+(.*)$/);
    if (!match) return null;
    const [, rawPid, rawPpid, rawState, command] = match;
    return {
      pid: Number(rawPid),
      ppid: Number(rawPpid),
      state: rawState || '',
      command: (command || '').trim(),
    };
  }).filter((entry) => Number.isFinite(entry?.pid) && Number.isFinite(entry?.ppid) && entry);
}

function buildProcessLookup(processes) {
  const byPid = new Map();
  const childrenByPid = new Map();
  for (const process of processes) {
    byPid.set(process.pid, process);
    if (!childrenByPid.has(process.ppid)) childrenByPid.set(process.ppid, []);
    childrenByPid.get(process.ppid).push(process.pid);
  }
  return { byPid, childrenByPid };
}

function hasRunningProcessInSession(panePids, processLookup) {
  const { byPid, childrenByPid } = processLookup;
  const seen = new Set();
  const queue = [...panePids];
  while (queue.length) {
    const currentPid = queue.shift();
    if (seen.has(currentPid)) continue;
    seen.add(currentPid);
    const process = byPid.get(currentPid);
    if (!process) continue;
    if (process.state?.startsWith('R')) return true;
    const children = childrenByPid.get(currentPid);
    if (children) queue.push(...children);
  }
  return false;
}

export async function listSessions() {
  try {
    const [{ stdout }, { stdout: paneOutput }, { stdout: processOutput }] = await Promise.all([
      exec('tmux', ['list-sessions', '-F', '#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_created}\t#{session_activity}\t#{window_width}\t#{window_height}\t#{status}']),
      exec('tmux', ['list-panes', '-a', '-F', '#{session_name}\t#{window_active}\t#{pane_active}\t#{pane_pid}\t#{pane_current_command}']),
      exec('ps', ['-eo', 'pid=,ppid=,state=,cmd=']),
    ]);
    const allPanes = parsePanes(paneOutput);
    const panes = allPanes
      .sort((a, b) => b.score - a.score)
      .filter((pane, index, all) => all.findIndex((item) => item.session === pane.session) === index);

    const paneCommandBySession = new Map();
    for (const pane of panes) paneCommandBySession.set(pane.session, pane.currentCommand);

    const panePidsBySession = new Map();
    for (const pane of allPanes) {
      if (!Number.isFinite(pane.pid)) continue;
      const list = panePidsBySession.get(pane.session) || [];
      if (!list.includes(pane.pid)) list.push(pane.pid);
      panePidsBySession.set(pane.session, list);
    }

    const processLookup = buildProcessLookup(parseProcesses(processOutput));
    const runningBySession = new Map();
    for (const [sessionName, pids] of panePidsBySession) {
      runningBySession.set(sessionName, hasRunningProcessInSession(pids, processLookup));
    }

    const agents = await detectPaneAgents(panes);
    return parseSessions(stdout)
      .map((session) => ({
        ...session,
        agent: agents.get(session.name) || null,
        currentCommand: paneCommandBySession.get(session.name) || 'bash',
        hasRunningProcess: runningBySession.get(session.name) || false,
      }))
      .sort((a, b) => Number(b.createdAt) - Number(a.createdAt) || a.name.localeCompare(b.name));
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

export async function renameSession(name, newName) {
  if (!validateSessionName(name) || !validateSessionName(newName)) throw new Error('无效的会话名');
  await exec('tmux', ['rename-session', '-t', name, newName]);
}

export async function preferLargestClientSize() {
  if (!await supportsLargestClientSize()) return false;
  await exec('tmux', ['set-option', '-g', 'window-size', 'largest']);
  return true;
}

export async function getSessionSize(name) {
  if (!validateSessionName(name)) throw new Error('无效的会话名');
  const { stdout } = await exec('tmux', ['display-message', '-p', '-t', `${name}:`, '#{window_width}\t#{window_height}\t#{status}']);
  const [rawWidth, rawHeight, status] = stdout.trim().split('\t');
  return { width: Number(rawWidth), height: Number(rawHeight) + (status === 'on' ? 1 : 0) };
}
