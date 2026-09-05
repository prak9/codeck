import test from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_SCREEN_MARKERS, ensureAgentInputSubmitted, capturePanes, capturePaneSnapshots, createSession, createSessionScrollQueue, findLinkedWindowSessions, identifyAgentFromScreen, interruptSession, mergeWindowActivity, parsePanes, parseSessions, parseViewport, resolveAgentActivityText, resolveAgentBackgroundState, resolveAgentLiveOutput, resolveAgentSessionLiveOutput, resolvePaneAgent, resolveScreenActivity, resolveScreenSignals, resolveSessionClientCommand, resolveShellLiveOutput, resolveSlashCommandOutput, resolveWorkingState, selectSessionModel, sendSessionMessage, supportsWindowSizeOption, validateClient, validateSessionName, withoutTmuxEnvironment } from '../src/tmux.js';

test('parses tmux list output into typed session records', () => {
  assert.deepEqual(parseSessions('agent-one\t2\t1\t100\t200\t180\t48\ton\n'), [{
    name: 'agent-one', windows: 2, attached: 1, createdAt: 100000, activityAt: 200000, width: 180, height: 49,
  }]);
});

test('uses the latest window activity as the session activity time', () => {
  const sessions = [
    { name: 'work', activityAt: 200_000 },
    { name: 'recent-session', activityAt: 500_000 },
  ];
  const panes = [
    { session: 'work', windowActivityAt: 300_000 },
    { session: 'work', windowActivityAt: 400_000 },
    { session: 'recent-session', windowActivityAt: 450_000 },
    { session: 'other', windowActivityAt: 900_000 },
  ];

  assert.deepEqual(mergeWindowActivity(sessions, panes), [
    { name: 'work', activityAt: 400_000 },
    { name: 'recent-session', activityAt: 500_000 },
  ]);
});

test('parses tmux window activity from pane records', () => {
  assert.deepEqual(parsePanes('work\t1\t1\t42\t%7\tbash\t300\n'), [{
    session: 'work', pid: 42, paneId: '%7', score: 2, currentCommand: 'bash', windowActivityAt: 300_000,
  }]);
});

test('coalesces touch-scroll updates while the previous tmux scroll is in flight', async () => {
  const calls = [];
  let releaseFirst;
  let markFirstStarted;
  const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
  const scroll = createSessionScrollQueue(async (session, lines) => {
    calls.push({ session, lines });
    if (calls.length === 1) {
      markFirstStarted();
      await new Promise((resolve) => { releaseFirst = resolve; });
    }
  });

  const first = scroll('work', 3);
  await firstStarted;
  const second = scroll('work', 4);
  const third = scroll('work', 5);
  const correction = scroll('work', -2);
  assert.deepEqual(calls, [{ session: 'work', lines: 3 }]);

  releaseFirst();
  await Promise.all([first, second, third, correction]);
  assert.deepEqual(calls, [
    { session: 'work', lines: 3 },
    { session: 'work', lines: 7 },
  ]);
});

