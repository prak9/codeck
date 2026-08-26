import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { detectPaneAgents } from './agents.js';
import { clampTerminalGrid } from '../public/terminal-utils.js';

const exec = promisify(execFile);
const SESSION_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;
const THREAD_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const PANE_ID = /^%\d+$/;
const CLIENTS = ['shell', 'codex', 'claude', 'qodercli'];
const AGENT_CLIENTS = new Set(CLIENTS.slice(1));
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
  // qodercli's footer reads "⠋ Generating... (esc to cancel, 25s)" while a turn runs.
  // Its composer and status details are rendered below that row, so the marker can sit
  // farther from the bottom than it does in Codex or Claude. Anchor on the elapsed timer
  // inside the parentheses: a modal offering "esc to cancel" carries no timer, and the
  // bare spinner glyph shows up in other widgets too.
  qodercli: {
    busy: { lines: 16, patterns: [/\(esc to cancel,\s*\d/i] },
    background: { lines: 1, patterns: [] },
  },
};

// Identity, not activity. The process tree is authoritative, but it does not cross an ssh
// hop: an agent running on the far side of a jump host leaves no local descendant, so
// detectPaneAgents sees nothing and the session falls back to its foreground command.
// These markers name the agent from what it draws instead. Keep them narrow: Codex must
// own the final pane row, so a completed transcript followed by a shell prompt does not
// keep the pane classified as an Agent.
export const AGENT_SCREEN_IDENTITY = {
  codex: [/^(?:gpt-[\w.-]+|o\d[\w.-]*|codex[\w.-]*)\b.*\s·\s(?:~(?:\/|$)|\/)/i],
  qodercli: [/·\s*ctx\s*[\u2580-\u259f]+\s*\d+%\s*·/],
};

export function identifyAgentFromScreen(output) {
  const lines = screenLines(output).slice(-6);
  for (const [kind, patterns] of Object.entries(AGENT_SCREEN_IDENTITY)) {
    const candidates = kind === 'codex' ? lines.slice(-1) : lines;
    if (candidates.some((line) => patterns.some((pattern) => pattern.test(line)))) return kind;
  }
  return null;
}

export function resolvePaneAgent(detectedAgent, output, pane) {
  if (detectedAgent) return detectedAgent;
  const kind = identifyAgentFromScreen(output);
  if (!kind || !pane?.session || !PANE_ID.test(pane.paneId || '')) return null;
  return { kind, id: null, name: pane.session, paneId: pane.paneId };
}
// A working pane repaints at least once a second; allow a missed poll before going idle.
const SCREEN_ACTIVITY_WINDOW_MS = 6_000;
const screenActivity = new Map();
let supportsWindowSizePromise;

export function validateSessionName(name) {
  return typeof name === 'string' && SESSION_NAME.test(name);
}

export function validateClient(client) {
  return CLIENTS.includes(client);
}

export function resolveSessionClientCommand(client) {
  return client === 'codex' ? 'codex -c check_for_update_on_startup=false' : client;
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

function tmuxStatusRows(status) {
  if (status === 'on') return 1;
  if (status === 'off') return 0;
  const rows = Number(status);
  return Number.isInteger(rows) && rows > 0 ? rows : 0;
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
      height: Number(height) + tmuxStatusRows(status),
    };
  });
}

export function findLinkedWindowSessions(output, session) {
  if (!output.trim()) return [];
  const windows = output.trim().split('\n').map((line) => {
    const [name, windowId, active] = line.split('\t');
    return { name, windowId, active: active === '1' };
  });
  const target = windows.find((window) => window.name === session && window.active);
  if (!target) return [];
  return [...new Set(windows
    .filter((window) => window.windowId === target.windowId && window.name !== session)
    .map((window) => window.name))];
}

export async function getLinkedWindowSessions(name) {
  if (!validateSessionName(name)) throw new Error('无效的会话名');
  const { stdout } = await exec('tmux', ['list-windows', '-a', '-F', '#{session_name}\t#{window_id}\t#{window_active}']);
  return findLinkedWindowSessions(stdout, name);
}

