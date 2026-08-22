import test from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_SCREEN_MARKERS, findLinkedWindowSessions, identifyAgentFromScreen, interruptSession, parseSessions, parseViewport, resolveAgentActivityText, resolveAgentLiveOutput, resolveAgentSessionLiveOutput, resolveScreenActivity, resolveScreenSignals, resolveShellLiveOutput, resolveWorkingState, sendSessionMessage, supportsWindowSizeOption, validateClient, validateSessionName, withoutTmuxEnvironment } from '../src/tmux.js';

test('parses tmux list output into typed session records', () => {
  assert.deepEqual(parseSessions('agent-one\t2\t1\t100\t200\t180\t48\ton\n'), [{
    name: 'agent-one', windows: 2, attached: 1, createdAt: 100000, activityAt: 200000, width: 180, height: 49,
  }]);
});

test('sends a message only to the exact verified Agent pane with tmux 2.7-compatible commands', async () => {
  const calls = [];
  await sendSessionMessage({ provider: 'claude', sessionName: 'work', threadId: 'thread-1', text: 'Review\nmobile' }, {
    listTmuxSessions: async () => [{
      name: 'work', agent: { kind: 'claude', id: 'thread-1', paneId: '%7' },
    }],
    bufferName: 'codeck-test',
    loadBuffer: async (bufferName, text) => calls.push({ type: 'load', bufferName, text }),
    execTmux: async (args) => calls.push({ type: 'exec', args }),
  });

  assert.deepEqual(calls, [
    { type: 'load', bufferName: 'codeck-test', text: 'Review\nmobile' },
    {
      type: 'exec',
      args: [
        'paste-buffer', '-p', '-d', '-b', 'codeck-test', '-t', '%7',
        ';', 'send-keys', '-t', '%7', 'Enter',
      ],
    },
  ]);
});

test('allows only the server-derived pending thread id before an Agent exposes its persistent id', async () => {
  const calls = [];
  let agent = { kind: 'codex', id: null, paneId: '%7' };
  const options = {
    listTmuxSessions: async () => [{ name: 'codeck', agent }],
    bufferName: 'codeck-pending-test',
    loadBuffer: async (bufferName, text) => calls.push({ type: 'load', bufferName, text }),
    execTmux: async (args) => calls.push({ type: 'exec', args }),
  };

  await sendSessionMessage({
    provider: 'codex', sessionName: 'codeck', threadId: 'tmux:codex:codeck', text: 'Start work',
  }, options);
  await interruptSession({
    provider: 'codex', sessionName: 'codeck', threadId: 'tmux:codex:codeck',
  }, options);

  await assert.rejects(() => sendSessionMessage({
    provider: 'codex', sessionName: 'codeck', threadId: 'tmux:codex:other', text: 'Wrong target',
  }, options), /匹配|刷新/);
  agent = { ...agent, id: 'thread-1' };
  await assert.rejects(() => sendSessionMessage({
    provider: 'codex', sessionName: 'codeck', threadId: 'tmux:codex:codeck', text: 'Stale target',
  }, options), /匹配|刷新/);

  assert.deepEqual(calls, [
    { type: 'load', bufferName: 'codeck-pending-test', text: 'Start work' },
    {
      type: 'exec',
      args: [
        'paste-buffer', '-p', '-d', '-b', 'codeck-pending-test', '-t', '%7',
        ';', 'send-keys', '-t', '%7', 'Enter',
      ],
    },
    { type: 'exec', args: ['send-keys', '-t', '%7', 'Escape'] },
  ]);
});

test('refuses stale or unsafe Agent pane mappings before sending anything', async () => {
  const calls = [];
  const options = {
    listTmuxSessions: async () => [{
      name: 'work', agent: { kind: 'codex', id: 'thread-1', paneId: '%7' },
    }],
    loadBuffer: async () => calls.push('load'),
    execTmux: async () => calls.push('exec'),
  };
  await assert.rejects(() => sendSessionMessage({
    provider: 'codex', sessionName: 'work', threadId: 'other-thread', text: 'hello',
  }, options), /匹配|刷新/);
  await assert.rejects(() => sendSessionMessage({
    provider: 'claude', sessionName: 'work', threadId: 'thread-1', text: 'hello',
  }, options), /匹配|刷新/);
  await assert.rejects(() => sendSessionMessage({
    provider: 'codex', sessionName: 'work', threadId: 'thread-1', text: 'hello',
  }, {
    ...options,
    listTmuxSessions: async () => [{
      name: 'work', agent: { kind: 'codex', id: 'thread-1', paneId: 'work:0.0' },
    }],
  }), /pane|刷新/i);
  assert.deepEqual(calls, []);
});

