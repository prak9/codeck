import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { detectPaneAgents, resolveAgentSessionActivity } from './agents.js';

const exec = promisify(execFile);
const SESSION_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;
const CLIENTS = ['shell', 'codex', 'claude', 'qodercli'];
const AGENT_BUSY_COMMAND_PATTERNS = [
  /\bfunction_call\b/i,
  /\btool[-_ ]?call\b/i,
  /\btooling\b/i,
  /\binference\b/i,
  /\bllm\b/i,
];
const WORKER_COMMANDS = new Set([
  'gcc',
  'g++',
  'clang',
  'cargo',
  'tsc',
  'npm',
  'yarn',
  'pnpm',
  'pip',
  'pip3',
  'python',
  'python3',
  'rg',
  'git',
  'git-receive-pack',
  'ruff',
  'pytest',
  'go',
  'make',
  'cmake',
  'gradle',
  'mvn',
  'node',
  'bun',
  'deno',
  'ruby',
  'java',
]);
const SHELL_COMMANDS = new Set([
  'bash',
  'sh',
  'zsh',
  'fish',
  'dash',
  'ash',
  'ksh',
  'csh',
  'tcsh',
  'tmux',
]);
const WORKER_SCREEN_PATTERNS = [
  /[⠋⠙⠹⠸⠴⠦⠧⠇⠏]/,
  /\b(think(?:ing)?|analyzing|running tool|working|building|waiting for input|tool\s*call|tool_call|inference|processing|loading)\b/i,
  /\b(spinner|progress)\b/i,
];
const IDLE_SCREEN_PATTERNS = [
  /^\s*[>➜$#]\s*$/,
  /^(?:codex|claude|qoder|qodercli)\s*>\s*$/i,
  /^\S+@\S+:\S*\s*[$#>]\s*$/,
];
const SCREEN_CAPTURE_LINES = 8;
const CPU_ACTIVITY_THRESHOLD = 1;
const CPU_ACTIVITY_STREAK = 2;
let supportsLargestSizePromise;
const processCpuHistory = new Map();

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
    const [session, windowActive, paneActive, pid, paneId, currentCommand] = line.split('\t');
    return {
      session,
      pid: Number(pid),
      paneId,
      score: Number(windowActive) + Number(paneActive),
      currentCommand: (currentCommand || 'bash').trim().toLowerCase(),
    };
    }).filter((pane) => pane.session);
}