test('captures all selected panes through one tmux process', async () => {
  const calls = [];
  const panes = [
    { session: 'alpha', paneId: '%1' },
    { session: 'beta', paneId: '%2' },
  ];
  const captures = await capturePanes(panes, async (command, args) => {
    calls.push({ command, args });
    const markers = args.filter((value) => /^CODECK_CAPTURE:[^:]+:(?:BEGIN|END):\d+$/.test(value));
    return {
      stdout: `${markers[0]}\nalpha output\n${markers[1]}\n${markers[2]}\nbeta 中文\n${markers[3]}\n`,
    };
  });

  assert.deepEqual(captures, [
    ['alpha', 'alpha output\n'],
    ['beta', 'beta 中文\n'],
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'tmux');
  assert.equal(calls[0].args.filter((value) => value === 'capture-pane').length, 2);
});

test('reuses idle pane snapshots and captures only activity changes or working sessions', async () => {
  const cache = new Map();
  const batches = [];
  const capture = async (panes) => {
    batches.push(panes.map((pane) => pane.session));
    return panes.map((pane) => [pane.session, `${pane.session}:${pane.windowActivityAt}`]);
  };
  const panes = [
    { session: 'one', paneId: '%1', pid: 10, currentCommand: 'bash', windowActivityAt: 1_000 },
    { session: 'two', paneId: '%2', pid: 20, currentCommand: 'bash', windowActivityAt: 1_000 },
  ];

  assert.deepEqual(await capturePaneSnapshots(panes, { cache, capture, now: 10_000 }), [
    ['one', 'one:1000'], ['two', 'two:1000'],
  ]);
  assert.deepEqual(await capturePaneSnapshots(panes, { cache, capture, now: 11_000 }), [
    ['one', 'one:1000'], ['two', 'two:1000'],
  ]);

  cache.get('one').working = true;
  panes[1] = { ...panes[1], windowActivityAt: 2_000 };
  assert.deepEqual(await capturePaneSnapshots(panes, { cache, capture, now: 12_000 }), [
    ['one', 'one:1000'], ['two', 'two:2000'],
  ]);
  assert.deepEqual(batches, [['one', 'two'], ['one', 'two']]);
});

test('recent tmux activity keeps a short capture grace window within timestamp resolution', async () => {
  const cache = new Map();
  const batches = [];
  const capture = async (panes) => {
    batches.push(panes.map((pane) => pane.session));
    return panes.map((pane) => [pane.session, 'screen']);
  };
  const panes = [{
    session: 'one', paneId: '%1', pid: 10,
    currentCommand: 'bash', windowActivityAt: 1_000,
  }];

  await capturePaneSnapshots(panes, { cache, capture, now: 1_500 });
  await capturePaneSnapshots(panes, { cache, capture, now: 2_000 });
  await capturePaneSnapshots(panes, { cache, capture, now: 4_000 });
  assert.deepEqual(batches, [['one'], ['one']]);
});

test('pane snapshot safety audits are staggered and forced refreshes bypass the cache', async () => {
  const cache = new Map();
  const batches = [];
  const capture = async (panes) => {
    batches.push(panes.map((pane) => pane.session));
    return panes.map((pane) => [pane.session, `screen:${pane.session}`]);
  };
  const panes = ['one', 'two', 'three'].map((session, index) => ({
    session, paneId: `%${index + 1}`, pid: index + 1,
    currentCommand: 'bash', windowActivityAt: 1_000,
  }));

  await capturePaneSnapshots(panes, { cache, capture, now: 1_000, auditAfterMs: 10_000, auditLimit: 1 });
  await capturePaneSnapshots(panes, { cache, capture, now: 12_000, auditAfterMs: 10_000, auditLimit: 1 });
  await capturePaneSnapshots(panes, { cache, capture, now: 12_100, auditAfterMs: 10_000, auditLimit: 1 });
  await capturePaneSnapshots(panes, { cache, capture, now: 12_200, force: true });
  await capturePaneSnapshots(panes, {
    cache, capture, now: 12_300, forceSessions: new Set(['two']),
  });

  assert.deepEqual(batches, [
    ['one', 'two', 'three'],
    ['one'],
    ['two'],
    ['one', 'two', 'three'],
    ['two'],
  ]);
});

test('falls back to isolated pane captures when a batched capture cannot be parsed', async () => {
  const calls = [];
  const captures = await capturePanes([
    { session: 'alpha', paneId: '%1' },
    { session: 'beta', paneId: '%2' },
  ], async (_command, args) => {
    calls.push(args);
    if (args.includes('display-message')) return { stdout: 'incomplete batch' };
    return { stdout: args.at(-1) === '%1' ? 'alpha\n' : 'beta\n' };
  });

  assert.deepEqual(captures, [
    ['alpha', 'alpha\n'],
    ['beta', 'beta\n'],
  ]);
  assert.equal(calls.length, 3);
});

test('waits for an Agent to process bracketed paste before submitting from a detached pane', async () => {
  const calls = [];
  await sendSessionMessage({ provider: 'claude', sessionName: 'work', threadId: 'thread-1', text: 'Review\nmobile' }, {
    listTmuxSessions: async () => [{
      name: 'work', agent: { kind: 'claude', id: 'thread-1', paneId: '%7' },
    }],
    bufferName: 'codeck-test',
    invalidatePaneSnapshot: (sessionName) => calls.push({ type: 'invalidate', sessionName }),
    loadBuffer: async (bufferName, text) => calls.push({ type: 'load', bufferName, text }),
    execTmux: async (args) => calls.push({ type: 'exec', args }),
    waitForPaste: async () => calls.push({ type: 'wait' }),
  });

  assert.deepEqual(calls, [
    { type: 'invalidate', sessionName: 'work' },
    { type: 'load', bufferName: 'codeck-test', text: 'Review\nmobile' },
    {
      type: 'exec',
      args: ['copy-mode', '-q', '-t', '%7', ';', 'paste-buffer', '-p', '-d', '-b', 'codeck-test', '-t', '%7'],
    },
    { type: 'wait' },
    { type: 'exec', args: ['copy-mode', '-q', '-t', '%7', ';', 'send-keys', '-t', '%7', 'Enter'] },
  ]);
});

test('submits ordinary single-line Agent input atomically so terminal replies cannot enter the draft', async () => {
  const calls = [];
  await sendSessionMessage({
    provider: 'codex', sessionName: 'research', threadId: 'thread-1', text: '提交',
  }, {
    listTmuxSessions: async () => [{
      name: 'research', agent: { kind: 'codex', id: 'thread-1', paneId: '%7' },
    }],
    bufferName: 'codeck-test',
    loadBuffer: async (bufferName, text) => calls.push({ type: 'load', bufferName, text }),
    execTmux: async (args) => calls.push({ type: 'exec', args }),
    waitForPaste: async () => calls.push({ type: 'wait' }),
  });

  assert.deepEqual(calls, [
    { type: 'load', bufferName: 'codeck-test', text: '提交' },
    {
      type: 'exec',
      args: [
        'copy-mode', '-q', '-t', '%7', ';',
        'paste-buffer', '-d', '-b', 'codeck-test', '-t', '%7', ';',
        'send-keys', '-t', '%7', 'Enter',
      ],
    },
  ]);
});

test('exits detached copy mode atomically before sending Claude input', async () => {
  const calls = [];
  await sendSessionMessage({
    provider: 'claude', sessionName: 'work', threadId: 'thread-1', text: 'Continue',
  }, {
    listTmuxSessions: async () => [{
      name: 'work', agent: { kind: 'claude', id: 'thread-1', paneId: '%7' },
    }],
    bufferName: 'codeck-claude-test',
    loadBuffer: async (bufferName, text) => calls.push(['load-buffer', bufferName, text]),
    execTmux: async (args) => calls.push(args),
    waitForPaste: async () => {},
  });

  assert.deepEqual(calls, [
    ['load-buffer', 'codeck-claude-test', 'Continue'],
    [
      'copy-mode', '-q', '-t', '%7', ';',
      'paste-buffer', '-d', '-b', 'codeck-claude-test', '-t', '%7', ';',
      'send-keys', '-t', '%7', 'Enter',
    ],
  ]);
});

test('reports when Claude input was submitted while the current turn was still running', async () => {
  const result = await sendSessionMessage({
    provider: 'claude', sessionName: 'work', threadId: 'thread-1', text: 'Keep going',
  }, {
    listTmuxSessions: async () => [{
      name: 'work', hasRunningProcess: true,
      agent: { kind: 'claude', id: 'thread-1', paneId: '%7' },
    }],
    bufferName: 'codeck-claude-running-test',
    loadBuffer: async () => {},
    execTmux: async () => {},
    waitForPaste: async () => {},
  });

  assert.deepEqual(result, { inputWasQueued: true });
});

test('releases Codex input queued behind a background terminal wait', async () => {
  const calls = [];
  const screens = [
    '• Waiting for background terminal (2h 04m)\n› Write tests for @filename',
    [
      '• Waiting for background terminal (2h 04m)',
      '• Messages to be submitted after',
      '  next tool call (press esc to',
      '  interrupt and send immediately)',
      '  ↳ 怎么样了',
    ].join('\n'),
  ];
  const result = await sendSessionMessage({
    provider: 'codex', sessionName: 'research', threadId: 'thread-1', text: '怎么样了',
  }, {
    listTmuxSessions: async () => [{
      name: 'research',
      agent: {
        kind: 'codex', id: 'thread-1', paneId: '%7', hasBackgroundProcess: true,
      },
    }],
    bufferName: 'codeck-queued-test',
    loadBuffer: async (bufferName, text) => calls.push({ type: 'load', bufferName, text }),
    execTmux: async (args) => calls.push({ type: 'exec', args }),
    waitForPaste: async () => calls.push({ type: 'paste-wait' }),
    waitForQueuedInput: async () => calls.push({ type: 'queue-wait' }),
    capturePane: async (paneId) => {
      calls.push({ type: 'capture', paneId });
      return screens.shift();
    },
  });

  assert.deepEqual(result, { terminalWorking: true });
  assert.deepEqual(calls, [
    { type: 'load', bufferName: 'codeck-queued-test', text: '怎么样了' },
    {
      type: 'exec',
      args: [
        'copy-mode', '-q', '-t', '%7', ';',
        'paste-buffer', '-d', '-b', 'codeck-queued-test', '-t', '%7', ';',
        'send-keys', '-t', '%7', 'Enter',
      ],
    },
    { type: 'queue-wait' },
    { type: 'capture', paneId: '%7' },
    { type: 'queue-wait' },
    { type: 'capture', paneId: '%7' },
    { type: 'exec', args: ['send-keys', '-t', '%7', 'Escape'] },
  ]);
});

test('does not interrupt Codex when submitted input starts a normal turn', async () => {
  const calls = [];
  const screens = [
    '• Waiting for background terminal (2h 04m)\n› Write tests for @filename',
    '◦ Working (1s • esc to interrupt)\n› Write tests for @filename',
  ];
  const result = await sendSessionMessage({
    provider: 'codex', sessionName: 'research', threadId: 'thread-1', text: '继续检查',
  }, {
    listTmuxSessions: async () => [{
      name: 'research',
      agent: {
        kind: 'codex', id: 'thread-1', paneId: '%7', hasBackgroundProcess: true,
      },
    }],
    bufferName: 'codeck-running-test',
    loadBuffer: async () => {},
    execTmux: async (args) => calls.push({ type: 'exec', args }),
    waitForPaste: async () => calls.push({ type: 'paste-wait' }),
    waitForQueuedInput: async () => calls.push({ type: 'queue-wait' }),
    capturePane: async (paneId) => {
      calls.push({ type: 'capture', paneId });
      return screens.shift();
    },
  });

  assert.deepEqual(result, {});
  assert.equal(calls.some((call) => call.type === 'exec' && call.args.includes('Escape')), false);
  // 两次是队列检查, 第三次是回读输入框确认 Enter 真被受理了。
  assert.equal(calls.filter((call) => call.type === 'capture').length, 3);
});

test('keeps oversized single-line Agent input out of the tmux process argument list', async () => {
  const calls = [];
  const text = 'x'.repeat(70_000);
  await sendSessionMessage({
    provider: 'codex', sessionName: 'research', threadId: 'thread-1', text,
  }, {
    listTmuxSessions: async () => [{
      name: 'research', agent: { kind: 'codex', id: 'thread-1', paneId: '%7' },
    }],
    bufferName: 'codeck-large-test',
    loadBuffer: async (bufferName, value) => calls.push({ type: 'load', bufferName, size: value.length }),
    execTmux: async (args) => calls.push({ type: 'exec', args }),
    waitForPaste: async () => calls.push({ type: 'wait' }),
  });

  assert.deepEqual(calls, [
    { type: 'load', bufferName: 'codeck-large-test', size: text.length },
    {
      type: 'exec',
      args: ['copy-mode', '-q', '-t', '%7', ';', 'paste-buffer', '-p', '-d', '-b', 'codeck-large-test', '-t', '%7'],
    },
    { type: 'wait' },
    { type: 'exec', args: ['copy-mode', '-q', '-t', '%7', ';', 'send-keys', '-t', '%7', 'Enter'] },
  ]);
});

test('captures the /status slash-command output after submitting it literally', async () => {
  const calls = [];
  const result = await sendSessionMessage({
    provider: 'codex', sessionName: 'work', threadId: 'thread-1', text: '/status',
  }, {
    listTmuxSessions: async () => [{
      name: 'work', agent: { kind: 'codex', id: 'thread-1', paneId: '%7' },
    }],
    loadBuffer: async (bufferName, text) => calls.push({ type: 'load', bufferName, text }),
    execTmux: async (args) => calls.push({ type: 'exec', args }),
    waitForPaste: async () => calls.push({ type: 'wait' }),
    waitForSlashOutput: async () => calls.push({ type: 'output-wait' }),
    capturePane: async (paneId) => {
      calls.push({ type: 'capture', paneId });
      return Array.from({ length: 34 }, (_, index) => (
        index === 33 ? '  gpt-5 · /data/code/codeck' : `status row ${index + 1}`
      )).join('\n');
    },
  });

  assert.deepEqual(result, {
    terminalOutput: [
      'status row 5',
      ...Array.from({ length: 28 }, (_, index) => `status row ${index + 6}`),
      '  gpt-5 · /data/code/codeck',
    ].join('\n'),
  });
  assert.deepEqual(calls, [
    { type: 'exec', args: ['copy-mode', '-q', '-t', '%7', ';', 'send-keys', '-l', '-t', '%7', '--', '/status'] },
    { type: 'wait' },
    { type: 'exec', args: ['copy-mode', '-q', '-t', '%7', ';', 'send-keys', '-t', '%7', 'Enter'] },
    { type: 'output-wait' },
    { type: 'capture', paneId: '%7' },
  ]);
});

test('captures the /model slash-command output after submitting it literally', async () => {
  const calls = [];
  const result = await sendSessionMessage({
    provider: 'codex', sessionName: 'work', threadId: 'thread-1', text: '/model gpt-5',
  }, {
    listTmuxSessions: async () => [{
      name: 'work', agent: { kind: 'codex', id: 'thread-1', paneId: '%7' },
    }],
    execTmux: async (args) => calls.push({ type: 'exec', args }),
    waitForPaste: async () => calls.push({ type: 'wait' }),
    waitForSlashOutput: async () => calls.push({ type: 'output-wait' }),
    capturePane: async (paneId) => {
      calls.push({ type: 'capture', paneId });
      return [
        '• Current model',
        '',
        '╭────────────────────────╮',
        '│ GPT-5                  │',
        '│ Reasoning: High        │',
        '╰────────────────────────╯',
      ].join('\n');
    },
  });

  assert.deepEqual(result, {
    terminalOutput: [
      'GPT-5',
      'Reasoning: High',
    ].join('\n'),
  });
  assert.deepEqual(calls, [
    { type: 'exec', args: ['copy-mode', '-q', '-t', '%7', ';', 'send-keys', '-l', '-t', '%7', '--', '/model gpt-5'] },
    { type: 'wait' },
    { type: 'exec', args: ['copy-mode', '-q', '-t', '%7', ';', 'send-keys', '-t', '%7', 'Enter'] },
    { type: 'output-wait' },
    { type: 'capture', paneId: '%7' },
  ]);
});

test('bare /model bypasses slash completion and waits for the actual Codex picker', async () => {
  const calls = [];
  const screens = [
    '╭────────────────────────╮\n│ OpenAI Codex           │\n╰────────────────────────╯',
    '/model  choose what model and reasoning effort to use',
    [
      '╭────────────────────────╮',
      '│ OpenAI Codex           │',
      '╰────────────────────────╯',
      '',
      '  Select Model and Effort',
      '› 1. gpt-5.6-sol (current)  Latest frontier',
      '  2. gpt-5.6-terra          Coding model',
      '  Press enter to confirm or esc to go back',
    ].join('\n'),
  ];
  const result = await sendSessionMessage({
    provider: 'codex', sessionName: 'work', threadId: 'thread-1', text: '/model',
  }, {
    listTmuxSessions: async () => [{
      name: 'work', agent: { kind: 'codex', id: 'thread-1', paneId: '%7' },
    }],
    execTmux: async (args) => calls.push({ type: 'exec', args }),
    waitForPaste: async () => calls.push({ type: 'wait' }),
    waitForSlashOutput: async () => calls.push({ type: 'output-wait' }),
    capturePane: async (paneId) => {
      calls.push({ type: 'capture', paneId });
      return screens.shift();
    },
  });

  assert.equal(result.terminalOutput, [
    'Select Model and Effort',
    '› 1. gpt-5.6-sol (current)  Latest frontier',
    '2. gpt-5.6-terra          Coding model',
    'Press enter to confirm or esc to go back',
  ].join('\n'));
  assert.deepEqual(calls.slice(0, 3), [
    { type: 'exec', args: ['copy-mode', '-q', '-t', '%7', ';', 'send-keys', '-l', '-t', '%7', '--', '/model '] },
    { type: 'wait' },
    { type: 'exec', args: ['copy-mode', '-q', '-t', '%7', ';', 'send-keys', '-t', '%7', 'Enter'] },
  ]);
  assert.equal(calls.filter((call) => call.type === 'capture').length, 3);
});

test('selects an exact option in the verified Codex model picker and returns its next step', async () => {
  const calls = [];
  const screens = [
    [
      '╭──────────────────────────────────────────────╮',
      '│ Select Model and Effort                      │',
      '│ › 1. gpt-5.6-sol (current)  Latest frontier │',
      '│   2. gpt-5.6-terra          Coding model    │',
      '│ Press enter to confirm or esc to go back     │',
      '╰──────────────────────────────────────────────╯',
    ].join('\n'),
    [
      '╭──────────────────────────────────────────────╮',
      '│ Select Reasoning Level for gpt-5.6-terra     │',
      '│   1. Extra high             Deep reasoning  │',
      '│ › 2. More reasoning… (current)  Max/Ultra   │',
      '│ Press enter to confirm or esc to go back     │',
      '╰──────────────────────────────────────────────╯',
    ].join('\n'),
  ];
  const result = await selectSessionModel({
    provider: 'codex', sessionName: 'work', threadId: 'thread-1', option: 'gpt-5.6-terra',
  }, {
    listTmuxSessions: async () => [{
      name: 'work', agent: { kind: 'codex', id: 'thread-1', paneId: '%7' },
    }],
    execTmux: async (args) => calls.push({ type: 'exec', args }),
    waitForSlashOutput: async () => calls.push({ type: 'wait' }),
    capturePane: async (paneId) => {
      calls.push({ type: 'capture', paneId });
      return screens.shift();
    },
  });

  assert.deepEqual(calls, [
    { type: 'capture', paneId: '%7' },
    { type: 'exec', args: ['send-keys', '-t', '%7', 'Down', 'Enter'] },
    { type: 'wait' },
    { type: 'capture', paneId: '%7' },
  ]);
  assert.equal(result.terminalOutput, [
    'Select Reasoning Level for gpt-5.6-terra',
    '1. Extra high             Deep reasoning',
    '› 2. More reasoning… (current)  Max/Ultra',
    'Press enter to confirm or esc to go back',
  ].join('\n'));
});

test('does not special-case slash commands other than /status and /model', async () => {
  const calls = [];
  const result = await sendSessionMessage({
    provider: 'codex', sessionName: 'work', threadId: 'thread-1', text: '/skills',
  }, {
    listTmuxSessions: async () => [{
      name: 'work', agent: { kind: 'codex', id: 'thread-1', paneId: '%7' },
    }],
    execTmux: async (args) => calls.push({ type: 'exec', args }),
    waitForPaste: async () => calls.push({ type: 'wait' }),
    capturePane: async (paneId) => {
      calls.push({ type: 'capture', paneId });
      return '╭────────────────────────╮\n│ Model: gpt-5           │\n╰────────────────────────╯';
    },
  });

  assert.deepEqual(result, {});
  assert.deepEqual(calls, [
    { type: 'exec', args: ['copy-mode', '-q', '-t', '%7', ';', 'send-keys', '-l', '-t', '%7', '--', '/skills'] },
    { type: 'wait' },
    { type: 'exec', args: ['copy-mode', '-q', '-t', '%7', ';', 'send-keys', '-t', '%7', 'Enter'] },
    // 回读输入框: 这块屏幕上没有提示符行, 确认发出去了, 不补 Enter。
    { type: 'capture', paneId: '%7' },
  ]);
});

test('isolates a slash-command modal from the surrounding terminal transcript', () => {
  const pane = [
    '• Prior agent output',
    '',
    '/status',
    '',
    '╭────────────────────────╮',
    '│ Model: gpt-5           │',
    '│ Context: 80% left      │',
    '╰────────────────────────╯',
    '',
    '› Follow up',
    '  gpt-5 · /data/codeck',
  ].join('\n');

  assert.equal(resolveSlashCommandOutput(pane), [
    'Model: gpt-5',
    'Context: 80% left',
  ].join('\n'));
});

test('allows only the server-derived pending thread id before an Agent exposes its persistent id', async () => {
  const calls = [];
  let agent = { kind: 'codex', id: null, paneId: '%7' };
  const options = {
    listTmuxSessions: async () => [{ name: 'codeck', agent }],
    bufferName: 'codeck-pending-test',
    loadBuffer: async (bufferName, text) => calls.push({ type: 'load', bufferName, text }),
    execTmux: async (args) => calls.push({ type: 'exec', args }),
    waitForPaste: async () => calls.push({ type: 'wait' }),
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
        'copy-mode', '-q', '-t', '%7', ';',
        'paste-buffer', '-d', '-b', 'codeck-pending-test', '-t', '%7', ';',
        'send-keys', '-t', '%7', 'Enter',
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
  let listOptions;
  await interruptSession({ provider: 'qodercli', sessionName: 'work', threadId: 'thread-1' }, {
    listTmuxSessions: async (options) => {
      listOptions = options;
      return [{
        name: 'work', agent: { kind: 'qodercli', id: 'thread-1', paneId: '%42' },
      }];
    },
    execTmux: async (args) => calls.push(args),
    invalidatePaneSnapshot: (sessionName) => calls.push(['invalidate', sessionName]),
  });
  assert.deepEqual(listOptions, { refreshAgentIdentities: true, refreshPaneSession: 'work' });
  assert.deepEqual(calls, [['invalidate', 'work'], ['send-keys', '-t', '%42', 'Escape']]);
});

test('sends shell input and Ctrl-C only to the exact verified shell pane', async () => {
  const calls = [];
  const options = {
    listTmuxSessions: async () => [{ name: 'shell-work', paneId: '%9', agent: null }],
    bufferName: 'codeck-shell-test',
    loadBuffer: async (bufferName, text) => calls.push({ type: 'load', bufferName, text }),
    execTmux: async (args) => calls.push({ type: 'exec', args }),
    waitForPaste: async () => calls.push({ type: 'wait' }),
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
      args: ['copy-mode', '-q', '-t', '%9', ';', 'paste-buffer', '-p', '-d', '-b', 'codeck-shell-test', '-t', '%9'],
    },
    { type: 'wait' },
    { type: 'exec', args: ['copy-mode', '-q', '-t', '%9', ';', 'send-keys', '-t', '%9', 'Enter'] },
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
  const sent = [];
  const options = {
    listTmuxSessions: async () => {
      listCalls += 1;
      if (listCalls === 1) {
        markFirstListStarted();
        await firstListGate;
      }
      return [{ name: 'work', agent: { kind: 'codex', id: 'thread-1', paneId: '%7' } }];
    },
    execTmux: async (args) => {
      const sendKeys = args.indexOf('send-keys');
      if (sendKeys >= 0 && args[sendKeys + 1] === '-l') sent.push(args.at(-1));
    },
    loadBuffer: async (_bufferName, text) => sent.push(text),
  };

  const first = sendSessionMessage({
    provider: 'codex', sessionName: 'work', threadId: 'thread-1', text: 'first',
  }, options);
  await firstListStarted;
  const second = sendSessionMessage({
    provider: 'codex', sessionName: 'work', threadId: 'thread-1', text: 'second',
  }, options);
  await new Promise((resolve) => setImmediate(resolve));
  const sentBeforeRelease = [...sent];
  releaseFirstList();
  await Promise.all([first, second]);

  assert.deepEqual(sentBeforeRelease, []);
  assert.deepEqual(sent, ['first', 'second']);
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

test('starts Codeck-managed Codex sessions without the interactive update check', async () => {
  assert.equal(resolveSessionClientCommand('codex'), 'codex -c check_for_update_on_startup=false');
  assert.equal(resolveSessionClientCommand('claude'), 'claude');

  const calls = [];
  await createSession({ name: 'ainfra', client: 'codex', cwd: '/data/code/codeck' }, async (command, args) => {
    calls.push([command, args]);
    return { stdout: '%17\n' };
  });

  assert.deepEqual(calls, [
    ['tmux', ['new-session', '-d', '-s', 'ainfra', '-P', '-F', '#{pane_id}', '-c', '/data/code/codeck']],
    ['tmux', ['send-keys', '-l', '-t', '%17', 'codex -c check_for_update_on_startup=false']],
    ['tmux', ['send-keys', '-t', '%17', 'Enter']],
  ]);
});

test('starts each Agent in its native resume picker inside the requested tmux directory', async () => {
  for (const [client, command] of [
    ['codex', 'codex -c check_for_update_on_startup=false resume'],
    ['claude', 'claude --resume'],
    ['qodercli', 'qodercli --resume'],
  ]) {
    const calls = [];
    await createSession({ name: 'restore', client, mode: 'resume', cwd: '/srv/project' }, async (...args) => {
      calls.push(args);
      return { stdout: '%23\n' };
    });

    assert.deepEqual(calls, [
      ['tmux', ['new-session', '-d', '-s', 'restore', '-P', '-F', '#{pane_id}', '-c', '/srv/project']],
      ['tmux', ['send-keys', '-l', '-t', '%23', command]],
      ['tmux', ['send-keys', '-t', '%23', 'Enter']],
    ], client);
  }
});

test('creates plain shell sessions without sending an Agent command', async () => {
  for (const mode of [undefined, 'new']) {
    const calls = [];
    await createSession({ name: 'shell-work', client: 'shell', mode }, async (...args) => {
      calls.push(args);
    });
    assert.deepEqual(calls, [['tmux', ['new-session', '-d', '-s', 'shell-work', '-P', '-F', '#{pane_id}']]]);
  }
});

test('keeps a created session recoverable and explains a partial Agent launch failure', async () => {
  for (const failure of ['pane', 'literal', 'enter']) {
    const calls = [];
    await assert.rejects(createSession({ name: 'recover', client: 'codex' }, async (_command, args) => {
      calls.push(args);
      if (args[0] === 'new-session') return { stdout: failure === 'pane' ? 'recover:1.1\n' : '%31\n' };
      if ((failure === 'literal' && args.includes('-l')) || (failure === 'enter' && args.includes('Enter'))) {
        throw new Error('injected tmux failure');
      }
      return { stdout: '' };
    }), /recover.*已创建.*手动/);
    assert.equal(calls.some((args) => args[0] === 'kill-session'), false, 'a partial launch never deletes the user session');
    if (failure === 'pane') assert.equal(calls.length, 1, 'an invalid returned pane is never used as a target');
  }
});

test('rejects unsupported session launch modes before creating a tmux session', async () => {
  const calls = [];
  const execCommand = async (...args) => { calls.push(args); };
  for (const mode of ['', null, 1, 'continue', 'resume; pwd']) {
    await assert.rejects(createSession({ name: 'work', client: 'codex', mode }, execCommand), /启动方式/);
  }
  await assert.rejects(
    createSession({ name: 'work', client: 'shell', mode: 'resume' }, execCommand),
    /Shell.*恢复/,
  );
  assert.deepEqual(calls, []);
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

// 新版 Claude Code 把 "esc to interrupt" 留在了常驻快捷键提示里 —— 空闲时也在。
// 下面是实抓的空闲 pane: 提示符是空的, 没有 spinner, 但 footer 带着这句话。
// 旧版空闲 footer 不含它, 所以它一度是可用的忙判据; 现在不是了。
const CLAUDE_IDLE_WITH_INTERRUPT_HINT = `
✻ Worked for 45s
────────────────────────────────
❯
────────────────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt · ← for agents      /rc active
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
  assert.deepEqual(signals(CLAUDE_IDLE_WITH_INTERRUPT_HINT, 'claude'), { busy: false, background: false });
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

test('keeps an idle Claude final answer available when its transcript did not catch up', () => {
  const pane = [
    '  已完成修复，服务已经恢复。',
    '',
    '  请重新打开 remote 页面验证。',
    '',
    '✻ Cogitated for 19s · done 9:20 AM',
    '',
    '※ recap: this is interface metadata, not the answer',
    '  ✔ Update installed · Restart to…',
    '────────────────────────────────────',
    '❯ ',
    '────────────────────────────────────',
    '  ⏵⏵ bypass permissions on',
  ].join('\n');

  assert.equal(resolveAgentSessionLiveOutput(
    { kind: 'claude', id: 'thread-1' },
    false,
    { busy: false, background: false, animating: false },
    pane,
  ), [
    '  已完成修复，服务已经恢复。',
    '',
    '  请重新打开 remote 页面验证。',
    '',
    '✻ Cogitated for 19s · done 9:20 AM',
  ].join('\n'));
});

test('extracts qoder thinking and tool use above its composer and status rows', () => {
  // Qoder renders pending history first, then its loading row, composer, and status
  // details. The latter can put the loading row more than six non-empty rows from
  // the bottom even though the thinking and tool rows are still visible in tmux.
  const qoderPane = `
> Review the remote Qoder output
Thinking
│ I need to inspect the tmux pane parser.
│ The current boundary only recognizes Codex and Claude bullets.
▸ 2 tool calls (Read, Shell) — 1 running
▪ Read
  └ src/tmux.js
▫ Shell
  └ node --test test/tmux.test.js
⠋ Thinking... (esc to cancel, 25s)
────────────────
  Type your message or @path/to/file
────────────────
accept edits
1 open file
qoder-model · /data/code/codeck
+0 -0
· ctx ▓▓░ 27% ·
`;

  assert.deepEqual(signals(qoderPane, 'qodercli'), { busy: true, background: false });
  assert.equal(resolveAgentLiveOutput('qodercli', qoderPane, { allowTail: true }), [
    'Thinking',
    '│ I need to inspect the tmux pane parser.',
    '│ The current boundary only recognizes Codex and Claude bullets.',
    '▸ 2 tool calls (Read, Shell) — 1 running',
    '▪ Read',
    '  └ src/tmux.js',
    '▫ Shell',
    '  └ node --test test/tmux.test.js',
    '⠋ Thinking... (esc to cancel, 25s)',
  ].join('\n'));
});

test('does not carry prior qoder thinking into a tool-only current turn', () => {
  const qoderPane = `
> Explain the parser
Thinking
│ I should inspect the existing implementation.
▪ The parser uses terminal markers.
> Run the focused test
▫ Shell
  └ node --test test/tmux.test.js
⠋ Generating... (esc to cancel, 8s)
  Type your message or @path/to/file
qoder-model · /data/code/codeck
· ctx ▓▓░ 27% ·
`;

  assert.equal(resolveAgentLiveOutput('qodercli', qoderPane), [
    '▫ Shell',
    '  └ node --test test/tmux.test.js',
    '⠋ Generating... (esc to cancel, 8s)',
  ].join('\n'));
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

test('keeps Qoder final output after completion even when structured history is available', () => {
  const idlePane = `
> Summarize the fix

The final answer is ready.
- Updated the parser
- Added regression coverage

────────────────────────────────
Shift+Tab to Accept Edits                                      14 skills
────────────────────────────────
>  Type your message or @path/to/file
────────────────────────────────
Qwen3.8-Max Model · ctx ░░░░░░░░░░ 4% · /data/code/codeck
`;
  const idleSignals = { busy: false, background: false, animating: false };
  const expected = [
    'The final answer is ready.',
    '- Updated the parser',
    '- Added regression coverage',
  ].join('\n');

  assert.equal(resolveAgentSessionLiveOutput(
    { kind: 'qodercli', id: 'thread-1' }, false, idleSignals, idlePane,
  ), expected);
  assert.equal(resolveAgentSessionLiveOutput(
    { kind: 'qodercli', id: null }, false, idleSignals, idlePane,
  ), expected);
});

test('does not expose the Qoder welcome screen as a final answer', () => {
  const welcomePane = `
Qoder CLI v1.1.28                 Tips for getting started
Signed in Browser Login
? for shortcuts
────────────────────────────────
Shift+Tab to Accept Edits
────────────────────────────────
>  Type your message or @path/to/file
────────────────────────────────
Qwen3.8-Max Model · ctx ░░░░░░░░░░ 0% · /data/code/codeck
`;

  assert.equal(resolveAgentSessionLiveOutput(
    { kind: 'qodercli', id: null }, false,
    { busy: false, background: false, animating: false }, welcomePane,
  ), '');
  assert.equal(resolveAgentSessionLiveOutput(
    { kind: 'qodercli', id: 'thread-1' }, false,
    { busy: false, background: false, animating: false }, welcomePane,
  ), '');
});

test('a completed claude turn is not mistaken for the codex working state', () => {
  assert.equal(signals(CLAUDE_IDLE, 'codex').busy, false);
});

test('agent sessions are working only while the current turn is active', () => {
  const working = (screenSignals, hasBackgroundProcess = false) => resolveWorkingState({
    agentKind: 'claude', screenSignals, paneCommands: ['bash'], hasBackgroundProcess,
  });
  assert.equal(working({ busy: true, background: false }), true);
  assert.equal(working({ busy: true, background: true }), true);
  assert.equal(working({ busy: false, background: true }), false);
  assert.equal(working({ busy: false, background: true, animating: true }), false);
  assert.equal(working({ busy: false, background: false }, true), false);
  assert.equal(working({ busy: false, background: false, animating: true }), true);
  assert.equal(working({ busy: false, background: false }), false);
  assert.equal(working(undefined), false);
});

test('Codex background work requires a live Agent-owned process', () => {
  assert.equal(resolveAgentBackgroundState({
    agent: { kind: 'codex', hasBackgroundProcess: true },
    screenSignals: { background: false },
  }), true);
  assert.equal(resolveAgentBackgroundState({
    agent: { kind: 'codex' },
    screenSignals: { background: true },
  }), false);
  assert.equal(resolveAgentBackgroundState({
    agent: { kind: 'claude' },
    screenSignals: { background: true },
  }), true);
  assert.equal(resolveAgentBackgroundState({
    agent: null,
    screenSignals: { background: true },
  }), false);
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
  assert.equal(identifyAgentFromScreen(CODEX_IDLE), 'codex');
  assert.equal(identifyAgentFromScreen(`${CODEX_IDLE}\n[x@remote ~]$`), null, 'an exited Codex is a shell again');
  assert.equal(identifyAgentFromScreen(''), null);
});

test('an ssh-only screen identity becomes a manageable pending Agent', () => {
  const pane = { session: 'cli', paneId: '%71' };
  assert.deepEqual(resolvePaneAgent(null, CODEX_IDLE, pane), {
    kind: 'codex', id: null, name: 'cli', paneId: '%71',
  });

  const processAgent = { kind: 'codex', id: 'thread-1', name: 'Local task', paneId: '%71' };
  assert.equal(resolvePaneAgent(processAgent, CODEX_IDLE, pane), processAgent);
  assert.equal(resolvePaneAgent(null, '[x@remote ~]$', pane), null);
});

test('a cancel prompt without a timer is not a qodercli turn', () => {
  assert.equal(signals('⠋ Generating... (esc to cancel, 25s)', 'qodercli').busy, true);
  assert.equal(signals('Delete this file? (enter to confirm, esc to cancel)', 'qodercli').busy, false);
});

test('input left sitting in an agent composer gets its Enter again', async () => {
  // research 会话上实测到的现象: Codex 在跑长任务时收到消息, 文字进了输入框, 但那次
  // Enter 没生效 —— 任务结束后消息就一直停在 "› 怎么样了" 那一行, 永远不会被处理。
  const sent = [];
  let composer = '';
  const screen = () => `─ Worked for 3s ───\n\n› ${composer}\n\n  gpt-5.6 · ~/py`;
  const submitted = await ensureAgentInputSubmitted({
    paneId: '%0',
    text: '怎么样了',
    execTmux: async (args) => {
      sent.push(args.join(' '));
      if (args.includes('Enter')) composer = '';
    },
    capturePane: async () => screen(),
    waitForSubmit: async () => {},
  });
  assert.equal(submitted, false, '输入框本来就空, 不该补发');

  composer = '怎么样了';
  sent.length = 0;
  const retried = await ensureAgentInputSubmitted({
    paneId: '%0',
    text: '怎么样了',
    execTmux: async (args) => {
      sent.push(args.join(' '));
      if (args.includes('Enter')) composer = '';
    },
    capturePane: async () => screen(),
    waitForSubmit: async () => {},
  });
  assert.equal(retried, true);
  assert.deepEqual(sent, ['send-keys -t %0 Enter'], '只补一次, 且确认后不再重复');
});

test('a composer holding someone else\'s text is never given a stray Enter', async () => {
  // 补发 Enter 只在确认看到自己发的内容时才做 —— 否则会替用户提交别的东西,
  // 或者在某个确认框上按下回车。
  let calls = 0;
  const submitted = await ensureAgentInputSubmitted({
    paneId: '%0',
    text: '怎么样了',
    execTmux: async () => { calls += 1; },
    capturePane: async () => '› 另一段没发完的草稿\n\n  gpt-5.6 · ~/py',
    waitForSubmit: async () => {},
  });
  assert.equal(submitted, false);
  assert.equal(calls, 0);
});

test('a submitted message echoed in the transcript is not mistaken for the composer', async () => {
  // Claude Code 把已提交的消息也渲染成 "❯ hi", 和输入框同一个前缀。把所有前缀行拼起来
  // 找的话, 每发一条消息都会误判成"还没发出去", 于是白白补发 Enter —— 而那可能替用户
  // 确认某个对话框。输入框永远是最下面那一行。
  const pane = [
    '❯ 怎么样了',
    '',
    '  已经都提交推送了。',
    '',
    '❯ ',
    '  ⏵⏵ bypass permissions on',
  ].join('\n');
  let enters = 0;
  const submitted = await ensureAgentInputSubmitted({
    paneId: '%0',
    text: '怎么样了',
    execTmux: async (args) => { if (args.includes('Enter')) enters += 1; },
    capturePane: async () => pane,
    waitForSubmit: async () => {},
  });
  assert.equal(submitted, false);
  assert.equal(enters, 0, '消息已经发出去了, 不该再补 Enter');
});