test('interrupts the exact verified Agent pane with Escape', async () => {
  const calls = [];
  await interruptSession({ provider: 'qodercli', sessionName: 'work', threadId: 'thread-1' }, {
    listTmuxSessions: async () => [{
      name: 'work', agent: { kind: 'qodercli', id: 'thread-1', paneId: '%42' },
    }],
    execTmux: async (args) => calls.push(args),
  });
  assert.deepEqual(calls, [['send-keys', '-t', '%42', 'Escape']]);
});

test('sends shell input and Ctrl-C only to the exact verified shell pane', async () => {
  const calls = [];
  const options = {
    listTmuxSessions: async () => [{ name: 'shell-work', paneId: '%9', agent: null }],
    bufferName: 'codeck-shell-test',
    loadBuffer: async (bufferName, text) => calls.push({ type: 'load', bufferName, text }),
    execTmux: async (args) => calls.push({ type: 'exec', args }),
  };

  await sendSessionMessage({
    provider: 'shell', sessionName: 'shell-work', threadId: 'tmux:shell:shell-work', text: 'pwd',
  }, options);
  await interruptSession({
    provider: 'shell', sessionName: 'shell-work', threadId: 'tmux:shell:shell-work',
  }, options);

  assert.deepEqual(calls, [
    { type: 'load', bufferName: 'codeck-shell-test', text: 'pwd' },
    {
      type: 'exec',
      args: [
        'paste-buffer', '-p', '-d', '-b', 'codeck-shell-test', '-t', '%9',
        ';', 'send-keys', '-t', '%9', 'Enter',
      ],
    },
    { type: 'exec', args: ['send-keys', '-t', '%9', 'C-c'] },
  ]);
});

test('refuses a stale shell mapping after the pane becomes an Agent session', async () => {
  const calls = [];
  const options = {
    listTmuxSessions: async () => [{
      name: 'shell-work', paneId: '%9',
      agent: { kind: 'codex', id: 'thread-1', paneId: '%9' },
    }],
    loadBuffer: async () => calls.push('load'),
    execTmux: async () => calls.push('exec'),
  };

  await assert.rejects(() => sendSessionMessage({
    provider: 'shell', sessionName: 'shell-work', threadId: 'tmux:shell:shell-work', text: 'pwd',
  }, options), /匹配|刷新/);
  await assert.rejects(() => sendSessionMessage({
    provider: 'shell', sessionName: 'shell-work', threadId: 'tmux:shell:other', text: 'pwd',
  }, { ...options, listTmuxSessions: async () => [{ name: 'shell-work', paneId: '%9', agent: null }] }), /匹配|刷新/);

  assert.deepEqual(calls, []);
});

test('serializes concurrent input for the same tmux session', async () => {
  let listCalls = 0;
  let releaseFirstList;
  let markFirstListStarted;
  const firstListStarted = new Promise((resolve) => { markFirstListStarted = resolve; });
  const firstListGate = new Promise((resolve) => { releaseFirstList = resolve; });
  const loaded = [];
  const options = {
    listTmuxSessions: async () => {
      listCalls += 1;
      if (listCalls === 1) {
        markFirstListStarted();
        await firstListGate;
      }
      return [{ name: 'work', agent: { kind: 'codex', id: 'thread-1', paneId: '%7' } }];
    },
    loadBuffer: async (_bufferName, text) => loaded.push(text),
    execTmux: async () => {},
  };

  const first = sendSessionMessage({
    provider: 'codex', sessionName: 'work', threadId: 'thread-1', text: 'first',
  }, options);
  await firstListStarted;
  const second = sendSessionMessage({
    provider: 'codex', sessionName: 'work', threadId: 'thread-1', text: 'second',
  }, options);
  await new Promise((resolve) => setImmediate(resolve));
  const loadedBeforeRelease = [...loaded];
  releaseFirstList();
  await Promise.all([first, second]);

  assert.deepEqual(loadedBeforeRelease, []);
  assert.deepEqual(loaded, ['first', 'second']);
});

test('tmux 2.7 numeric status values still reserve the status row', () => {
  assert.equal(parseSessions('legacy\t1\t1\t100\t200\t80\t23\t1\n')[0].height, 24);
  assert.equal(parseSessions('legacy\t1\t1\t100\t200\t80\t23\t0\n')[0].height, 23);
});

test('modern multi-line status values reserve every status row', () => {
  assert.equal(parseSessions('multi\t1\t1\t100\t200\t80\t22\t2\n')[0].height, 24);
  assert.equal(parseSessions('multi\t1\t1\t100\t200\t80\t1\t5\n')[0].height, 6);
});

test('empty tmux output produces an empty list', () => assert.deepEqual(parseSessions(''), []));

test('detects the tmux window-size option only on versions that have it', () => {
  assert.equal(supportsWindowSizeOption('tmux 2.7'), false);
  assert.equal(supportsWindowSizeOption('tmux 2.8'), false);
  assert.equal(supportsWindowSizeOption('tmux 2.9'), true);
  assert.equal(supportsWindowSizeOption('tmux 3.4'), true);
});

