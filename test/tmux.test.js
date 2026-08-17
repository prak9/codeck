import test from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_SCREEN_MARKERS, identifyAgentFromScreen, parseSessions, parseViewport, resolveScreenActivity, resolveScreenSignals, resolveWorkingState, supportsWindowSizeOption, validateClient, validateSessionName, withoutTmuxEnvironment } from '../src/tmux.js';

test('parses tmux list output into typed session records', () => {
  assert.deepEqual(parseSessions('agent-one\t2\t1\t100\t200\t180\t48\ton\n'), [{
    name: 'agent-one', windows: 2, attached: 1, createdAt: 100000, activityAt: 200000, width: 180, height: 49,
  }]);
});

test('empty tmux output produces an empty list', () => assert.deepEqual(parseSessions(''), []));

test('detects the tmux window-size option only on versions that have it', () => {
  assert.equal(supportsWindowSizeOption('tmux 2.7'), false);
  assert.equal(supportsWindowSizeOption('tmux 2.8'), false);
  assert.equal(supportsWindowSizeOption('tmux 2.9'), true);
  assert.equal(supportsWindowSizeOption('tmux 3.4'), true);
});

test('removes nested tmux markers from web terminal environments', () => {
  assert.deepEqual(withoutTmuxEnvironment({ PATH: '/bin', TMUX: '/tmp/tmux,1,0', TMUX_PANE: '%1' }), { PATH: '/bin' });
});

test('accepts safe session names and known clients', () => {
  assert.equal(validateSessionName('feature_auth-2.0'), true);
  assert.equal(validateClient('codex'), true);
  assert.equal(validateClient('qodercli'), true);
});

test('rejects names that could become tmux or shell arguments', () => {
  for (const name of ['', '-bad', 'two words', 'x;whoami', 'a'.repeat(65)]) assert.equal(validateSessionName(name), false);
  assert.equal(validateClient('bash -c whoami'), false);
});

// Screens below are verbatim captures from live panes, trimmed to the status area.
const CLAUDE_BUSY = `
✳ Perambulating… (3m 15s · ↓ 15.1k tokens)
  ⎿  Tip: Use /btw to ask a quick side question without interrupting Claude's current work

────────────────────────────────
❯
────────────────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt · ⇥ for agents
`;

// The footer drops "esc to interrupt" once messages are queued, and a custom statusline
// pushes the spinner further from the bottom, so only the spinner marks this one busy.
const CLAUDE_BUSY_WITH_QUEUED_MESSAGES = `
  Ran 1 shell command
● Running 1 shell command…
  ⎿  $ tmux capture-pane -p -t codeck
* Gesticulating… (1m 58s · ↓ 6.1k tokens)
  ⎿  Tip: Use /btw to ask a quick side question without interrupting Claude's current work
  ❯ /statusline
  ❯ /statusline
────────────────────────────────
❯ Press up to edit queued messages
────────────────────────────────
  x@lq-U2404Cal16:/data/code/codeck
  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents
`;

const CLAUDE_IDLE_WITH_STATUSLINE = `
✻ Cooked for 49s
────────────────────────────────
❯
────────────────────────────────
  x@lq-U2404Cal16:/home/x/py
  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents
`;

const CLAUDE_IDLE = `
✻ Worked for 45s
────────────────────────────────
❯
────────────────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents
`;

const CLAUDE_BACKGROUND = `
✻ Churned for 27s · 1 shell, 1 monitor still running
────────────────────────────────
❯
────────────────────────────────
  ⏵⏵ bypass permissions on · 1 shell, 1 monitor · ← for agents · ↓ to manage
`;

const CLAUDE_IDLE_AFTER_SHELL_TOOLS = `
  Ran 1 shell command
  Pushed to main, ran 1 shell command
✻ Worked for 45s
────────────────────────────────
❯
────────────────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents
`;

const CODEX_IDLE = `
› Use /skills to list available skills

  gpt-5.3-codex-spark xhigh · ~/py
`;

const CODEX_BACKGROUND = `
  1 background terminal running · /ps to view · /stop to close

› Use /skills to list available skills

  gpt-5.3-codex-spark xhigh · ~/py
`;

const signals = (output, kind) => resolveScreenSignals(output, AGENT_SCREEN_MARKERS[kind]);

test('reads the claude turn-in-flight marker from the footer', () => {
  assert.deepEqual(signals(CLAUDE_BUSY, 'claude'), { busy: true, background: false });
  assert.deepEqual(signals(CLAUDE_IDLE, 'claude'), { busy: false, background: false });
});

test('reads claude background tasks that outlive the turn', () => {
  assert.deepEqual(signals(CLAUDE_BACKGROUND, 'claude'), { busy: false, background: true });
});

test('transcript text mentioning shell commands does not count as background work', () => {
  assert.deepEqual(signals(CLAUDE_IDLE_AFTER_SHELL_TOOLS, 'claude'), { busy: false, background: false });
});

test('reads the codex run state and background terminals', () => {
  assert.deepEqual(signals(CODEX_IDLE, 'codex'), { busy: false, background: false });
  assert.deepEqual(signals(CODEX_BACKGROUND, 'codex'), { busy: false, background: true });
  assert.equal(signals('• Working (12s · Esc to interrupt)', 'codex').busy, true);
});

test('a completed claude turn is not mistaken for the codex working state', () => {
  assert.equal(signals(CLAUDE_IDLE, 'codex').busy, false);
});