export function parsePanes(output) {
  if (!output.trim()) return [];
  return output.trim().split('\n').map((line) => {
    const [session, windowActive, paneActive, pid, paneId, currentCommand, windowActivity] = line.split('\t');
    return {
      session,
      pid: Number(pid),
      paneId,
      score: Number(windowActive) + Number(paneActive),
      currentCommand: (currentCommand || 'bash').trim().toLowerCase(),
      windowActivityAt: Number(windowActivity || 0) * 1000,
    };
    }).filter((pane) => pane.session);
}

export function mergeWindowActivity(sessions, panes) {
  const latestBySession = new Map();
  for (const pane of panes) {
    latestBySession.set(pane.session, Math.max(
      latestBySession.get(pane.session) || 0,
      pane.windowActivityAt || 0,
    ));
  }
  return sessions.map((session) => ({
    ...session,
    activityAt: Math.max(session.activityAt, latestBySession.get(session.name) || 0),
  }));
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

function screenLines(output) {
  return String(output || '')
    .split('\n')
    .map((line) => stripAnsi(line).trim())
    .filter((line) => line.length > 0);
}

function matchesMarker(lines, { lines: window, patterns }) {
  return lines.slice(-window).some((line) => patterns.some((pattern) => pattern.test(line)));
}

export function resolveScreenSignals(output, markers) {
  if (!markers) return { busy: false, background: false };
  const lines = screenLines(output);
  return { busy: matchesMarker(lines, markers.busy), background: matchesMarker(lines, markers.background) };
}

function elapsedActivityText(lines, markers) {
  const activeLine = [...lines.slice(-markers.busy.lines)].reverse()
    .find((line) => markers.busy.patterns.some((pattern) => pattern.test(line)));
  const match = activeLine?.match(/\((?:esc to cancel,\s*)?(?:(\d+)m\s*)?(\d+)s\b/i);
  if (!match) return '';
  if (!match[1]) return `${Number(match[2])}秒`;
  return `${Number(match[1])}分${String(Number(match[2])).padStart(2, '0')}秒`;
}

function activityLabel(kind, lines) {
  if (kind === 'qodercli') return '正在生成';
  const action = [...lines].reverse()
    .map((line) => /^[•●]\s*(.+)$/.exec(line)?.[1] || '')
    .find((line) => line && !/^(?:working|thinking)\b/i.test(line));
  if (!action) return '正在处理';
  if (/^(?:ran|running|run|executed|executing)\b/i.test(action)) return '正在运行命令';
  if (/^(?:explored|exploring|read|reading|opened|opening|inspected|inspecting|viewed|viewing)\b/i.test(action)) return '正在查看文件';
  if (/^(?:updated|updating)\s+(?:the\s+)?plan\b/i.test(action)) return '正在更新计划';
  if (/^(?:edited|editing|modified|modifying|applied|applying|wrote|writing|added|adding|deleted|deleting|patched|patching|created|creating)\b/i.test(action)) return '正在修改文件';
  if (/^(?:searched|searching|search)\b/i.test(action)) return '正在搜索';
  if (/\b(?:tool|mcp)\b/i.test(action)) return '正在调用工具';
  return '正在处理';
}

// Only fixed labels and elapsed time leave the server; pane text itself never reaches
// the browser. Requiring a live marker also prevents a completed transcript item such
// as "Ran npm test" from remaining visible as current activity.
export function resolveAgentActivityText(kind, output) {
  const markers = AGENT_SCREEN_MARKERS[kind];
  if (!markers) return '';
  const lines = screenLines(output);
  const signals = resolveScreenSignals(output, markers);
  if (!signals.busy && !signals.background) return '';
  if (!signals.busy) return '后台任务运行中';
  const label = activityLabel(kind, lines);
  const elapsed = elapsedActivityText(lines, markers);
  return elapsed ? `${label} · ${elapsed}` : label;
}

const LIVE_OUTPUT_MAX_LINES = 12;
const LIVE_OUTPUT_MAX_LINE_LENGTH = 320;
const SLASH_OUTPUT_MAX_LINES = 30;
const SCREEN_SEPARATOR = /^[─━═-]{8,}$/u;

function cleanScreenRows(output) {
  return String(output || '').split('\n').map((line) => stripAnsi(line)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\s+$/, ''));
}

function markerRow(rows, marker) {
  const candidates = rows
    .map((line, index) => ({ index, text: line.trim() }))
    .filter(({ text }) => text)
    .slice(-marker.lines)
    .filter(({ text }) => marker.patterns.some((pattern) => pattern.test(text)));
  return [...candidates].reverse().find(({ text }) => (
    /\((?:esc to cancel,\s*)?(?:\d+m\s*)?\d+s\b/i.test(text)
  ))?.index ?? candidates.at(-1)?.index ?? -1;
}

function compactLiveOutput(rows, maxLines = LIVE_OUTPUT_MAX_LINES) {
  const compact = [];
  for (const line of rows) {
    if (SCREEN_SEPARATOR.test(line.trim())) continue;
    const clipped = line.length > LIVE_OUTPUT_MAX_LINE_LENGTH
      ? `${line.slice(0, LIVE_OUTPUT_MAX_LINE_LENGTH - 1)}…`
      : line;
    if (!clipped && !compact.at(-1)) continue;
    compact.push(clipped);
  }
  while (compact.length && !compact[0]) compact.shift();
  while (compact.length && !compact.at(-1)) compact.pop();
  if (compact.length <= maxLines) return compact;
  return [compact[0], '  …', ...compact.slice(-(maxLines - 2))];
}

function qoderLiveOutput(rows, end) {
  const searchStart = Math.max(0, end - 32);
  const history = rows.slice(searchStart, end);
  const userRow = history.findLastIndex((line) => /^>\s/.test(line.trimStart()));
  const thinkingRow = history.findLastIndex((line) => line.trim() === 'Thinking');
  const activityRow = history.findIndex((line) => /^(?:[│▫▪▸◎◉]\s|Thinking$)/u.test(line.trimStart()));
  const start = thinkingRow > userRow
    ? searchStart + thinkingRow
    : userRow >= 0
      ? searchStart + userRow + 1
      : activityRow >= 0
        ? searchStart + activityRow
        : Math.max(searchStart, end - 12);
  return compactLiveOutput(rows.slice(start, end + 1), 18).join('\n');
}

function qoderIdleOutput(rows) {
  const composerRow = rows.findLastIndex((line) => /Type your message or @path\/to\/file/i.test(line));
  let end = composerRow >= 0 ? composerRow - 1 : rows.findLastIndex((line) => line.trim());
  if (composerRow >= 0) {
    const boundary = rows.slice(0, composerRow)
      .findLastIndex((line) => SCREEN_SEPARATOR.test(line.trim()));
    if (boundary >= 0) {
      end = boundary - 1;
      const priorBoundary = rows.slice(0, boundary)
        .findLastIndex((line) => SCREEN_SEPARATOR.test(line.trim()));
      const footerHints = rows.slice(priorBoundary + 1, boundary).filter((line) => line.trim());
      if (priorBoundary >= 0 && footerHints.length && footerHints.every((line) => (
        /Shift\+Tab|accept edits|plan mode|bypass permissions|\bskills?\b/i.test(line)
      ))) end = priorBoundary - 1;
    }
  }
  while (end >= 0 && !rows[end].trim()) end -= 1;
  if (end < 0) return '';
  const visible = rows.slice(0, end + 1);
  const hasUserMessage = visible.some((line) => /^>\s+\S/.test(line.trimStart()));
  const isWelcomeScreen = visible.some((line) => /\bQoder CLI\b/i.test(line))
    && visible.some((line) => /Tips for getting started|Signed in/i.test(line));
  if (!hasUserMessage && isWelcomeScreen) return '';
  return qoderLiveOutput(rows, end);
}

// Return the current action block exactly as it appears in the visible tmux pane. The
// block is bounded to keep polling cheap and rendered with textContent in the browser.
// `allowTail` covers a repainting modal that temporarily hides the normal busy marker.
export function resolveAgentLiveOutput(kind, output, { allowTail = false } = {}) {
  const markers = AGENT_SCREEN_MARKERS[kind];
  if (!markers) return '';
  const rows = cleanScreenRows(output);
  const busyRow = markerRow(rows, markers.busy);
  const backgroundRow = markerRow(rows, markers.background);
  let end = busyRow >= 0 ? busyRow : backgroundRow;
  if (end < 0) {
    if (!allowTail) return '';
    end = rows.findLastIndex((line) => line.trim());
  }
  if (end < 0) return '';

  // Qoder's pending history uses a different visual grammar from Codex and Claude:
  // "Thinking" and │ rails for reasoning, then ▫/▪/▸ rows for tool calls. Its
  // loading row sits above the composer and status bar. Treat that row as the lower
  // boundary and keep the current visible history above it instead of looking for the
  // •/● bullets used by the other Agent TUIs.
  if (kind === 'qodercli') {
    if (busyRow >= 0) return qoderLiveOutput(rows, end);
    if (allowTail) return qoderIdleOutput(rows);
  }

  const searchStart = Math.max(0, end - 18);
  let start = -1;
  for (let index = end - 1; index >= searchStart; index -= 1) {
    if (/^[•●]\s/.test(rows[index].trimStart())) {
      start = index;
      break;
    }
  }
  if (start < 0) {
    const separator = rows.slice(searchStart, end).findLastIndex((line) => SCREEN_SEPARATOR.test(line.trim()));
    start = separator >= 0 ? searchStart + separator + 1 : Math.max(searchStart, end - 4);
  }
  return compactLiveOutput(rows.slice(start, end + 1)).join('\n');
}

export function resolveAgentSessionLiveOutput(agent, hasRunningProcess, screenSignals, output) {
  if (!agent) return '';
  // Qoder history can lag or be unavailable when the CLI runs behind ssh, so keep its
  // bounded pane result after the spinner disappears instead of trusting the SDK alone.
  const keepVisible = agent.kind === 'qodercli';
  if (!keepVisible && !hasRunningProcess && agent.id) return '';
  return resolveAgentLiveOutput(agent.kind, output, {
    allowTail: keepVisible || !agent.id || Boolean(
      screenSignals?.animating && !screenSignals.busy && !screenSignals.background,
    ),
  });
}

// Shell sessions have no structured turn boundary, so expose only the bounded tail of
// the currently visible pane. This is the same screen a tmux client sees, not scrollback.
export function resolveShellLiveOutput(output) {
  const rows = cleanScreenRows(output);
  while (rows.length && !rows[0]) rows.shift();
  while (rows.length && !rows.at(-1)) rows.pop();
  return rows.slice(-LIVE_OUTPUT_MAX_LINES).map((line) => (
    line.length > LIVE_OUTPUT_MAX_LINE_LENGTH
      ? `${line.slice(0, LIVE_OUTPUT_MAX_LINE_LENGTH - 1)}…`
      : line
  )).join('\n');
}

export function resolveSlashCommandOutput(output) {
  const rows = cleanScreenRows(output);
  while (rows.length && !rows[0]) rows.shift();
  while (rows.length && !rows.at(-1)) rows.pop();
  const modalEnd = rows.findLastIndex((line) => /^\s*[╰└╚].*[╯┘╝]\s*$/u.test(line));
  const modalStart = modalEnd < 0 ? -1 : rows.slice(0, modalEnd)
    .findLastIndex((line) => /^\s*[╭┌╔].*[╮┐╗]\s*$/u.test(line));
  const visible = modalStart >= 0
    ? rows.slice(modalStart + 1, modalEnd).map((line) => {
      const content = /^\s*[│║](.*)[│║]\s*$/u.exec(line)?.[1];
      return content == null ? line.trim() : content.trim();
    })
    : rows.slice(-SLASH_OUTPUT_MAX_LINES);
  while (visible.length && !visible[0]) visible.shift();
  while (visible.length && !visible.at(-1)) visible.pop();
  return visible.slice(-SLASH_OUTPUT_MAX_LINES).map((line) => (
    line.length > LIVE_OUTPUT_MAX_LINE_LENGTH
      ? `${line.slice(0, LIVE_OUTPUT_MAX_LINE_LENGTH - 1)}…`
      : line
  )).join('\n');
}

// Where a marker sits on screen keeps moving: queued messages replace the interrupt hint,
// a custom statusline adds a row, and a modal such as /usage hides the footer outright.
// Whether the pane is repainting at all survives every one of those, and it needs no
// knowledge of the agent's interface, so it also covers agents we have never inspected.
// A working agent always animates something, at minimum the elapsed seconds in its
// spinner, while an idle pane is byte for byte identical between polls.
export function resolveScreenActivity(previous, output, now) {
  const hash = screenHash(output);
  if (!previous) return { hash, changedAt: 0 };
  return { hash, changedAt: previous.hash === hash ? previous.changedAt : now };
}

function screenHash(output) {
  return createHash('sha1').update(String(output || '')).digest('hex');
}

function capturePane(paneId, execTmux = exec) {
  if (!paneId) return Promise.resolve('');
  return execTmux('tmux', ['capture-pane', '-p', '-t', paneId]).then(({ stdout }) => stdout).catch(() => '');
}

function parsePaneCaptureBatch(output, markers) {
  const captures = [];
  let cursor = 0;
  for (const { begin, end } of markers) {
    const startMarker = `${begin}\n`;
    const start = output.indexOf(startMarker, cursor);
    const finish = output.indexOf(end, start + startMarker.length);
    if (start < 0 || finish < 0) return null;
    captures.push(output.slice(start + startMarker.length, finish));
    cursor = finish + end.length;
  }
  return captures;
}

export async function capturePanes(panes, execTmux = exec) {
  if (!panes.length) return [];
  const token = randomUUID();
  const markers = panes.map((_, index) => ({
    begin: `CODECK_CAPTURE:${token}:BEGIN:${index}`,
    end: `CODECK_CAPTURE:${token}:END:${index}`,
  }));
  const args = [];
  for (const [index, pane] of panes.entries()) {
    if (args.length) args.push(';');
    args.push(
      'display-message', '-p', markers[index].begin,
      ';', 'capture-pane', '-p', '-t', pane.paneId,
      ';', 'display-message', '-p', markers[index].end,
    );
  }
  try {
    const { stdout } = await execTmux('tmux', args, { maxBuffer: 8 * 1024 * 1024 });
    const captures = parsePaneCaptureBatch(stdout, markers);
    if (!captures) throw new Error('tmux batch capture was incomplete');
    return panes.map((pane, index) => [pane.session, captures[index]]);
  } catch {
    return Promise.all(panes.map(async (pane) => [
      pane.session, await capturePane(pane.paneId, execTmux),
    ]));
  }
}

function readScreenSignals(session, screen, markers, now) {
  const activity = resolveScreenActivity(screenActivity.get(session), screen, now);
  screenActivity.set(session, activity);
  const animating = now - activity.changedAt < SCREEN_ACTIVITY_WINDOW_MS;
  if (!markers) return { busy: false, background: false, animating };
  return { ...resolveScreenSignals(screen, markers), animating };
}

export function resolveWorkingState({ agentKind, screenSignals, paneCommands }) {
  if (agentKind) {
    // A detached task can outlive the turn that started it. It only keeps the Agent
    // foreground-busy while the Agent still renders a running turn; background-only
    // work is represented separately so it cannot enable the stop action.
    return Boolean(screenSignals?.busy || (screenSignals?.animating && !screenSignals?.background));
  }
  return (paneCommands || []).some((command) => !isShellCommand(command));
}

export function resolveAgentBackgroundState({ agent, screenSignals }) {
  return Boolean(agent && (agent.hasBackgroundProcess || screenSignals?.background));
}

export async function listSessions() {
  try {
    const [{ stdout }, { stdout: paneOutput }] = await Promise.all([
      exec('tmux', ['list-sessions', '-F', '#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_created}\t#{session_activity}\t#{window_width}\t#{window_height}\t#{status}']),
      exec('tmux', ['list-panes', '-a', '-F', '#{session_name}\t#{window_active}\t#{pane_active}\t#{pane_pid}\t#{pane_id}\t#{pane_current_command}\t#{window_activity}']),
    ]);
    const allPanes = parsePanes(paneOutput);
    const parsedSessions = mergeWindowActivity(parseSessions(stdout), allPanes);
    const panes = [...allPanes]
      .sort((a, b) => b.score - a.score)
      .filter((pane, index, all) => all.findIndex((item) => item.session === pane.session) === index);

    const paneCommandBySession = new Map();
    for (const pane of panes) paneCommandBySession.set(pane.session, pane.currentCommand);
    const paneBySession = new Map(panes.map((pane) => [pane.session, pane]));

    const paneCommandsBySession = new Map();
    for (const pane of allPanes) {
      const list = paneCommandsBySession.get(pane.session) || [];
      list.push(pane.currentCommand);
      paneCommandsBySession.set(pane.session, list);
    }

    const now = Date.now();
    const [agents, screens] = await Promise.all([
      detectPaneAgents(panes),
      capturePanes(panes),
    ]);
    const screenBySession = new Map(screens);

    // The process tree wins; the screen supplies a pending Agent when ssh hides it.
    const resolvedAgents = new Map();
    for (const pane of panes) {
      const agent = resolvePaneAgent(agents.get(pane.session), screenBySession.get(pane.session), pane);
      if (agent) resolvedAgents.set(pane.session, agent);
    }
    const agentKindBySession = new Map(
      [...resolvedAgents].map(([sessionName, agent]) => [sessionName, agent.kind]),
    );

    const screenSignalsBySession = new Map(
      [...screenBySession].map(([sessionName, screen]) => [
        sessionName,
        readScreenSignals(sessionName, screen, AGENT_SCREEN_MARKERS[agentKindBySession.get(sessionName)], now),
      ]),
    );
    for (const session of screenActivity.keys()) {
      if (!screenBySession.has(session)) screenActivity.delete(session);
    }

    return parsedSessions
      .map((session) => {
        const detectedAgent = resolvedAgents.get(session.name) || null;
        const agentKind = agentKindBySession.get(session.name) || null;
        const screenSignals = screenSignalsBySession.get(session.name);
        const hasRunningProcess = resolveWorkingState({
          agentKind,
          screenSignals,
          paneCommands: paneCommandsBySession.get(session.name) || [],
        });
        const hasBackgroundProcess = resolveAgentBackgroundState({
          agent: detectedAgent,
          screenSignals,
        });
        const activity = detectedAgent && hasRunningProcess
          ? resolveAgentActivityText(agentKind, screenBySession.get(session.name))
            || (screenSignals?.background ? '后台任务运行中' : '正在处理')
          : '';
        const liveOutput = resolveAgentSessionLiveOutput(
          detectedAgent, hasRunningProcess, screenSignals, screenBySession.get(session.name),
        );
        const agent = detectedAgent ? {
          ...detectedAgent,
          ...(hasBackgroundProcess ? { hasBackgroundProcess: true } : {}),
          ...(activity ? { activity } : {}),
          ...(liveOutput ? { liveOutput } : {}),
        } : null;
        const shellLiveOutput = !agent ? resolveShellLiveOutput(screenBySession.get(session.name)) : '';
        return {
          ...session,
          agent,
          paneId: paneBySession.get(session.name)?.paneId,
          ...(shellLiveOutput ? { liveOutput: shellLiveOutput } : {}),
          currentCommand: paneCommandBySession.get(session.name) || 'bash',
          hasRunningProcess,
        };
      })
      .sort((a, b) => Number(b.createdAt) - Number(a.createdAt) || a.name.localeCompare(b.name));
  } catch (error) {
    if (error.code === 1) return [];
    throw error;
  }
}

function loadTmuxBuffer(bufferName, text) {
  return new Promise((resolve, reject) => {
    const child = execFile('tmux', ['load-buffer', '-b', bufferName, '-'], (error) => {
      if (error) reject(error);
      else resolve();
    });
    child.stdin.on('error', reject);
    child.stdin.end(text);
  });
}

async function verifiedSessionPane({ provider, sessionName, threadId }, listTmuxSessions) {
  if (!validateClient(provider) || !validateSessionName(sessionName) || !THREAD_ID.test(threadId || '')) {
    throw new Error('会话信息无效，请刷新后重试');
  }
  const sessions = await listTmuxSessions();
  const session = sessions.find((candidate) => candidate.name === sessionName);
  if (!session) throw new Error('tmux 会话已不存在，请刷新后重试');

  if (provider === 'shell') {
    if (session.agent || threadId !== `tmux:shell:${sessionName}`) {
      throw new Error('tmux 会话与 Shell 对话不匹配，请刷新后重试');
    }
    if (!PANE_ID.test(session.paneId || '')) {
      throw new Error('无法安全确认 Shell pane，请刷新后重试');
    }
    return session.paneId;
  }

  if (!AGENT_CLIENTS.has(provider)) throw new Error('会话信息无效，请刷新后重试');
  const expectedThreadId = session.agent?.id || `tmux:${provider}:${sessionName}`;
  if (session.agent?.kind !== provider || expectedThreadId !== threadId) {
    throw new Error('tmux 会话与 Agent 对话不匹配，请刷新后重试');
  }
  if (!PANE_ID.test(session.agent.paneId || '')) {
    throw new Error('无法安全确认 Agent pane，请刷新后重试');
  }
  return session.agent.paneId;
}

let inputBufferSequence = 0;
const sessionInputQueues = new Map();
const PASTE_SUBMIT_DELAY_MS = 80;
const SLASH_OUTPUT_DELAY_MS = 150;
const SLASH_COMMAND_OUTPUT_COMMANDS = new Set(['/status', '/model']);

function queueSessionInput(sessionName, operation) {
  const previous = sessionInputQueues.get(sessionName) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  sessionInputQueues.set(sessionName, current);
  return current.then(
    (result) => {
      if (sessionInputQueues.get(sessionName) === current) sessionInputQueues.delete(sessionName);
      return result;
    },
    (error) => {
      if (sessionInputQueues.get(sessionName) === current) sessionInputQueues.delete(sessionName);
      throw error;
    },
  );
}

export async function sendSessionMessage({ provider, sessionName, threadId, text }, overrides = {}) {
  if (typeof text !== 'string' || !text.trim() || text.length > 100_000) throw new Error('消息内容无效');
  if (!validateSessionName(sessionName)) throw new Error('会话信息无效，请刷新后重试');
  return queueSessionInput(sessionName, async () => {
    const listTmuxSessions = overrides.listTmuxSessions || listSessions;
    const paneId = await verifiedSessionPane({ provider, sessionName, threadId }, listTmuxSessions);
    const execTmux = overrides.execTmux || ((args) => exec('tmux', args));
    const waitForPaste = overrides.waitForPaste
      || (() => new Promise((resolve) => setTimeout(resolve, PASTE_SUBMIT_DELAY_MS)));
    if (provider !== 'shell' && text.startsWith('/') && !/[\r\n]/.test(text)) {
      const command = text.trim().match(/^\/\S+/)?.[0] || '';
      await execTmux(['send-keys', '-l', '-t', paneId, text]);
      await waitForPaste();
      await execTmux(['send-keys', '-t', paneId, 'Enter']);
      if (!SLASH_COMMAND_OUTPUT_COMMANDS.has(command)) return {};
      const waitForSlashOutput = overrides.waitForSlashOutput
        || (() => new Promise((resolve) => setTimeout(resolve, SLASH_OUTPUT_DELAY_MS)));
      const captureSessionPane = overrides.capturePane || capturePane;
      try {
        await waitForSlashOutput();
        const screen = await captureSessionPane(paneId);
        const terminalOutput = resolveSlashCommandOutput(screen);
        const signals = resolveScreenSignals(screen, AGENT_SCREEN_MARKERS[provider]);
        if (!signals.busy && !signals.background) {
          // A local command redraw (for example /status or /model) is complete work, not Agent
          // animation. Seed that exact frame as the new idle baseline so the next
          // session poll does not turn the ready indicator yellow for six seconds.
          screenActivity.set(sessionName, { hash: screenHash(screen), changedAt: 0 });
        }
        return terminalOutput ? {
          terminalOutput,
          ...(signals.busy || signals.background ? { terminalWorking: true } : {}),
        } : {};
      } catch {
        // The command was already delivered. A failed best-effort capture must not turn
        // a successful local CLI action into a send error.
        return {};
      }
    }
    const bufferName = overrides.bufferName || `codeck_remote_${process.pid}_${++inputBufferSequence}`;
    const loadBuffer = overrides.loadBuffer || loadTmuxBuffer;
    await loadBuffer(bufferName, text);
    try {
      // Agent TUIs handle bracketed paste asynchronously. If Enter arrives in the same
      // tmux command, it can be consumed before the composer finishes applying the paste,
      // leaving the text visible but unsent. Separate the portable tmux 2.7 commands and
      // give the TUI one short processing window before submitting.
      await execTmux(['paste-buffer', '-p', '-d', '-b', bufferName, '-t', paneId]);
      await waitForPaste();
      await execTmux(['send-keys', '-t', paneId, 'Enter']);
    } catch (error) {
      await execTmux(['delete-buffer', '-b', bufferName]).catch(() => {});
      throw error;
    }
  });
}

export async function interruptSession({ provider, sessionName, threadId }, overrides = {}) {
  if (!validateSessionName(sessionName)) throw new Error('会话信息无效，请刷新后重试');
  return queueSessionInput(sessionName, async () => {
    const listTmuxSessions = overrides.listTmuxSessions || listSessions;
    const paneId = await verifiedSessionPane({ provider, sessionName, threadId }, listTmuxSessions);
    const execTmux = overrides.execTmux || ((args) => exec('tmux', args));
    await execTmux(['send-keys', '-t', paneId, provider === 'shell' ? 'C-c' : 'Escape']);
  });
}

export async function createSession({ name, client = 'shell', cwd }, execCommand = exec) {
  if (!validateSessionName(name)) throw new Error('会话名只能包含字母、数字、点、短横线或下划线，最长 64 个字符');
  if (!validateClient(client)) throw new Error('未知的终端类型');

  const args = ['new-session', '-d', '-s', name];
  if (cwd) args.push('-c', cwd);
  await execCommand('tmux', args);
  if (client !== 'shell') {
    const target = `${name}:0.0`;
    await execCommand('tmux', ['send-keys', '-l', '-t', target, resolveSessionClientCommand(client)]);
    await execCommand('tmux', ['send-keys', '-t', target, 'Enter']);
  }
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

// A single gesture should never be able to ask tmux for an unbounded scroll.
const MAX_SCROLL_LINES = 500;
// One in-flight scroll per session, so requests apply in the order they were made.
const scrollQueue = new Map();

export function clampViewport(cols, rows) {
  const viewport = clampTerminalGrid(cols, rows);
  return [viewport.cols, viewport.rows];
}

export function parseViewport(searchParams) {
  const width = Number(searchParams.get('cols'));
  const height = Number(searchParams.get('rows'));
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null;
  if (width <= 0 || height <= 0) return null;
  const [clampedWidth, clampedHeight] = clampViewport(width, height);
  return { width: clampedWidth, height: clampedHeight };
}

// tmux drives the outer terminal's alternate screen (verified: it emits ESC[?1049h on
// attach), and the alternate screen has no scrollback by definition — xterm's viewport
// has nothing to scroll, so scrollTop is inert no matter who handles the gesture. The
// history lives in tmux's copy mode, so scrolling has to be asked of tmux itself.
// Positive `lines` moves back into history.
export function scrollSession(name, lines) {
  // Scrolls must not overtake each other: tmux applies them in arrival order, and two in
  // flight at once can land reversed, so a drag stalls or jumps. Chain per session.
  const queued = (scrollQueue.get(name) || Promise.resolve())
    .then(() => runSessionScroll(name, lines))
    .catch(() => {});
  scrollQueue.set(name, queued);
  return queued;
}

async function runSessionScroll(name, lines) {
  if (!validateSessionName(name)) throw new Error('无效的会话名');
  const count = Math.min(Math.trunc(Math.abs(lines)), MAX_SCROLL_LINES);
  if (!count) return;
  if (lines > 0) {
    // copy-mode is idempotent here: re-entering while already in it keeps the current
    // scroll position rather than resetting it. `-e` makes tmux leave copy mode on its
    // own once the view is back at the bottom.
    await exec('tmux', ['copy-mode', '-e', '-t', name, ';', 'send-keys', '-X', '-t', name, '-N', String(count), 'scroll-up']);
    return;
  }
  // Scrolling forward is only meaningful inside copy mode; tmux answers "not in a mode"
  // otherwise, which is the no-op we want rather than an error worth surfacing.
  await exec('tmux', ['send-keys', '-X', '-t', name, '-N', String(count), 'scroll-down']).catch(() => {});
}

export async function getSessionSize(name) {
  if (!validateSessionName(name)) throw new Error('无效的会话名');
  const { stdout } = await exec('tmux', ['display-message', '-p', '-t', `${name}:`, '#{window_width}\t#{window_height}\t#{status}']);
  const [rawWidth, rawHeight, status] = stdout.trim().split('\t');
  return { width: Number(rawWidth), height: Number(rawHeight) + tmuxStatusRows(status) };
}
