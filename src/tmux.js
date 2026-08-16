import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { detectPaneAgents } from './agents.js';

const exec = promisify(execFile);
const SESSION_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;
const CLIENTS = ['shell', 'codex', 'claude', 'qodercli'];
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
// An agent waiting on the model sleeps on a socket at 0% CPU, so the process tree cannot
// tell working from idle. Each agent does render its own busy affordance, so read that
// instead. `lines` is how many trailing non-empty lines of the visible pane a marker may
// appear on, counted separately per marker because the two sit at different heights.
//
// Claude Code's spinner is the dependable busy signal, and it is structural rather than
// lexical: a gerund, an ellipsis, then an elapsed timer in parentheses ("Gesticulating…
// (1m 58s · ↓ 6.1k tokens)"). The finished turn keeps the same glyph but drops both the
// ellipsis and the parentheses ("Worked for 45s"), so the shape separates them while the
// randomised verb cannot. "esc to interrupt" is a weaker second source: the footer swaps
// it out whenever messages are queued.
//
// Background tasks are matched on the footer alone. Widening that window would let a
// transcript line like "Ran 1 shell command" pin the indicator on for good.
export const AGENT_SCREEN_MARKERS = {
  claude: {
    busy: { lines: 12, patterns: [/^[^\p{L}\n]{0,4}\p{L}+…\s*\(\d/u, /esc to interrupt/i] },
    background: { lines: 1, patterns: [/\b\d+\s+(?:shell|monitor|task)s?\b/i] },
  },
  codex: {
    busy: { lines: 6, patterns: [/esc to interrupt/i, /^[\s•·]*(?:working|thinking)\b/i] },
    background: { lines: 6, patterns: [/\b\d+\s+background\s+terminals?\s+running\b/i] },
  },
  qodercli: {
    busy: { lines: 6, patterns: [/esc to interrupt/i] },
    background: { lines: 1, patterns: [] },
  },
};
let supportsWindowSizePromise;

export function validateSessionName(name) {
  return typeof name === 'string' && SESSION_NAME.test(name);
}

export function validateClient(client) {
  return CLIENTS.includes(client);
}

export function supportsWindowSizeOption(version) {
  const match = /tmux\s+(\d+)\.(\d+)/.exec(version);
  return Boolean(match && (Number(match[1]) > 2 || Number(match[1]) === 2 && Number(match[2]) >= 9));
}

export function detectWindowSizeSupport() {
  supportsWindowSizePromise ||= exec('tmux', ['-V']).then(({ stdout }) => supportsWindowSizeOption(stdout));
  return supportsWindowSizePromise;
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

export function resolveScreenSignals(output, markers) {
  if (!markers) return { busy: false, background: false };
  const lines = String(output || '')
    .split('\n')
    .map((line) => stripAnsi(line).trim())
    .filter((line) => line.length > 0);
  const matches = ({ lines: window, patterns }) => lines
    .slice(-window)
    .some((line) => patterns.some((pattern) => pattern.test(line)));
  return { busy: matches(markers.busy), background: matches(markers.background) };
}

function readScreenSignals(paneId, markers) {
  if (!paneId || !markers) return Promise.resolve({ busy: false, background: false });
  return exec('tmux', ['capture-pane', '-p', '-t', paneId])
    .then(({ stdout }) => resolveScreenSignals(stdout, markers))
    .catch(() => ({ busy: false, background: false }));
}

export function resolveWorkingState({ agentKind, screenSignals, paneCommands }) {
  if (agentKind) return Boolean(screenSignals?.busy || screenSignals?.background);
  return (paneCommands || []).some((command) => !isShellCommand(command));
}

export async function listSessions() {
  try {
    const [{ stdout }, { stdout: paneOutput }] = await Promise.all([
      exec('tmux', ['list-sessions', '-F', '#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_created}\t#{session_activity}\t#{window_width}\t#{window_height}\t#{status}']),
      exec('tmux', ['list-panes', '-a', '-F', '#{session_name}\t#{window_active}\t#{pane_active}\t#{pane_pid}\t#{pane_id}\t#{pane_current_command}']),
    ]);
    const allPanes = parsePanes(paneOutput);
    const panes = [...allPanes]
      .sort((a, b) => b.score - a.score)
      .filter((pane, index, all) => all.findIndex((item) => item.session === pane.session) === index);

    const paneCommandBySession = new Map();
    for (const pane of panes) paneCommandBySession.set(pane.session, pane.currentCommand);

    const paneCommandsBySession = new Map();
    for (const pane of allPanes) {
      const list = paneCommandsBySession.get(pane.session) || [];
      list.push(pane.currentCommand);
      paneCommandsBySession.set(pane.session, list);
    }

    const agents = await detectPaneAgents(panes);
    const screenSignalsBySession = new Map(
      await Promise.all(panes
        .filter((pane) => agents.has(pane.session))
        .map(async (pane) => [
          pane.session,
          await readScreenSignals(pane.paneId, AGENT_SCREEN_MARKERS[agents.get(pane.session).kind]),
        ])),
    );

    return parseSessions(stdout)
      .map((session) => ({
        ...session,
        agent: agents.get(session.name) || null,
        currentCommand: paneCommandBySession.get(session.name) || 'bash',
        hasRunningProcess: resolveWorkingState({
          agentKind: agents.get(session.name)?.kind || null,
          screenSignals: screenSignalsBySession.get(session.name),
          paneCommands: paneCommandsBySession.get(session.name) || [],
        }),
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

// "largest" sizes the window to the biggest attached client and clips every smaller one,
// so a browser tab viewing a session that is also open in a wider or taller terminal loses
// the rows off the bottom. That only shows when content reaches the last row, which is why
// popups like Claude Code's model picker appear cut off while ordinary output looks fine.
// "latest" follows whichever client is active, so the terminal being typed into always fits.
export async function preferLatestClientSize() {
  if (!await detectWindowSizeSupport()) return false;
  await exec('tmux', ['set-option', '-g', 'window-size', 'latest']);
  return true;
}

export async function getSessionSize(name) {
  if (!validateSessionName(name)) throw new Error('无效的会话名');
  const { stdout } = await exec('tmux', ['display-message', '-p', '-t', `${name}:`, '#{window_width}\t#{window_height}\t#{status}']);
  const [rawWidth, rawHeight, status] = stdout.trim().split('\t');
  return { width: Number(rawWidth), height: Number(rawHeight) + (status === 'on' ? 1 : 0) };
}