test('agent sessions are working while the agent runs or owns background tasks', () => {
  const working = (screenSignals) => resolveWorkingState({ agentKind: 'claude', screenSignals, paneCommands: ['bash'] });
  assert.equal(working({ busy: true, background: false }), true);
  assert.equal(working({ busy: false, background: true }), true);
  assert.equal(working({ busy: false, background: false }), false);
  assert.equal(working(undefined), false);
});

test('plain shell sessions are working while a pane runs something other than a shell', () => {
  const working = (paneCommands) => resolveWorkingState({ agentKind: null, paneCommands });
  assert.equal(working(['bash']), false);
  assert.equal(working(['bash', 'make']), true);
  assert.equal(working(['/usr/bin/zsh']), false);
  assert.equal(working([]), false);
});

test('an idle python REPL in an agent pane no longer forces the working state', () => {
  assert.equal(resolveWorkingState({
    agentKind: 'claude',
    screenSignals: { busy: false, background: false },
    paneCommands: ['python3'],
  }), false);
});

test('the spinner marks a turn busy when the footer hint is gone', () => {
  assert.deepEqual(signals(CLAUDE_BUSY_WITH_QUEUED_MESSAGES, 'claude'), { busy: true, background: false });
});

test('a finished turn reads as idle even behind a custom statusline', () => {
  assert.deepEqual(signals(CLAUDE_IDLE_WITH_STATUSLINE, 'claude'), { busy: false, background: false });
});

test('past-tense turn summaries are not spinners', () => {
  for (const line of ['✻ Worked for 45s', '✻ Cooked for 49s', '✻ Churned for 27s · 1 shell, 1 monitor still running']) {
    assert.equal(signals(line, 'claude').busy, false, line);
  }
});

test('a widened busy window still ignores shell commands named in the transcript', () => {
  assert.equal(signals(CLAUDE_BUSY_WITH_QUEUED_MESSAGES, 'claude').background, false);
  assert.equal(signals(CLAUDE_IDLE_AFTER_SHELL_TOOLS, 'claude').background, false);
});

test('screen activity only counts a pane as animating once it actually changes', () => {
  const first = resolveScreenActivity(undefined, 'frame one', 1_000);
  assert.equal(first.changedAt, 0, 'a pane seen once has nothing to compare against');

  const unchanged = resolveScreenActivity(first, 'frame one', 2_000);
  assert.equal(unchanged.changedAt, 0);
  assert.equal(unchanged.hash, first.hash);

  const changed = resolveScreenActivity(unchanged, 'frame two', 3_000);
  assert.equal(changed.changedAt, 3_000);

  const stillChanged = resolveScreenActivity(changed, 'frame two', 4_000);
  assert.equal(stillChanged.changedAt, 3_000, 'the timestamp holds until the next change');
});

test('a repainting pane is working even when no marker is visible', () => {
  const working = (screenSignals) => resolveWorkingState({ agentKind: 'qodercli', screenSignals, paneCommands: ['bash'] });
  assert.equal(working({ busy: false, background: false, animating: true }), true);
  assert.equal(working({ busy: false, background: false, animating: false }), false);
});

test('a modal hiding the footer does not lose a busy session', () => {
  // /usage covers the footer, so both markers miss and only the repaint remains.
  const usageModal = `
   Subagents               % of usage
   Explore                         3%
   d to day · w to week
   Esc to cancel
`;
  assert.deepEqual(signals(usageModal, 'claude'), { busy: false, background: false });
  assert.equal(resolveWorkingState({
    agentKind: 'claude',
    screenSignals: { ...signals(usageModal, 'claude'), animating: true },
    paneCommands: ['bash'],
  }), true);
});

// Verbatim qodercli footer, generating and idle.
const QODER_BUSY = `
  Files changed: 3
⠋ Generating... (esc to cancel, 25s)
`;

const QODER_IDLE = `
  Files changed: 3
  Ready
`;

test('reads the qodercli generating footer', () => {
  assert.equal(signals(QODER_BUSY, 'qodercli').busy, true);
  assert.equal(signals(QODER_IDLE, 'qodercli').busy, false);
});

test('the qodercli spinner is not mistaken for claude or codex output', () => {
  assert.equal(signals(QODER_BUSY, 'claude').busy, false);
  assert.equal(signals(QODER_BUSY, 'codex').busy, false);
});

test('viewport is taken from the connect URL and floored, or absent', () => {
  const at = (query) => parseViewport(new URLSearchParams(query));
  assert.deepEqual(at('cols=100&rows=30'), { width: 100, height: 30 });
  assert.deepEqual(at('cols=4&rows=2'), { width: 20, height: 5 }, 'floors keep tmux usable');
  assert.equal(at('session=x'), null, 'a client that reports no size falls back to tmux');
  assert.equal(at('cols=abc&rows=30'), null);
  assert.equal(at('cols=0&rows=0'), null);
  assert.equal(at('cols=100.5&rows=30'), null);
});

test('an agent behind an ssh hop is named from its status bar', () => {
  const qoderOverSsh = `
  src/main.rs
  · ctx ▓▓░ 27% ·
`;
  assert.equal(identifyAgentFromScreen(qoderOverSsh), 'qodercli');
  assert.equal(identifyAgentFromScreen(CLAUDE_IDLE), null, 'claude is found in the process tree');
  assert.equal(identifyAgentFromScreen(CODEX_IDLE), null);
  assert.equal(identifyAgentFromScreen(''), null);
});

test('a cancel prompt without a timer is not a qodercli turn', () => {
  assert.equal(signals('⠋ Generating... (esc to cancel, 25s)', 'qodercli').busy, true);
  assert.equal(signals('Delete this file? (enter to confirm, esc to cancel)', 'qodercli').busy, false);
});