function parseProcesses(output) {
  if (!output.trim()) return [];
  return output.trim().split('\n').map((line) => {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 6) return null;
    const [rawPid, rawPpid, state, rawCpu, rawTime, ...rawCommand] = parts;
    const command = rawCommand.join(' ');
    if (!rawPid || !rawPpid || !command) return null;
    return {
      pid: Number(rawPid),
      ppid: Number(rawPpid),
      state: (state || '').trim(),
      cpuPercent: Number.isFinite(Number(rawCpu)) ? Number(rawCpu) : 0,
      cpuTime: rawTime || '0',
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

function stripAnsi(input) {
  return String(input).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

function normalizeCommand(command) {
  const first = stripAnsi(command).trim().split(/\s+/)[0] || '';
  const unquoted = first.replace(/^["']|["']$/g, '');
  const normalized = unquoted.includes('/') ? unquoted : unquoted.replaceAll('\\', '/');
  return (normalized.split('/').at(-1) || '').toLowerCase();
}

function isShellCommand(command) {
  return SHELL_COMMANDS.has(normalizeCommand(command));
}

function isBusyCommand(command = '') {
  const normalized = normalizeCommand(command);
  if (!normalized) return false;
  if (WORKER_COMMANDS.has(normalized)) return true;
  return AGENT_BUSY_COMMAND_PATTERNS.some((pattern) => pattern.test(command));
}

function parsePsTimeToMs(rawTime) {
  const match = String(rawTime || '').trim();
  if (!match) return null;
  let day = 0;
  let clock = match;
  const daySplit = match.split('-');
  if (daySplit.length === 2 && Number.isFinite(Number(daySplit[0]))) {
    day = Number(daySplit[0]);
    clock = daySplit[1];
  }
  const [timePart, fractionPart] = clock.split('.');
  const parts = timePart.split(':').map(Number);
  if (parts.some((value) => !Number.isFinite(value))) return null;

  let hours = 0;
  let minutes = 0;
  let seconds = 0;
  if (parts.length === 3) {
    [hours, minutes, seconds] = parts;
  } else if (parts.length === 2) {
    [minutes, seconds] = parts;
  } else if (parts.length === 1) {
    [seconds] = parts;
  }

  const fraction = fractionPart && Number.isFinite(Number(fractionPart))
    ? Number(`0.${fractionPart}`)
    : 0;
  return (((day * 24 + hours) * 60 + minutes) * 60 + seconds + fraction) * 1000;
}

function trackProcessCpuSignal(process, now = Date.now()) {
  const pid = Number(process?.pid);
  if (!Number.isFinite(pid)) return { cpuBusy: false, consecutive: 0 };

  const currentCpuMs = parsePsTimeToMs(process.cpuTime);
  const previous = processCpuHistory.get(pid);
  const sample = { at: now, cpuMs: currentCpuMs, consecutive: 0, cpuBusy: false, cpuRate: 0 };

  if (previous && Number.isFinite(previous.cpuMs) && Number.isFinite(currentCpuMs)) {
    const intervalMs = now - previous.at;
    if (intervalMs > 0) {
      const delta = Math.max(0, currentCpuMs - previous.cpuMs);
      sample.cpuRate = (delta / intervalMs) * 100;
      sample.consecutive = sample.cpuRate > CPU_ACTIVITY_THRESHOLD
        ? (Number.isFinite(previous.consecutive) ? previous.consecutive + 1 : 1)
        : 0;
      sample.cpuBusy = sample.consecutive >= CPU_ACTIVITY_STREAK;
    }
  }

  processCpuHistory.set(pid, {
    ...sample,
    consecutive: Number.isFinite(sample.consecutive) ? sample.consecutive : 0,
  });
  return processCpuHistory.get(pid);
}

function isIOOrRunningState(state) {
  return /^R/.test(state || '') || /^D/.test(state || '');
}

function evaluateProcessTreeBusyState(panePids, processLookup, now = Date.now()) {
  const { byPid, childrenByPid } = processLookup;
  const seen = new Set();
  const queue = [...new Set(panePids)].filter(Number.isFinite);
  let hasBusySubProcess = false;
  let hasIOOrRunning = false;
  let hasCpuBusy = false;

  while (queue.length) {
    const currentPid = queue.shift();
    if (seen.has(currentPid)) continue;
    seen.add(currentPid);
    const process = byPid.get(currentPid);
    if (!process) continue;

    if (isBusyCommand(process.command)) {
      hasBusySubProcess = true;
    }
    if (!isShellCommand(process.command) && isIOOrRunningState(process.state)) {
      hasIOOrRunning = true;
    }
    if (trackProcessCpuSignal(process, now).cpuBusy) {
      hasCpuBusy = true;
    }

    const children = childrenByPid.get(currentPid) || [];
    queue.push(...children);
  }

  return { hasBusySubProcess, hasIOOrRunning, hasCpuBusy };
}

function isPromptLine(line) {
  const trimmed = stripAnsi(line).trim();
  return IDLE_SCREEN_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function evaluateScreenState(paneId) {
  if (!paneId) return Promise.resolve({ hasWorkingText: false, hasIdlePrompt: false });
  return exec('tmux', ['capture-pane', '-p', '-t', paneId, '-S', `-${SCREEN_CAPTURE_LINES}`])
    .then(({ stdout }) => {
      const lines = String(stdout || '')
        .split('\n')
        .slice(-SCREEN_CAPTURE_LINES)
        .map((line) => stripAnsi(line).trim());
      const hasWorkingText = lines.some((line) =>
        WORKER_SCREEN_PATTERNS.some((pattern) => pattern.test(line)),
      );
      const lastNonEmpty = [...lines].reverse().find((line) => line.length > 0);
      const hasIdlePrompt = lastNonEmpty ? isPromptLine(lastNonEmpty) : false;
      return { hasWorkingText, hasIdlePrompt };
    })
    .catch(() => ({ hasWorkingText: false, hasIdlePrompt: false }));
}

function resolveWorkingState(processSignals, screenSignals) {
  if (screenSignals.hasIdlePrompt && !processSignals.hasBusySubProcess && !processSignals.hasIOOrRunning && !processSignals.hasCpuBusy) {
    return false;
  }
  if (processSignals.hasBusySubProcess || processSignals.hasIOOrRunning || processSignals.hasCpuBusy) return true;
  if (screenSignals.hasWorkingText) return true;
  return false;
}

function pruneCpuHistory(validPids) {
  for (const pid of processCpuHistory.keys()) {
    if (!validPids.has(pid)) processCpuHistory.delete(pid);
  }
}

export async function listSessions() {
  try {
    const now = Date.now();
    const [{ stdout }, { stdout: paneOutput }, { stdout: processOutput }] = await Promise.all([
      exec('tmux', ['list-sessions', '-F', '#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_created}\t#{session_activity}\t#{window_width}\t#{window_height}\t#{status}']),
      exec('tmux', ['list-panes', '-a', '-F', '#{session_name}\t#{window_active}\t#{pane_active}\t#{pane_pid}\t#{pane_id}\t#{pane_current_command}']),
      exec('ps', ['-eo', 'pid=,ppid=,state=,pcpu=,time=,command=']),
    ]);
    const allPanes = parsePanes(paneOutput);
    const panes = allPanes
      .sort((a, b) => b.score - a.score)
      .filter((pane, index, all) => all.findIndex((item) => item.session === pane.session) === index);

    const paneCommandBySession = new Map();
    for (const pane of panes) paneCommandBySession.set(pane.session, pane.currentCommand);

    const panePidsBySession = new Map();
    const topPaneBySession = new Map();
    for (const pane of allPanes) {
      if (!Number.isFinite(pane.pid)) continue;
      const list = panePidsBySession.get(pane.session) || [];
      if (!list.includes(pane.pid)) list.push(pane.pid);
      panePidsBySession.set(pane.session, list);
      if (!topPaneBySession.has(pane.session) && pane.paneId) topPaneBySession.set(pane.session, pane);
    }

    const agents = await detectPaneAgents(panes);
    const processLookup = buildProcessLookup(parseProcesses(processOutput));
    pruneCpuHistory(new Set(processLookup.byPid.keys()));

    const screenSignalsBySession = new Map(
      await Promise.all([...topPaneBySession.entries()].map(async ([sessionName, pane]) => {
        const signals = await evaluateScreenState(pane.paneId);
        return [sessionName, signals];
      })),
    );

    const runningBySession = new Map();
    for (const [sessionName, pids] of panePidsBySession) {
      const processSignals = evaluateProcessTreeBusyState(pids, processLookup, now);
      const screenSignals = screenSignalsBySession.get(sessionName) || { hasWorkingText: false, hasIdlePrompt: false };
      runningBySession.set(sessionName, resolveWorkingState(processSignals, screenSignals));
    }

    const activityBySession = new Map(
      await Promise.all([...agents.entries()].map(async ([sessionName, agent]) => [
        sessionName,
        resolveAgentSessionActivity(agent, process.env, sessionName),
      ])),
    );

    return parseSessions(stdout)
      .map((session) => ({
        ...session,
        agent: agents.get(session.name) || null,
        currentCommand: paneCommandBySession.get(session.name) || 'bash',
        hasRunningProcess: runningBySession.get(session.name) || false,
        sessionFileMtime: Number.isFinite(activityBySession.get(session.name))
          ? activityBySession.get(session.name)
          : session.activityAt,
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