test('finds every other session linked to the active window', () => {
  const windows = [
    'phone\t@1\t1',
    'peer-a\t@1\t1',
    'peer-a\t@2\t0',
    'peer-b\t@1\t0',
    'other\t@3\t1',
  ].join('\n');
  assert.deepEqual(findLinkedWindowSessions(windows, 'phone'), ['peer-a', 'peer-b']);
  assert.deepEqual(findLinkedWindowSessions(windows, 'other'), []);
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

test('describes live terminal Agent activity without exposing pane content', () => {
  assert.equal(resolveAgentActivityText('codex', `
• Explored
  └ Read remote.js
◦ Working (25s • esc to interrupt)
`), '正在查看文件 · 25秒');
  assert.equal(resolveAgentActivityText('codex', `
• Ran npm test
◦ Working (1m 08s • esc to interrupt)
`), '正在运行命令 · 1分08秒');
  assert.equal(resolveAgentActivityText('claude', `
● Running 1 shell command…
✳ Gesticulating… (1m 58s · ↓ 6.1k tokens)
`), '正在运行命令 · 1分58秒');
  assert.equal(resolveAgentActivityText('qodercli', '⠋ Generating... (esc to cancel, 25s)'), '正在生成 · 25秒');
  assert.equal(resolveAgentActivityText('codex', '• Ran npm test\n› Follow up'), '');
});

test('extracts the exact current activity block shown in the tmux pane', () => {
  const codexPane = `
• Explored
  └ Read old.js

────────────────

\x1b[33m• Ran node --test\x1b[0m
  └ TAP version 13
    ok 1 - mobile state

◦ Working (25s • esc to interrupt)

» Explain this codebase
  gpt-5.6-codex · /data/code/codeck
`;
  assert.equal(resolveAgentLiveOutput('codex', codexPane), [
    '• Ran node --test',
    '  └ TAP version 13',
    '    ok 1 - mobile state',
    '',
    '◦ Working (25s • esc to interrupt)',
  ].join('\n'));

  const claudePane = `
● Running 1 shell command…
  ⎿  $ npm test
✳ Gesticulating… (1m 58s · ↓ 6.1k tokens)
────────────────
❯
`;
  assert.equal(resolveAgentLiveOutput('claude', claudePane), [
    '● Running 1 shell command…',
    '  ⎿  $ npm test',
    '✳ Gesticulating… (1m 58s · ↓ 6.1k tokens)',
  ].join('\n'));

  assert.equal(resolveAgentLiveOutput('qodercli', `
  Files changed: 3
⠋ Generating... (esc to cancel, 25s)
`), [
    '  Files changed: 3',
    '⠋ Generating... (esc to cancel, 25s)',
  ].join('\n'));

  assert.equal(resolveAgentLiveOutput('codex', '• Ran npm test\n› Follow up'), '');
});

test('extracts a bounded clean tail from a visible shell pane', () => {
  const pane = Array.from({ length: 14 }, (_, index) => (
    index === 13 ? '\x1b[31mline-14\x1b[0m\u0007' : `line-${index + 1}`
  )).join('\n');
  assert.equal(resolveShellLiveOutput(pane), Array.from({ length: 12 }, (_, index) => `line-${index + 3}`).join('\n'));

  const clipped = resolveShellLiveOutput('x'.repeat(400));
  assert.equal(clipped.length, 320);
  assert.equal(clipped.endsWith('…'), true);
});

test('shows the visible tail when a repainting Agent modal hides its busy marker', () => {
  const modal = `
────────────
 Subagents               % of usage
 Explore                         3%
 d to day · w to week
 Esc to cancel
`;
  assert.equal(resolveAgentLiveOutput('claude', modal, { allowTail: true }), [
    ' Subagents               % of usage',
    ' Explore                         3%',
    ' d to day · w to week',
    ' Esc to cancel',
  ].join('\n'));
  assert.equal(resolveAgentLiveOutput('claude', '─'.repeat(24), { allowTail: true }), '');
});

test('keeps terminal output available while an Agent thread id is unresolved', () => {
  const idlePane = '• Ran npm test\n  └ 115 tests passed\n› Follow up';
  const idleSignals = { busy: false, background: false, animating: false };

  assert.equal(resolveAgentSessionLiveOutput(
    { kind: 'codex', id: null }, false, idleSignals, idlePane,
  ), idlePane);
  assert.equal(resolveAgentSessionLiveOutput(
    { kind: 'codex', id: 'thread-1' }, false, idleSignals, idlePane,
  ), '');
  assert.equal(resolveAgentSessionLiveOutput(null, false, idleSignals, idlePane), '');
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
  assert.deepEqual(at('cols=4&rows=2'), { width: 20, height: 6 }, 'six rows leave one pane row above tmux\'s five-line status maximum');
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
