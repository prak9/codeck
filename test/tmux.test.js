import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSessionCommandOutput } from '../public/remote-command-output.js';
import { resolveSessionStatus, sessionSnapshotRefreshInterval } from '../src/session-status.js';
import { AGENT_SCREEN_MARKERS, dismissSessionCommand, ensureAgentInputSubmitted, capturePanes, capturePaneSnapshots, createSession, createSessionScrollQueue, findLinkedWindowSessions, identifyAgentFromScreen, interruptSession, mergeWindowActivity, parsePanes, parseSessions, parseViewport, resolveAgentActivityText, resolveAgentBackgroundState, resolveAgentLiveOutput, resolveAgentSessionLiveOutput, resolvePaneAgent, resolveScreenActivity, resolveScreenSignals, resolveSessionClientCommand, resolveShellLiveOutput, resolveSlashCommandOutput, resolveWorkingState, selectSessionModel, sendSessionMessage, supportsWindowSizeOption, validateClient, validateSessionName, withoutTmuxEnvironment } from '../src/tmux.js';

const EMPTY_CODEX_COMPOSER = '» \n\n  gpt-6-astra · /project';

test('progress input preserves Codex native queue without forcing Escape or clearing a draft', async () => {
  const commands = []; let pasted = false;
  const queued = 'Messages to be submitted after next tool call\npress esc to interrupt and send immediately';
  const options = {
    listTmuxSessions: async () => [{ name: 'work', hasRunningProcess: true,
      agent: { kind: 'codex', id: 'thread-1', paneId: '%7' } }],
    capturePane: async () => pasted ? queued : EMPTY_CODEX_COMPOSER,
    execTmux: async args => { commands.push(args); if (args.includes('paste-buffer')) pasted = true; },
    loadBuffer: async () => {}, waitForPaste: async () => {}, waitForQueuedInput: async () => {}, waitForSubmit: async () => {},
  };
  const params = { provider: 'codex', sessionName: 'work', threadId: 'thread-1', text: 'Status?', nonInterrupting: true };
  const result = await sendSessionMessage(params, options);
  assert.equal(result.inputWasQueued, true);
  assert.equal(result.submissionStatus, 'submitted');
  assert.equal(commands.some(args => args.some(key => ['Escape', 'C-c', 'C-u', 'C-k'].includes(key))), false);
  commands.length = 0;
  for (const screen of [EMPTY_CODEX_COMPOSER.replace('» ', '» my draft'), NARROW_CODEX_MODEL_PICKER]) {
    await assert.rejects(sendSessionMessage(params, { ...options, capturePane: async () => screen }));
    assert.equal(commands.some(args => args.includes('send-keys') || args.includes('paste-buffer')), false);
  }
});

test('research setup can be sent with background terminals and a stalled Goal without interrupting', async () => {
  const commands = []; let pasted = false;
  const footer = '2 background terminals running · /ps to view · /stop to close\n\n» \n\n  gpt-6-astra ultra · ~/py     Goal stalled (/goal resume)';
  const result = await sendSessionMessage({ provider: 'codex', sessionName: 'research', threadId: 'thread-1',
    expectedPaneId: '%7', text: '请确认自主目标', requireIdle: false, nonInterrupting: true, isCurrent: () => true,
  }, {
    listTmuxSessions: async () => [{ name: 'research', hasRunningProcess: false,
      agent: { kind: 'codex', id: 'thread-1', paneId: '%7', hasBackgroundProcess: true } }],
    capturePane: async () => pasted ? `» 请确认自主目标\n${footer}` : footer,
    execTmux: async args => { commands.push(args); if (args.includes('paste-buffer')) pasted = true; },
    loadBuffer: async () => {}, waitForPaste: async () => {}, waitForSubmit: async () => {},
  });
  assert.equal(result.submissionStatus, 'submitted');
  assert.equal(commands.some(args => args.some(key => ['Escape', 'C-c', 'C-u', 'C-k'].includes(key))), false);
});

test('pausing an autonomous write during paste prevents Enter for every provider', async () => {
  for (const provider of ['codex', 'claude', 'qodercli']) {
    let current = true; const commands = [];
    const result = await sendSessionMessage({ provider, sessionName: 'work', threadId: 'thread-1',
      text: 'Round\nInstructions', isCurrent: () => current,
    }, {
      listTmuxSessions: async () => [{ name: 'work', agent: { kind: provider, id: 'thread-1', paneId: '%7' } }],
      capturePane: async () => EMPTY_CODEX_COMPOSER,
      execTmux: async args => commands.push(args), loadBuffer: async () => {},
      waitForPaste: async () => { current = false; },
    });
    assert.equal(result.submissionStatus, 'unconfirmed', provider);
    assert.equal(commands.some(args => args.includes('Enter')), false, provider);
  }
});

test('Claude guarded input checks the full composer, including a draft after an empty first line', async () => {
  const commands = [];
  await assert.rejects(sendSessionMessage({ provider: 'claude', sessionName: 'work', threadId: 'thread-1',
    text: 'Round\nInstructions', requireIdle: true,
  }, {
    listTmuxSessions: async () => [{ name: 'work', agent: { kind: 'claude', id: 'thread-1', paneId: '%7' } }],
    capturePane: async () => '❯ \n  my existing draft\n────────────────────\n  ⏵⏵ bypass permissions on',
    execTmux: async args => commands.push(args), loadBuffer: async () => {}, waitForPaste: async () => {}, waitForSubmit: async () => {},
  }));
  assert.deepEqual(commands, []);
});

test('autonomous writes reject cancelled generations, busy panes and native menus without keys', async () => {
  for (const scenario of ['cancelled', 'busy', 'menu', 'draft', 'replaced']) {
    const commands = [];
    await assert.rejects(sendSessionMessage({ provider: 'codex', sessionName: 'work', threadId: 'thread-1',
      text: 'Autonomous round\nDo the next step', requireIdle: true, expectedPaneId: '%7',
      isCurrent: () => scenario !== 'cancelled',
    }, {
      listTmuxSessions: async () => [{ name: 'work', hasRunningProcess: scenario === 'busy',
        agent: { kind: 'codex', id: 'thread-1', paneId: scenario === 'replaced' ? '%8' : '%7' } }],
      capturePane: async () => scenario === 'menu' ? NARROW_CODEX_MODEL_PICKER
        : scenario === 'draft' ? EMPTY_CODEX_COMPOSER.replace('» ', '» my draft') : EMPTY_CODEX_COMPOSER,
      execTmux: async args => commands.push(args), loadBuffer: async () => {}, waitForPaste: async () => {},
    }));
    assert.deepEqual(commands, [], scenario);
  }
});
// Codex 0.153.2 at 37x21: the title is offscreen and both annotations and hints clip.
const NARROW_CODEX_MODEL_PICKER = `
› 1. gpt-6-astra (curr… Our most
                        capable
                        model for
                        complex,
                        demanding
                        work.
  2. gpt-5.6-sol        Reliable
                        agentic
                        workhorse
                        for
                        everyday
                        tasks.
  3. gpt-5.6-terra      Balanced
                        agentic
                        coding
                        model for
                        everyday

  Press enter to confirm or esc to go
`;
const NARROW_CODEX_REASONING_PICKER = `
  2. Medium (default)   Balances
                        speed and
                        reasoning
                        depth for
                        everyday
                        tasks
  3. High               Greater
                        reasoning
                        depth for
                        complex
                        problems
› 4. Extra high (curre… Extra high
                        reasoning
                        depth for
                        complex
                        problems
  5. More reasoning…    Max and

  Press enter to confirm or esc to go
`;
// Real Codex 0.153.2 captures at 24 and 28 columns. tmux -e preserves the
// faint placeholder, which has the same text as a possible user-authored draft.
const NARROW_CODEX_COMPOSERS = [
  '\x1b[1m›\x1b[0m \x1b[2mAsk Codex to do anyth\n\x1b[0m \n  \x1b[38;2;246;226;183mgpt-6-astra xhigh fas…',
  '\x1b[1m›\x1b[0m \x1b[2mAsk Codex to do anything\n\x1b[0m \n  \x1b[38;2;246;226;183mgpt-6-astra xhigh fast\x1b[2m\x1b[39m · …',
  // research at 37 columns: the clipped model is followed by a goal badge.
  '\x1b[1m›\x1b[0m \x1b[2mAsk Codex to do anything\n\x1b[0m \n  \x1b[38;2;246;226;183mgpt-6-astra …\x1b[39m \x1b[38;5;5mGoal achieved (11m)',
];

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
    capturePane: async () => '',
    waitForSubmit: async () => {},
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

test('submits ordinary Codex input with bracketed paste and a separate delayed Enter', async () => {
  const calls = [];
  await sendSessionMessage({
    provider: 'codex', sessionName: 'research', threadId: 'thread-1', text: '提交',
  }, {
    listTmuxSessions: async () => [{
      name: 'research', agent: { kind: 'codex', id: 'thread-1', paneId: '%7' },
    }],
    bufferName: 'codeck-test',
    capturePane: async () => EMPTY_CODEX_COMPOSER,
    waitForSubmit: async () => {},
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
        'paste-buffer', '-p', '-d', '-b', 'codeck-test', '-t', '%7',
      ],
    },
    { type: 'wait' },
    { type: 'exec', args: ['copy-mode', '-q', '-t', '%7', ';', 'send-keys', '-t', '%7', 'Enter'] },
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
    capturePane: async () => '',
    waitForSubmit: async () => {},
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
    capturePane: async () => '',
    waitForSubmit: async () => {},
    loadBuffer: async () => {},
    execTmux: async () => {},
    waitForPaste: async () => {},
  });

  assert.deepEqual(result, { inputWasQueued: true });
});

test('accepts Codex input when an active turn hides the composer', async () => {
  const commands = [];
  const activeTurn = '› Original request\n◦ Working (12s • esc to interrupt)\n  └ Waiting on background process';
  const result = await sendSessionMessage({
    provider: 'codex', sessionName: 'research', threadId: 'thread-1', text: '怎么样了',
  }, {
    listTmuxSessions: async () => [{
      name: 'research', hasRunningProcess: false,
      agent: { kind: 'codex', id: 'thread-1', paneId: '%7' },
    }],
    bufferName: 'codeck-active-test',
    loadBuffer: async () => {},
    execTmux: async (args) => commands.push(args),
    waitForPaste: async () => {}, waitForQueuedInput: async () => {}, waitForSubmit: async () => {},
    capturePane: async () => activeTurn,
  });

  assert.deepEqual(result, { submissionStatus: 'unconfirmed', inputWasQueued: true });
  assert.equal(commands.filter((args) => args.includes('paste-buffer')).length, 1);
  assert.equal(commands.filter((args) => args.includes('Enter')).length, 1);
});

test('an active Codex marker permits draft replacement but never confirms a stuck picker', async () => {
  const cases = [
    ['Continue', '◦ Working (12s • esc to interrupt)\n» Existing draft'],
    ['Continue', '• Waiting for background terminal (2h 04m)\n» Existing draft'],
    ['Continue', [
      '◦ Working (12s • esc to interrupt)',
      'Choose response', '› 1. Approve', '  2. Deny',
      'Press enter to confirm or esc to go back',
    ].join('\n')],
    ['/status', '› Original request\n◦ Working (12s • esc to interrupt)'],
  ];
  for (const [text, screen] of cases) {
    const commands = [];
    const sending = sendSessionMessage({
      provider: 'codex', sessionName: 'research', threadId: 'thread-1', text,
    }, {
      listTmuxSessions: async () => [{
        name: 'research', hasRunningProcess: true,
        agent: { kind: 'codex', id: 'thread-1', paneId: '%7', hasBackgroundProcess: true },
      }],
      loadBuffer: async () => {},
      execTmux: async (args) => commands.push(args),
      waitForPaste: async () => {}, waitForSubmit: async () => {},
      waitForQueuedInput: async () => {}, waitForSlashOutput: async () => {},
      capturePane: async () => commands.some((args) => args.includes('C-u'))
        ? '› \n\n  gpt-6-astra · /project' : screen,
    });
    if (screen.includes('Choose response')) {
      await assert.rejects(sending, /弹窗尚未关闭/);
      assert.equal(commands.some((args) => args.includes('Enter') || args.includes('paste-buffer')), false);
    } else {
      await sending;
      assert.equal(commands.filter((args) => args.includes('Enter')).length, 1);
      assert.equal(commands.some((args) => args.includes('Escape') || args.includes('C-c')), false);
    }
  }
});

test('releases Codex input from a composerless background terminal wait', async () => {
  const calls = [];
  const activeWait = '• Waiting for background terminal (2h 04m)';
  const screens = [
    `${activeWait}\n› Write tests for @filename`,
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
      name: 'research', hasRunningProcess: false,
      agent: { kind: 'codex', id: 'thread-1', paneId: '%7' },
    }],
    bufferName: 'codeck-queued-test',
    loadBuffer: async (bufferName, text) => calls.push({ type: 'load', bufferName, text }),
    execTmux: async (args) => calls.push({ type: 'exec', args }),
    waitForPaste: async () => calls.push({ type: 'paste-wait' }),
    waitForQueuedInput: async () => calls.push({ type: 'queue-wait' }),
    capturePane: async (paneId) => {
      if (!calls.some((call) => call.type === 'exec')) return activeWait;
      calls.push({ type: 'capture', paneId });
      return screens.shift();
    },
  });

  assert.deepEqual(result, {
    terminalWorking: true, submissionStatus: 'submitted', inputWasQueued: true,
  });
  assert.deepEqual(calls, [
    { type: 'load', bufferName: 'codeck-queued-test', text: '怎么样了' },
    {
      type: 'exec',
      args: [
        'copy-mode', '-q', '-t', '%7', ';',
        'paste-buffer', '-p', '-d', '-b', 'codeck-queued-test', '-t', '%7',
      ],
    },
    { type: 'paste-wait' },
    { type: 'exec', args: ['copy-mode', '-q', '-t', '%7', ';', 'send-keys', '-t', '%7', 'Enter'] },
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
    '◦ Working (1s • esc to interrupt)\n» \n\n  gpt-6-astra · /project',
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
    waitForSubmit: async () => {},
    capturePane: async (paneId) => {
      if (!calls.some((call) => call.type === 'exec')) return EMPTY_CODEX_COMPOSER;
      calls.push({ type: 'capture', paneId });
      return screens.shift();
    },
  });

  assert.deepEqual(result, { submissionStatus: 'submitted' });
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
    capturePane: async () => EMPTY_CODEX_COMPOSER,
    waitForSubmit: async () => {},
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
      if (!calls.some((call) => call.type === 'exec')) return EMPTY_CODEX_COMPOSER;
      calls.push({ type: 'capture', paneId });
      return Array.from({ length: 34 }, (_, index) => (
        index === 32 ? '› Ask Codex to do anything'
          : index === 33 ? '  gpt-5 · /data/code/codeck' : `status row ${index + 1}`
      )).join('\n');
    },
  });

  assert.deepEqual(result, {
    terminalOutput: [
      'status row 5',
      ...Array.from({ length: 27 }, (_, index) => `status row ${index + 6}`),
      '› Ask Codex to do anything',
      '  gpt-5 · /data/code/codeck',
    ].join('\n'),
  });
  assert.deepEqual(calls, [
    { type: 'exec', args: ['copy-mode', '-q', '-t', '%7', ';', 'send-keys', '-l', '-t', '%7', '--', '/status '] },
    { type: 'wait' },
    { type: 'exec', args: ['copy-mode', '-q', '-t', '%7', ';', 'send-keys', '-t', '%7', 'Enter'] },
    { type: 'output-wait' },
    { type: 'capture', paneId: '%7' },
  ]);
});

test('bare /status dismisses a stale Skills picker before submitting', async () => {
  const calls = [];
  const skillsPicker = [
    'Skills',
    'Choose an action',
    '› 1. List skills            Tip: press $ to open this list directly.',
    '  2. Enable/Disable Skills  Enable or disable skills.',
    'Press enter to confirm or esc to go back',
  ].join('\n');
  const status = [
    '/status',
    '╭────────────────────────╮',
    '│ Model: gpt-5.6-sol     │',
    '│ Context: 45% left      │',
    '╰────────────────────────╯',
    '› Ask Codex to do anything',
    '  gpt-5.6-sol · /data/codeck',
  ].join('\n');
  const screens = [skillsPicker, EMPTY_CODEX_COMPOSER, EMPTY_CODEX_COMPOSER, status];
  const result = await sendSessionMessage({
    provider: 'codex', sessionName: 'work', threadId: 'thread-1', text: '/status',
  }, {
    listTmuxSessions: async () => [{
      name: 'work', agent: { kind: 'codex', id: 'thread-1', paneId: '%7' },
    }],
    execTmux: async (args) => calls.push(args),
    waitForPaste: async () => {},
    waitForSlashOutput: async () => {},
    capturePane: async () => screens.shift() || status,
  });

  assert.match(result.terminalOutput, /Model: gpt-5\.6-sol/);
  assert.deepEqual(calls, [
    ['copy-mode', '-q', '-t', '%7', ';', 'send-keys', '-t', '%7', 'Escape'],
    ['copy-mode', '-q', '-t', '%7', ';', 'send-keys', '-l', '-t', '%7', '--', '/status '],
    ['copy-mode', '-q', '-t', '%7', ';', 'send-keys', '-t', '%7', 'Enter'],
  ]);
});

test('/status returns its output without interrupting a working or background-waiting Codex', async () => {
  for (const marker of ['• Working (25s • esc to interrupt)', '• Waiting for background terminal (25s)']) {
    const commands = [];
    const before = `${marker}\n${EMPTY_CODEX_COMPOSER}`;
    const after = [
      '/status',
      '╭────────────────────────╮',
      '│ Model: gpt-6-astra     │',
      '╰────────────────────────╯',
      marker, EMPTY_CODEX_COMPOSER,
    ].join('\n');
    const result = await sendSessionMessage({
      provider: 'codex', sessionName: 'work', threadId: 'thread-1', text: '/status',
    }, {
      listTmuxSessions: async () => [{
        name: 'work', hasRunningProcess: true,
        agent: { kind: 'codex', id: 'thread-1', paneId: '%7' },
      }],
      execTmux: async (args) => commands.push(args),
      waitForPaste: async () => {}, waitForSlashOutput: async () => {},
      capturePane: async () => commands.length ? after : before,
    });
    assert.deepEqual(result, { terminalOutput: 'Model: gpt-6-astra', terminalWorking: true });
    assert.equal(commands.some(args => args.includes('Escape') || args.includes('C-c')), false);
    assert.equal(commands.filter(args => args.includes('Enter')).length, 1);
  }
});

test('waits for a delayed /status result instead of returning the old composer frame', async () => {
  const calls = [];
  const previousStatusScreen = [
    '╭────────────────────────╮',
    '│ Model: gpt-5.5        │',
    '╰────────────────────────╯',
    '',
    '› Ask Codex to do anything',
    '  gpt-5.5 · /data/codeck',
  ].join('\n');
  const statusScreen = [
    '/status',
    '╭────────────────────────╮',
    '│ Model: gpt-5.6-terra  │',
    '│ Context: 80% left     │',
    '╰────────────────────────╯',
    '',
    '› Ask Codex to do anything',
    '  gpt-5.6-terra · /data/codeck',
  ].join('\n');
  const screens = [EMPTY_CODEX_COMPOSER, previousStatusScreen, previousStatusScreen, statusScreen];
  const result = await sendSessionMessage({
    provider: 'codex', sessionName: 'work', threadId: 'thread-1', text: '/status',
  }, {
    listTmuxSessions: async () => [{
      name: 'work', agent: { kind: 'codex', id: 'thread-1', paneId: '%7' },
    }],
    execTmux: async (args) => calls.push({ type: 'exec', args }),
    waitForPaste: async () => {},
    waitForSlashOutput: async () => calls.push({ type: 'output-wait' }),
    capturePane: async () => screens.shift() || statusScreen,
  });

  assert.equal(result.terminalOutput, 'Model: gpt-5.6-terra\nContext: 80% left');
  assert.equal(calls.filter((call) => call.type === 'output-wait').length, 2);
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
      if (!calls.some((call) => call.type === 'exec')) return EMPTY_CODEX_COMPOSER;
      calls.push({ type: 'capture', paneId });
      return [
        '• Current model',
        '',
        '╭────────────────────────╮',
        '│ GPT-5                  │',
        '│ Reasoning: High        │',
        '╰────────────────────────╯',
        '',
        '› Ask Codex to do anything',
        '  gpt-5 · /data/codeck',
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
      if (!calls.some((call) => call.type === 'exec')) return EMPTY_CODEX_COMPOSER;
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

test('resumes an already open /model picker without typing the command again', async () => {
  const calls = [];
  const picker = [
    'Select Model and Effort',
    '› 1. gpt-5.6-sol (current)  Balanced',
    '  2. gpt-6-astra            Most capable',
    'Press enter to confirm or esc to go back',
  ].join('\n');
  const result = await sendSessionMessage({
    provider: 'codex', sessionName: 'work', threadId: 'thread-1', text: '/model',
  }, {
    listTmuxSessions: async () => [{
      name: 'work', agent: { kind: 'codex', id: 'thread-1', paneId: '%7' },
    }],
    execTmux: async (args) => calls.push(args),
    waitForPaste: async () => {},
    waitForSlashOutput: async () => {},
    capturePane: async () => picker,
  });

  assert.match(result.terminalOutput, /Select Model and Effort/);
  assert.deepEqual(calls, []);
});

test('recovers the real short narrow model picker without a title or complete hint', async () => {
  const commands = [];
  const result = await sendSessionMessage({
    provider: 'codex', sessionName: 'work', threadId: 'thread-1', text: '/model',
  }, {
    listTmuxSessions: async () => [{ name: 'work', agent: { kind: 'codex', id: 'thread-1', paneId: '%7' } }],
    capturePane: async () => NARROW_CODEX_MODEL_PICKER,
    execTmux: async args => commands.push(args),
    waitForSlashOutput: async () => {},
  });
  assert.match(result.terminalOutput, /Select Model and Effort/);
  assert.match(result.terminalOutput, /gpt-6-astra \(current\)/);
  assert.match(result.terminalOutput, /Our most capable model for complex, demanding work\./);
  assert.deepEqual(commands, []);
});

test('Remote narrow picker labels round-trip through model and reasoning selection', async () => {
  for (const [screen, nextScreen, label] of [
    [NARROW_CODEX_MODEL_PICKER, NARROW_CODEX_REASONING_PICKER, 'gpt-6-astra'],
    [NARROW_CODEX_MODEL_PICKER.replace('(curr…', '(current)'), NARROW_CODEX_REASONING_PICKER, 'gpt-6-astra'],
    [NARROW_CODEX_REASONING_PICKER, EMPTY_CODEX_COMPOSER, 'Extra high'],
    [NARROW_CODEX_REASONING_PICKER.replace('(curre…', '(current)'), EMPTY_CODEX_COMPOSER, 'Extra high'],
  ]) {
    const commands = [];
    const target = { provider: 'codex', sessionName: 'work', threadId: 'thread-1' };
    const overrides = {
      listTmuxSessions: async () => [{ name: 'work', agent: { kind: 'codex', id: 'thread-1', paneId: '%7' } }],
      capturePane: async () => commands.length ? nextScreen : screen,
      execTmux: async args => commands.push(args),
      waitForSlashOutput: async () => {},
    };
    const opened = await sendSessionMessage({ ...target, text: '/model' }, overrides);
    const output = normalizeSessionCommandOutput('codex', '/model', opened);
    const item = output.parsed.items.find(item => item.label.startsWith(label));
    const result = await selectSessionModel({ ...target, option: item.label }, overrides);
    assert.equal(output.parsed.selected, label);
    assert.equal(item.label, label);
    if (label === 'Extra high') assert.equal(result.completed, true);
    else assert.match(result.terminalOutput, /Select Reasoning Level/);
  }
});

test('model selection returns the real clipped reasoning menu instead of claiming completion', async () => {
  const commands = [];
  const result = await selectSessionModel({
    provider: 'codex', sessionName: 'work', threadId: 'thread-1', option: 'gpt-6-astra',
  }, {
    listTmuxSessions: async () => [{ name: 'work', agent: { kind: 'codex', id: 'thread-1', paneId: '%7' } }],
    capturePane: async () => commands.length ? NARROW_CODEX_REASONING_PICKER : NARROW_CODEX_MODEL_PICKER,
    execTmux: async args => commands.push(args),
    waitForSlashOutput: async () => {},
  });
  assert.match(result.terminalOutput, /Select Reasoning Level/);
  assert.match(result.terminalOutput, /Extra high \(current\)/);
  assert.equal(result.completed, undefined);
  assert.deepEqual(commands, [['send-keys', '-t', '%7', 'Enter']]);
});

test('model selection recognizes a fully clipped current badge after the default reasoning label', async () => {
  // Codex 0.153.2, 37x21, after selecting the current model at medium effort.
  const screen = `
  1. Low                Fast
                        responses
                        with
                        lighter
                        reasoning
› 2. Medium (default) … Balances
                        speed and
                        reasoning
                        depth for
                        everyday
                        tasks
  3. High               Greater
                        reasoning
                        depth for
                        complex
                        problems
  4. Extra high         Extra high

  Press enter to confirm or esc to go
`;
  const commands = [];
  const target = { provider: 'codex', sessionName: 'work', threadId: 'thread-1' };
  const overrides = {
    listTmuxSessions: async () => [{ name: 'work', agent: { kind: 'codex', id: 'thread-1', paneId: '%7' } }],
    capturePane: async () => commands.length ? screen : NARROW_CODEX_MODEL_PICKER,
    execTmux: async args => commands.push(args),
    waitForSlashOutput: async () => {},
  };
  const result = await selectSessionModel({ ...target, option: 'gpt-6-astra' }, overrides);
  const output = normalizeSessionCommandOutput('codex', '/model', result);
  assert.match(output.parsed.heading, /Select Reasoning Level/);
  assert.deepEqual(output.parsed.items.map(item => item.label), ['Low', 'Medium (default)', 'High', 'Extra high']);
  const completed = await selectSessionModel({ ...target, option: output.parsed.items[1].label }, {
    ...overrides,
    capturePane: async () => commands.length === 1 ? screen : EMPTY_CODEX_COMPOSER,
  });
  assert.equal(completed.completed, true);
});

test('an old model picker followed by a composer is not selectable', async () => {
  const commands = [];
  await assert.rejects(selectSessionModel({
    provider: 'codex', sessionName: 'work', threadId: 'thread-1', option: 'gpt-6-astra',
  }, {
    listTmuxSessions: async () => [{ name: 'work', agent: { kind: 'codex', id: 'thread-1', paneId: '%7' } }],
    capturePane: async () => `${NARROW_CODEX_MODEL_PICKER}\n${EMPTY_CODEX_COMPOSER}`,
    execTmux: async args => commands.push(args),
  }), /选择器已关闭/);
  assert.deepEqual(commands, []);
});

test('a transient blank model redraw cannot be mistaken for a completed selection', async () => {
  const screens = [NARROW_CODEX_MODEL_PICKER, '', NARROW_CODEX_REASONING_PICKER];
  const result = await selectSessionModel({
    provider: 'codex', sessionName: 'work', threadId: 'thread-1', option: 'gpt-6-astra',
  }, {
    listTmuxSessions: async () => [{ name: 'work', agent: { kind: 'codex', id: 'thread-1', paneId: '%7' } }],
    capturePane: async () => screens.shift() ?? NARROW_CODEX_REASONING_PICKER,
    execTmux: async () => {},
    waitForSlashOutput: async () => {},
  });
  assert.equal(result.completed, undefined);
  assert.match(result.terminalOutput, /Select Reasoning Level/);
});

test('explicitly closing a model popup dismisses only its matching native menu before plain input', async () => {
  const commands = [];
  const target = { provider: 'codex', sessionName: 'work', threadId: 'thread-1' };
  const overrides = {
    listTmuxSessions: async () => [{ name: 'work', agent: { kind: 'codex', id: 'thread-1', paneId: '%7' } }],
    capturePane: async () => commands.length ? EMPTY_CODEX_COMPOSER : NARROW_CODEX_MODEL_PICKER,
    loadBuffer: async () => {},
    execTmux: async args => commands.push(args),
    waitForPaste: async () => {},
    waitForSubmit: async () => {},
  };
  assert.deepEqual(await dismissSessionCommand({ ...target, command: '/model' }, overrides), { dismissed: true });
  const result = await sendSessionMessage({ ...target, text: 'Continue checking' }, overrides);
  assert.equal(result.submissionStatus, 'submitted');
  assert.deepEqual(commands[0], ['copy-mode', '-q', '-t', '%7', ';', 'send-keys', '-t', '%7', 'Escape']);
  assert.equal(commands.filter(args => args.includes('Enter')).length, 1);
});

test('closing an old command popup never interrupts work, confirms approvals, or dismisses another menu', async () => {
  for (const screen of [
    EMPTY_CODEX_COMPOSER,
    `• Working (25s • esc to interrupt)\n${EMPTY_CODEX_COMPOSER}`,
    'Choose response\n› 1. Approve\n  2. Deny\nPress enter to confirm or esc to go back',
    'Skills\n› 1. List skills\nPress enter to confirm or esc to go',
  ]) {
    const commands = [];
    const result = await dismissSessionCommand({
      provider: 'codex', sessionName: 'work', threadId: 'thread-1', command: '/model',
    }, {
      listTmuxSessions: async () => [{ name: 'work', agent: { kind: 'codex', id: 'thread-1', paneId: '%7' } }],
      capturePane: async () => screen,
      execTmux: async args => commands.push(args),
    });
    assert.deepEqual(result, { dismissed: false });
    assert.deepEqual(commands, []);
  }
});

test('bare /usage bypasses completion, selects Show usage, and waits past loading', async () => {
  const calls = [];
  const usagePicker = [
    'Usage',
    'View account usage or redeem an earned reset.',
    '',
    '› 1. Show usage                View recent account token usage.',
    '     Redeem usage limit reset  No usage limit resets available.',
    '',
    'Press enter to confirm or esc to go back',
  ].join('\n');
  const loading = [
    '/usage daily',
    '',
    'Token activity',
    '  Loading...',
    '',
    '› Ask Codex to do anything',
    '  gpt-5.6-sol · /data/codeck',
  ].join('\n');
  const loaded = [
    '╭────────────────────────╮',
    '│ OpenAI Codex           │',
    '╰────────────────────────╯',
    '/usage daily',
    '',
    'Token activity   last 12 months',
    'Lifetime 19.4B · Peak 1.14B',
    '',
    '› Ask Codex to do anything',
    '  gpt-5.6-sol · /data/codeck',
  ].join('\n');
  const screens = [
    EMPTY_CODEX_COMPOSER,
    EMPTY_CODEX_COMPOSER,
    usagePicker,
    ...Array(12).fill(loading),
    loaded,
  ];
  const result = await sendSessionMessage({
    provider: 'codex', sessionName: 'work', threadId: 'thread-1', text: '/usage',
  }, {
    listTmuxSessions: async () => [{
      name: 'work', agent: { kind: 'codex', id: 'thread-1', paneId: '%7' },
    }],
    execTmux: async (args) => calls.push({ type: 'exec', args }),
    waitForPaste: async () => {},
    waitForSlashOutput: async () => calls.push({ type: 'output-wait' }),
    capturePane: async () => screens.shift() || loaded,
  });

  assert.match(result.terminalOutput, /Token activity\s+last 12 months/);
  assert.doesNotMatch(result.terminalOutput, /Loading/);
  assert.doesNotMatch(result.terminalOutput, /OpenAI Codex/);
  assert.deepEqual(calls.filter((call) => call.type === 'exec').map((call) => call.args), [
    ['copy-mode', '-q', '-t', '%7', ';', 'send-keys', '-l', '-t', '%7', '--', '/usage '],
    ['copy-mode', '-q', '-t', '%7', ';', 'send-keys', '-t', '%7', 'Enter'],
    ['copy-mode', '-q', '-t', '%7', ';', 'send-keys', '-t', '%7', 'Enter'],
  ]);
});

test('recovers an identical /usage draft left by slash completion without duplicating it', async () => {
  const calls = [];
  const existingDraft = '› /usage\n\n  /usage  view account usage or use a usage limit reset';
  const picker = [
    'Usage',
    '› 1. Show usage                View recent account token usage.',
    'Press enter to confirm or esc to go back',
  ].join('\n');
  const loaded = [
    '/usage daily',
    'Token activity   last 12 months',
    'Lifetime 19.4B · Peak 1.14B',
    '› Ask Codex to do anything',
    '  gpt-5.6-sol · /data/codeck',
  ].join('\n');
  const screens = [existingDraft, existingDraft, picker, loaded];
  const result = await sendSessionMessage({
    provider: 'codex', sessionName: 'work', threadId: 'thread-1', text: '/usage',
  }, {
    listTmuxSessions: async () => [{
      name: 'work', agent: { kind: 'codex', id: 'thread-1', paneId: '%7' },
    }],
    execTmux: async (args) => calls.push(args),
    waitForPaste: async () => {},
    waitForSlashOutput: async () => {},
    capturePane: async () => screens.shift() || loaded,
  });

  assert.match(result.terminalOutput, /Token activity/);
  assert.deepEqual(calls[0], [
    'copy-mode', '-q', '-t', '%7', ';', 'send-keys', '-l', '-t', '%7', '--', ' ',
  ]);
  assert.equal(calls.flat().filter((value) => value === '/usage').length, 0);
});

test('resumes an already open /usage picker left by an earlier remote attempt', async () => {
  const calls = [];
  const picker = [
    'Usage',
    'View account usage or redeem an earned reset.',
    '› 1. Show usage                View recent account token usage.',
    '  2. Redeem usage limit reset  You have 2 usage limit resets available.',
    'Press enter to confirm or esc to go back',
  ].join('\n');
  const loaded = [
    '/usage daily',
    'Token activity   last 12 months',
    'Lifetime 19.4B · Peak 1.14B',
    '› Ask Codex to do anything',
    '  gpt-5.6-sol · /data/codeck',
  ].join('\n');
  const screens = [picker, picker, loaded];
  const result = await sendSessionMessage({
    provider: 'codex', sessionName: 'work', threadId: 'thread-1', text: '/usage',
  }, {
    listTmuxSessions: async () => [{
      name: 'work', agent: { kind: 'codex', id: 'thread-1', paneId: '%7' },
    }],
    execTmux: async (args) => calls.push(args),
    waitForPaste: async () => {},
    waitForSlashOutput: async () => {},
    capturePane: async () => screens.shift() || loaded,
  });

  assert.match(result.terminalOutput, /Token activity/);
  assert.deepEqual(calls, [[
    'copy-mode', '-q', '-t', '%7', ';', 'send-keys', '-t', '%7', 'Enter',
  ]]);
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

test('captures a narrow skills picker without confirming any selection', async () => {
  const calls = [];
  const picker = 'Skills\nChoose an action\n› 1. List skills  Open the list\n  2. Enable/Disable Sk…  Configure skills\nPress enter to confirm or esc to go';
  const result = await sendSessionMessage({
    provider: 'codex', sessionName: 'work', threadId: 'thread-1', text: '/skills',
  }, {
    listTmuxSessions: async () => [{
      name: 'work', agent: { kind: 'codex', id: 'thread-1', paneId: '%7' },
    }],
    execTmux: async (args) => calls.push({ type: 'exec', args }),
    waitForPaste: async () => calls.push({ type: 'wait' }),
    waitForSlashOutput: async () => {},
    capturePane: async (paneId) => {
      if (!calls.some((call) => call.type === 'exec')) return EMPTY_CODEX_COMPOSER;
      calls.push({ type: 'capture', paneId });
      return picker;
    },
  });

  assert.match(result.terminalOutput, /Skills\nChoose an action/);
  assert.deepEqual(calls.filter(call => call.type !== 'capture'), [
    { type: 'exec', args: ['copy-mode', '-q', '-t', '%7', ';', 'send-keys', '-l', '-t', '%7', '--', '/skills '] },
    { type: 'wait' },
    { type: 'exec', args: ['copy-mode', '-q', '-t', '%7', ';', 'send-keys', '-t', '%7', 'Enter'] },
  ]);
});

test('other local command popups isolate fresh output, wait for loading, and never echo old status boxes', async () => {
  for (const command of ['/mcp', '/ps']) {
    const commands = [];
    const old = `${command}\nOld command result\n/status\n╭────────────────╮\n│ Old status     │\n╰────────────────╯`;
    const initial = `${old}\n${EMPTY_CODEX_COMPOSER}`;
    const loading = `${old}\n• Loading inventory…\n${EMPTY_CODEX_COMPOSER}`;
    const loaded = `${old}\n${command}\n${command === '/mcp' ? 'MCP Tools\n• server: connected' : 'Background terminals\n• No background terminals running.'}\n${EMPTY_CODEX_COMPOSER}`;
    const screens = [initial, initial, loading, loaded];
    const result = await sendSessionMessage({
      provider: 'codex', sessionName: 'work', threadId: 'thread-1', text: command,
    }, {
      listTmuxSessions: async () => [{ name: 'work', agent: { kind: 'codex', id: 'thread-1', paneId: '%7' } }],
      capturePane: async () => screens.shift() || loaded,
      execTmux: async args => commands.push(args),
      waitForPaste: async () => {},
      waitForSlashOutput: async () => {},
    });
    assert.match(result.terminalOutput, command === '/mcp' ? /MCP Tools/ : /Background terminals/);
    assert.doesNotMatch(result.terminalOutput, /Old status|Loading|Ask Codex/);
    assert.equal(commands.length, 2);
  }
});

test('a slash command that starts Agent work returns promptly without a fake local-output popup', async () => {
  let submitted = false;
  let polls = 0;
  const result = await sendSessionMessage({ provider: 'codex', sessionName: 'work', threadId: 'thread-1', text: '/review' }, {
    listTmuxSessions: async () => [{ name: 'work', agent: { kind: 'codex', id: 'thread-1', paneId: '%7' } }],
    capturePane: async () => submitted ? '• Working (1s • esc to interrupt)' : EMPTY_CODEX_COMPOSER,
    execTmux: async args => { if (args.includes('Enter')) submitted = true; },
    waitForPaste: async () => {}, waitForSlashOutput: async () => { polls += 1; },
  });
  assert.deepEqual(result, { terminalWorking: true });
  assert.equal(polls, 1);
});

test('recovers a matching completion draft for other bare Codex slash commands', async () => {
  const calls = [];
  const existingDraft = '› /skills\n\n  /skills  view and use Skills';
  const result = await sendSessionMessage({
    provider: 'codex', sessionName: 'work', threadId: 'thread-1', text: '/skills',
  }, {
    listTmuxSessions: async () => [{
      name: 'work', agent: { kind: 'codex', id: 'thread-1', paneId: '%7' },
    }],
    execTmux: async (args) => calls.push(args),
    waitForPaste: async () => {},
    waitForSlashOutput: async () => {},
    capturePane: async () => existingDraft,
  });

  assert.deepEqual(result, {});
  assert.deepEqual(calls, [
    ['copy-mode', '-q', '-t', '%7', ';', 'send-keys', '-l', '-t', '%7', '--', ' '],
    ['copy-mode', '-q', '-t', '%7', ';', 'send-keys', '-t', '%7', 'Enter'],
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
    capturePane: async () => EMPTY_CODEX_COMPOSER,
    waitForSubmit: async () => {},
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
        'paste-buffer', '-p', '-d', '-b', 'codeck-pending-test', '-t', '%7',
      ],
    },
    { type: 'wait' },
    { type: 'exec', args: ['copy-mode', '-q', '-t', '%7', ';', 'send-keys', '-t', '%7', 'Enter'] },
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

test('goal switching interrupts once and verifies the exact Agent pane has stopped', async () => {
  for (const provider of ['codex', 'claude', 'qodercli']) {
    const commands = []; let busy = true; let waits = 0;
    await interruptSession({ provider, sessionName: 'work', threadId: 'thread-1',
      expectedPaneId: '%7', isCurrent: () => true, waitForIdle: true,
    }, {
      listTmuxSessions: async () => [{ name: 'work', hasRunningProcess: busy,
        agent: { kind: provider, id: 'thread-1', paneId: '%7' } }],
      execTmux: async args => commands.push(args),
      waitForStop: async () => { waits++; busy = false; },
    });
    assert.deepEqual(commands, [['send-keys', '-t', '%7', 'Escape']], provider);
    assert.equal(waits, 1, provider);
  }
});

test('goal switching preserves unrelated background tasks and rejects stale cancellation without keys', async () => {
  for (const scenario of ['background', 'cancelled', 'replaced', 'idle']) {
    const commands = [];
    const stopped = interruptSession({ provider: 'codex', sessionName: 'work', threadId: 'thread-1',
      expectedPaneId: '%7', isCurrent: () => scenario !== 'cancelled', waitForIdle: true,
    }, {
      listTmuxSessions: async () => [{ name: 'work', hasRunningProcess: scenario !== 'idle',
        agent: { kind: 'codex', id: 'thread-1', paneId: scenario === 'replaced' ? '%8' : '%7',
          hasBackgroundProcess: scenario === 'background' } }],
      execTmux: async args => commands.push(args), waitForStop: async () => {},
    });
    if (scenario === 'idle') await stopped;
    else await assert.rejects(stopped, /后台|暂停|变化/);
    assert.deepEqual(commands, [], scenario);
  }
});

test('goal switching fails closed on timeout, replacement, background work or pause during stop', async () => {
  for (const scenario of ['timeout', 'replacement', 'background', 'pause']) {
    const commands = []; let waits = 0;
    await assert.rejects(interruptSession({ provider: 'codex', sessionName: 'work', threadId: 'thread-1',
      expectedPaneId: '%7', isCurrent: () => scenario !== 'pause' || !waits, waitForIdle: true,
    }, {
      listTmuxSessions: async () => [{ name: 'work', hasRunningProcess: true,
        agent: { kind: 'codex', id: 'thread-1', paneId: scenario === 'replacement' && waits ? '%8' : '%7',
          hasBackgroundProcess: scenario === 'background' && waits > 0 } }],
      execTmux: async args => commands.push(args), waitForStop: async () => { waits++; },
    }), /停止|后台|变化|暂停/);
    assert.deepEqual(commands, [['send-keys', '-t', '%7', 'Escape']], scenario);
    assert.ok(waits <= 20, 'stop confirmation has a finite timeout');
  }
});

function codexStopFixture({ busy = false, goal = true, background = true } = {}) {
  const f = { busy, goal, background, current: true, pane: '%7', draft: '', commands: [], waits: 0 };
  f.params = { provider: 'codex', sessionName: 'research', threadId: 'thread-1',
    expectedPaneId: '%7', isCurrent: () => f.current, waitForIdle: true, stopBackground: true };
  f.options = {
    listTmuxSessions: async () => [{ name: 'research', hasRunningProcess: f.busy,
      agent: { kind: 'codex', id: 'thread-1', paneId: f.pane, hasBackgroundProcess: f.background } }],
    capturePane: async () => `${f.background ? '2 background terminals running · /ps to view · /stop to close\n' : ''}\n» ${f.draft}\n\n  gpt-6-astra ultra · ~/py${f.goal ? '    Goal stalled (/goal resume)' : ''}`,
    execTmux: async args => {
      f.commands.push(args);
      if (args.includes('Escape')) f.busy = false;
      if (args.includes('-l')) f.draft = args.at(-1).trimEnd();
      if (args.at(-1) === 'Enter') {
        if (f.draft === '/goal clear') f.goal = false;
        if (f.draft === '/stop' && !f.keepBackground) f.background = false;
        f.draft = '';
      }
    },
    waitForStop: async () => { f.waits++; }, waitForPaste: async () => {},
    invalidatePaneSnapshot() {},
  };
  return f;
}

test('confirmed Codex replacement stops foreground, native Goal and session background terminals', async () => {
  for (const busy of [false, true]) {
    const f = codexStopFixture({ busy });
    await interruptSession(f.params, f.options);
    assert.equal(f.busy, false); assert.equal(f.goal, false); assert.equal(f.background, false);
    assert.deepEqual(f.commands.filter(args => args.includes('-l')).map(args => args.at(-1).trim()), ['/goal clear', '/stop']);
    assert.equal(f.commands.filter(args => args.includes('Escape')).length, Number(busy));
    assert.equal(f.commands.filter(args => args.at(-1) === 'Enter').length, 2);
    assert.ok(f.commands.every(args => args[args.indexOf('-t') + 1] === '%7'));
  }
});

test('background stop protects drafts and checks pause, identity and input before Enter', async () => {
  for (const scenario of ['draft', 'modal', 'pause', 'replacement', 'edited']) {
    const f = codexStopFixture({ goal: false });
    if (scenario === 'draft') f.draft = 'my unsent work';
    if (scenario === 'modal') f.options.capturePane = async () => 'Select Model and Effort\n› 1. model\nPress enter to confirm or esc to go back';
    f.options.waitForPaste = async () => {
      if (scenario === 'pause') f.current = false;
      if (scenario === 'replacement') f.pane = '%8';
      if (scenario === 'edited') f.draft += ' user edit';
    };
    await assert.rejects(interruptSession(f.params, f.options), /草稿|弹窗|变化|暂停|未停止/);
    assert.equal(f.background, true);
    assert.equal(f.commands.some(args => args.at(-1) === 'Enter'), false, scenario);
    if (['draft', 'modal'].includes(scenario)) assert.deepEqual(f.commands, [], scenario);
  }
});

test('native stop is not replayed and lingering processes fail closed within a finite check', async () => {
  const f = codexStopFixture({ goal: false }); f.keepBackground = true;
  await assert.rejects(interruptSession(f.params, f.options), /后台|停止/);
  assert.equal(f.commands.filter(args => args.includes('-l')).length, 1);
  assert.equal(f.commands.filter(args => args.at(-1) === 'Enter').length, 1);
  assert.ok(f.waits > 0 && f.waits <= 40);
});

test('typing the native stop command is not mistaken for a newly running Agent turn', async () => {
  const f = codexStopFixture({ background: false });
  const list = f.options.listTmuxSessions;
  f.options.listTmuxSessions = async () => {
    const sessions = await list();
    // The ordinary status detector treats a changed composer as animation.
    sessions[0].hasRunningProcess = Boolean(f.draft);
    return sessions;
  };
  await interruptSession(f.params, f.options);
  assert.equal(f.goal, false);
  assert.equal(f.commands.filter(args => args.at(-1) === 'Enter').length, 1);
});

test('replacement retires native background terminals even after their child processes exited', async () => {
  const f = codexStopFixture({ goal: false });
  const list = f.options.listTmuxSessions;
  f.options.listTmuxSessions = async () => {
    const sessions = await list(); sessions[0].agent.hasBackgroundProcess = false; return sessions;
  };
  await interruptSession(f.params, f.options);
  assert.equal(f.background, false, 'native terminal footer must not block the next guarded send');
  assert.deepEqual(f.commands.filter(args => args.includes('-l')).map(args => args.at(-1).trim()), ['/stop']);
});

test('Codex replacement allows the six-second repaint heuristic to settle after Escape', async () => {
  const f = codexStopFixture({ busy: true, goal: false, background: false });
  const list = f.options.listTmuxSessions;
  f.options.listTmuxSessions = async () => {
    const sessions = await list(); sessions[0].hasRunningProcess = f.busy || f.waits < 24; return sessions;
  };
  await interruptSession(f.params, f.options);
  assert.equal(f.commands.filter(args => args.includes('Escape')).length, 1);
  assert.ok(f.waits >= 24 && f.waits <= 40);
});

test('background cancellation never guesses another provider native command', async () => {
  for (const provider of ['claude', 'qodercli']) {
    const commands = [];
    await assert.rejects(interruptSession({ provider, sessionName: 'work', threadId: 'thread-1',
      expectedPaneId: '%7', waitForIdle: true, stopBackground: true,
    }, {
      listTmuxSessions: async () => [{ name: 'work', agent: { kind: provider, id: 'thread-1', paneId: '%7', hasBackgroundProcess: true } }],
      execTmux: async args => commands.push(args),
    }), /后台/);
    assert.deepEqual(commands, []);
  }
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
    capturePane: async () => EMPTY_CODEX_COMPOSER,
    waitForPaste: async () => {},
    waitForSubmit: async () => {},
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

test('a static Codex background wait stays working without an interrupt hint or a local child process', () => {
  for (const marker of [
    '• Waiting for background terminal (2h 04m)',
    '◦ Waiting for background terminal',
    '\x1b[2m• Waiting for background terminal (25s)\x1b[0m',
  ]) {
    for (const footer of [CODEX_IDLE, CODEX_BACKGROUND]) {
      const screen = `${marker}\n${footer}`;
      const screenSignals = { ...signals(screen, 'codex'), animating: false };
      const agent = { kind: 'codex', id: 'thread-1' };
      const session = {
        hasRunningProcess: resolveWorkingState({ agentKind: 'codex', screenSignals }),
        agent: { ...agent, hasBackgroundProcess: resolveAgentBackgroundState({ agent, screenSignals }) },
      };
      assert.equal(screenSignals.busy, true, screen);
      assert.equal(session.agent.hasBackgroundProcess, false);
      assert.equal(resolveSessionStatus(session), 'working');
      assert.equal(sessionSnapshotRefreshInterval({ sessions: [{ status: resolveSessionStatus(session) }] }), 750);
    }
  }
});

test('Codex background waiting has an explicit activity label and remains visible as live output', () => {
  const screen = `• Ran npm test\n• Waiting for background terminal (25s)\n${CODEX_BACKGROUND}`;
  assert.equal(resolveAgentActivityText('codex', screen), '等待后台进程 · 25秒');
  assert.equal(resolveAgentLiveOutput('codex', screen), '• Ran npm test\n• Waiting for background terminal (25s)');
});

test('recognizes a Codex waiting label clipped to the supported narrow terminal widths', () => {
  const marker = '• Waiting for background terminal (2h 04m)';
  for (let cols = 20; cols < marker.length; cols += 1) {
    const clipped = `${marker.slice(0, cols - 1)}…`;
    assert.equal(signals(`${clipped}\n${CODEX_IDLE}`, 'codex').busy, true, clipped);
    assert.equal(resolveAgentActivityText('codex', `${clipped}\n${CODEX_IDLE}`), '等待后台进程');
  }
});

test('a later normal Codex turn replaces the waiting activity label', () => {
  const screen = `• Waiting for background terminal (25s)\n◦ Working (1s • esc to interrupt)\n${CODEX_IDLE}`;
  assert.equal(resolveAgentActivityText('codex', screen), '正在处理 · 1秒');
});

test('a completed Codex wait does not keep the session working', () => {
  for (const history of [
    '• Waited for background terminal · sleep 30',
    '• Explained Waiting for background terminal',
    '  Waiting for background terminal is a status label.',
    '> Waiting for background terminal',
    '• Waiting for backup…',
    '• Waiting for background task…',
  ]) {
    const screen = `${history}\n${CODEX_BACKGROUND}`;
    const screenSignals = { ...signals(screen, 'codex'), animating: false };
    const hasRunningProcess = resolveWorkingState({ agentKind: 'codex', screenSignals });
    assert.equal(hasRunningProcess, false, history);
    assert.equal(resolveSessionStatus({ hasRunningProcess, agent: { kind: 'codex' } }), 'done');
    assert.equal(resolveSessionStatus({
      hasRunningProcess, agent: { kind: 'codex', hasBackgroundProcess: true },
    }), 'background');
  }
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
    verifyPane: async () => true,
  });
  assert.equal(submitted, 'submitted', '输入框本来就空, 不该补发');

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
    verifyPane: async () => true,
  });
  assert.equal(retried, 'submitted');
  assert.deepEqual(sent, ['copy-mode -q -t %0 ; send-keys -t %0 Enter'], '只补一次, 且确认后不再重复');
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
  assert.equal(submitted, 'unconfirmed');
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
    verifyPane: async () => true,
  });
  assert.equal(submitted, 'submitted');
  assert.equal(enters, 0, '消息已经发出去了, 不该再补 Enter');
});

test('submission confirmation recognizes every supported composer prefix and verifies before retrying', async () => {
  for (const prefix of ['»', '›', '>', '❯']) {
    const calls = [];
    let draft = '分析下BABA当前投资价值 推送到notion';
    const status = await ensureAgentInputSubmitted({
      paneId: '%7', text: draft,
      capturePane: async () => { calls.push('capture'); return `${prefix} ${draft}\n\n  gpt-6-astra · /project`; },
      verifyPane: async () => { calls.push('verify'); return true; },
      waitForSubmit: async () => {},
      execTmux: async (args) => { calls.push(args); draft = ''; },
    });
    assert.equal(status, 'submitted', prefix);
    assert.deepEqual(calls.slice(0, 4), [
      'capture', 'verify', 'capture', ['copy-mode', '-q', '-t', '%7', ';', 'send-keys', '-t', '%7', 'Enter'],
    ], prefix);
    assert.equal(calls.filter(Array.isArray).length, 1, 'retry Enter only; never replay the message');
  }
});

test('submission confirmation never presses Enter for a partial match, changed draft, modal, or unknown screen', async () => {
  const text = 'Review the complete draft';
  for (const screen of [
    `» ${text} but do not submit this edit\n\n  gpt-6-astra · /project`,
    '» Review the other draft\n\n  gpt-6-astra · /project',
    '» Reviewthe complete draft\n\n  gpt-6-astra · /project',
    `» ${text}\n  an additional line\n\n  gpt-6-astra · /project`,
    `Select Model and Effort\n› ${text}\nPress enter to confirm or esc to go back`,
    `» ${text}\n\nSome transcript output without a visible composer`,
    '» [Pasted Content 1234 chars]\n\n  gpt-6-astra · /project',
    '', 'redrawing',
  ]) {
    let enters = 0;
    const status = await ensureAgentInputSubmitted({
      paneId: '%7', text, capturePane: async () => screen,
      verifyPane: async () => true, waitForSubmit: async () => {},
      execTmux: async () => { enters += 1; },
    });
    assert.equal(status, 'unconfirmed', screen);
    assert.equal(enters, 0, screen);
  }
});

test('submission confirmation rechecks both identity and the full draft immediately before retrying', async () => {
  for (const change of ['pane', 'draft', 'capture-error']) {
    let captures = 0;
    let enters = 0;
    const status = await ensureAgentInputSubmitted({
      paneId: '%7', text: 'Original draft',
      capturePane: async () => {
        captures += 1;
        if (change === 'capture-error' && captures > 1) throw new Error('pane unavailable');
        return `» ${change === 'draft' && captures > 1 ? 'Another draft' : 'Original draft'}\n\n  gpt-6-astra · /project`;
      },
      verifyPane: async () => change !== 'pane', waitForSubmit: async () => {},
      execTmux: async () => { enters += 1; },
    });
    assert.equal(status, 'unconfirmed', change);
    assert.equal(enters, 0, change);
  }
});

test('submission confirmation bounds Enter retries and reports a permanently stuck draft', async () => {
  let enters = 0;
  const status = await ensureAgentInputSubmitted({
    paneId: '%7', text: 'Still pending',
    capturePane: async () => '» Still pending\n\n  gpt-6-astra · /project',
    verifyPane: async () => true, waitForSubmit: async () => {},
    execTmux: async () => { enters += 1; },
  });
  assert.equal(status, 'unconfirmed');
  assert.equal(enters, 3);
});

test('submission confirmation matches the complete multiline composer, including blank lines and spaces', async () => {
  let draft = 'Review\n\n  mobile layout';
  let enters = 0;
  const status = await ensureAgentInputSubmitted({
    paneId: '%7', text: draft,
    capturePane: async () => `» ${draft.replaceAll('\n', '\n  ')}\n\n  gpt-6-astra · /project`,
    verifyPane: async () => true, waitForSubmit: async () => {},
    execTmux: async () => { enters += 1; draft = ''; },
  });
  assert.equal(status, 'submitted');
  assert.equal(enters, 1);
});

test('Codex paste and Enter are separated beyond its paste-burst window, even when the first Enter is consumed', async () => {
  for (const [text, pasteDelay] of [['Review mobile', 0], ['Review\nmobile', 0], ['Review\nmobile', 500]]) {
    let clock = 0;
    let loaded = '';
    let pastedAt = null;
    let draft = '';
    let consumedFirstEnter = false;
    const inputTimes = [];
    const result = await sendSessionMessage({
      provider: 'codex', sessionName: 'burst', threadId: 'thread-1', text,
    }, {
      listTmuxSessions: async () => [{ name: 'burst', agent: { kind: 'codex', id: 'thread-1', paneId: '%7' } }],
      loadBuffer: async (_name, value) => { loaded = value; },
      waitForPaste: async (delay) => { assert.ok(delay >= 200); clock += delay; },
      waitForSubmit: async (delay) => { assert.ok(delay >= 200); clock += delay; },
      capturePane: async () => {
        if (pastedAt !== null && clock >= pastedAt + pasteDelay) { draft = loaded; pastedAt = null; }
        return `» ${draft.replaceAll('\n', '\n  ')}\n\n  gpt-6-astra · /project`;
      },
      execTmux: async (args) => {
        if (args.includes('paste-buffer')) {
          assert.ok(args.includes('-p'), 'Codex uses explicit bracketed paste');
          assert.equal(args.includes('Enter'), false, 'paste and Enter must be separate commands');
          pastedAt = clock;
        }
        if (args.includes('Enter')) {
          inputTimes.push(clock);
          if (!consumedFirstEnter) consumedFirstEnter = true;
          else draft = '';
        }
      },
    });
    assert.equal(result.submissionStatus, 'submitted');
    assert.equal(inputTimes.length, 2, `one initial Enter and one safe retry for paste delay ${pasteDelay}`);
    assert.ok(inputTimes[0] >= 200);
    assert.ok(inputTimes[1] - inputTimes[0] >= 200);
  }
});

test('Codex reports a stuck or unobservable submission rather than treating terminal delivery as confirmation', async () => {
  for (const screen of ['» Still pending\n\n  gpt-6-astra · /project', '', 'redrawing']) {
    let loads = 0;
    let pasted = false;
    const result = await sendSessionMessage({
      provider: 'codex', sessionName: 'unconfirmed', threadId: 'thread-1', text: 'Still pending',
    }, {
      listTmuxSessions: async () => [{ name: 'unconfirmed', agent: { kind: 'codex', id: 'thread-1', paneId: '%7' } }],
      loadBuffer: async () => { loads += 1; },
      execTmux: async (args) => { if (args.includes('paste-buffer')) pasted = true; },
      waitForPaste: async () => {}, waitForSubmit: async () => {},
      capturePane: async () => pasted ? screen : EMPTY_CODEX_COMPOSER,
    });
    assert.deepEqual(result, { submissionStatus: 'unconfirmed' });
    assert.equal(loads, 1, 'an uncertain submission never replays its text');
  }
});

test('Codex does not send its initial delayed Enter after its pane or Agent identity changes', async () => {
  for (const change of [{ paneId: '%8' }, { kind: 'claude' }, { id: 'other-thread' }]) {
    let pasted = false;
    const commands = [];
    const result = await sendSessionMessage({
      provider: 'codex', sessionName: 'changed', threadId: 'thread-1', text: 'Do not execute elsewhere',
    }, {
      listTmuxSessions: async () => [{
        name: 'changed', agent: { kind: 'codex', id: 'thread-1', paneId: '%7', ...(pasted ? change : {}) },
      }],
      loadBuffer: async () => {},
      execTmux: async (args) => { commands.push(args); if (args.includes('paste-buffer')) pasted = true; },
      waitForPaste: async () => {}, waitForSubmit: async () => {}, capturePane: async () => EMPTY_CODEX_COMPOSER,
    });
    assert.deepEqual(result, { submissionStatus: 'unconfirmed' });
    assert.equal(commands.filter((args) => args.includes('paste-buffer')).length, 1);
    assert.equal(commands.some((args) => args.includes('Enter')), false);
  }
});

test('Codex returns unconfirmed if Enter fails after the text was already pasted', async () => {
  let loads = 0;
  const result = await sendSessionMessage({
    provider: 'codex', sessionName: 'enter-failure', threadId: 'thread-1', text: 'Do not paste twice',
  }, {
    listTmuxSessions: async () => [{ name: 'enter-failure', agent: { kind: 'codex', id: 'thread-1', paneId: '%7' } }],
    loadBuffer: async () => { loads += 1; },
    execTmux: async (args) => { if (args.includes('Enter')) throw new Error('tmux failed after paste'); },
    waitForPaste: async () => {}, waitForSubmit: async () => {}, capturePane: async () => EMPTY_CODEX_COMPOSER,
  });
  assert.deepEqual(result, { submissionStatus: 'unconfirmed' });
  assert.equal(loads, 1);
});

test('submission confirmation revalidates identity before accepting another screen as submitted', async () => {
  for (const screen of ['» \n\n  gpt-6-astra · /project', '◦ Working (1s • esc to interrupt)']) {
    let enters = 0;
    const status = await ensureAgentInputSubmitted({
      paneId: '%7', text: 'Original draft', capturePane: async () => screen,
      verifyPane: async () => false, waitForSubmit: async () => {},
      execTmux: async () => { enters += 1; },
    });
    assert.equal(status, 'unconfirmed');
    assert.equal(enters, 0);
  }
});

test('submission confirmation distinguishes new activity from an old busy turn with an unverified draft', async () => {
  for (const [screen, allowBusy, expected] of [
    ['◦ Working (1s • esc to interrupt)', true, 'submitted'],
    ['◦ Working (1s • esc to interrupt)', false, 'unconfirmed'],
    ['◦ Working (1s • esc to interrupt)\n» Another draft\n\n  gpt-6-astra · /project', true, 'unconfirmed'],
    ['◦ Working (1s • esc to interrupt)\n» [Pasted Content 1234 chars]\n\n  gpt-6-astra · /project', true, 'submitted'],
  ]) {
    let enters = 0;
    const status = await ensureAgentInputSubmitted({
      paneId: '%7', text: 'Original draft', allowBusy, capturePane: async () => screen,
      verifyPane: async () => true, waitForSubmit: async () => {},
      execTmux: async () => { enters += 1; },
    });
    assert.equal(status, expected);
    assert.equal(enters, 0);
  }
});

test('submission confirmation recognizes the real idle Codex placeholder without confusing it with the sent text', async () => {
  for (const [text, expected, expectedEnters] of [
    ['Analyze the investment thesis', 'submitted', 0],
    ['Ask Codex to do anything', 'unconfirmed', 3],
  ]) {
    let enters = 0;
    const status = await ensureAgentInputSubmitted({
      paneId: '%7', text,
      capturePane: async () => '» Ask Codex to do anything\n\n  gpt-6-astra ultra fast · /project',
      verifyPane: async () => true, waitForSubmit: async () => {},
      execTmux: async () => { enters += 1; },
    });
    assert.equal(status, expected);
    assert.equal(enters, expectedEnters);
  }
});

test('submission confirmation requests tmux soft-wrap joining without erasing hard newlines in the draft', async () => {
  const text = '分析下BABA当前投资价值 推送到notion';
  let enters = 0;
  const status = await ensureAgentInputSubmitted({
    paneId: '%7', text,
    capturePane: async (_paneId, { joinWrapped } = {}) => {
      const draft = enters ? '' : joinWrapped ? text : '分析下BABA当前投资价值\n 推送到notion';
      return `» ${draft}\n\n  gpt-6-astra · /project`;
    },
    verifyPane: async () => true, waitForSubmit: async () => {},
    execTmux: async () => { enters += 1; },
  });
  assert.equal(status, 'submitted');
  assert.equal(enters, 1);
});

test('Codex replaces occupied or unreadable composers without a layout gate', async () => {
  const screens = [
    '» 分析下BABA当前投资价值 推送到notion\n\n  gpt-6-astra · /project',
    '› 怎么样了\n\n  gpt-6-astra · /project',
    '» Existing draft\n  second line\n\n  gpt-6-astra · /project',
    '» Existing wrapped draft\ncontinuation\n\n  gpt-6-astra · /project',
    '» \n  Existing second line\n\n  gpt-6-astra · /project',
    '» Existing draft\n  › \n\n  gpt-6-astra · /project',
    '› /status\n\n  /status  user-authored second line\n\n  gpt-6-astra · /project',
    '» \n  ----------\n  Existing second line\n\n  gpt-6-astra · /project',
    '» \n  gpt-fake · /pretend-footer\n  Existing second line\n\n  gpt-6-astra · /project',
    '» \n  gpt-fake · /pretend-footer\n\n  gpt-6-astra · /project',
    '» [Pasted Content 1234 chars]\n\n  gpt-6-astra · /project',
    '', 'redrawing', null,
  ];
  for (const text of ['怎么样了', '/status', '/model', '/usage']) {
    for (const screen of screens) {
      const commands = [];
      let loads = 0;
      await sendSessionMessage({
        provider: 'codex', sessionName: 'preflight', threadId: 'thread-1', text,
      }, {
        listTmuxSessions: async () => [{ name: 'preflight', agent: { kind: 'codex', id: 'thread-1', paneId: '%7' } }],
        loadBuffer: async () => { loads += 1; },
        execTmux: async (args) => commands.push(args),
        waitForPaste: async () => {}, waitForSubmit: async () => {}, waitForSlashOutput: async () => {},
        capturePane: async () => {
          if (screen === null) throw new Error('capture failed');
          if (commands.some((args) => args.includes('Enter') || args.includes('C-u'))) return '› \n\n  gpt-6-astra · /project';
          return screen;
        },
      });
      assert.equal(commands.filter((args) => args.includes('Enter')).length, 1, `${text}: ${screen}`);
      assert.equal(commands.some((args) => args.includes('C-u') && args.includes('C-k')), true);
      assert.equal(commands.some((args) => args.includes('Escape') || args.includes('C-c')), false);
      assert.equal(loads, text.startsWith('/') ? 0 : 1);
    }
  }
});

test('ordinary messages cancel a local command picker but do not send while it remains visible', async () => {
  const commands = [];
  const picker = [
    'Skills',
    'Choose an action',
    '› 1. List skills',
    'Press enter to confirm or esc to go back',
  ].join('\n');
  await assert.rejects(sendSessionMessage({
    provider: 'codex', sessionName: 'preflight', threadId: 'thread-1', text: 'Continue',
  }, {
    listTmuxSessions: async () => [{
      name: 'preflight', agent: { kind: 'codex', id: 'thread-1', paneId: '%7' },
    }],
    execTmux: async (args) => commands.push(args),
    loadBuffer: async () => {}, waitForPaste: async () => {},
    capturePane: async () => picker,
  }), /消息未发送.*终端|终端.*消息未发送/);
  assert.equal(commands.some((args) => args.includes('Escape')), true);
  assert.equal(commands.some((args) => args.includes('Enter') || args.includes('paste-buffer')), false);
});

test('Codex preflight allows a complete empty or placeholder composer even during a running turn', async () => {
  for (const composer of ['» ', '› ', '» Ask Codex to do anything', '› Ask Codex to do anything']) {
    const commands = [];
    const result = await sendSessionMessage({
      provider: 'codex', sessionName: 'preflight-empty', threadId: 'thread-1', text: 'Follow up',
    }, {
      listTmuxSessions: async () => [{ name: 'preflight-empty', hasRunningProcess: true, agent: { kind: 'codex', id: 'thread-1', paneId: '%7' } }],
      loadBuffer: async () => {}, execTmux: async (args) => commands.push(args),
      waitForPaste: async () => {}, waitForSubmit: async () => {}, waitForQueuedInput: async () => {},
      capturePane: async () => `◦ Working (1s • esc to interrupt)\n${composer}\n\n  gpt-6-astra · /project`,
    });
    assert.deepEqual(result, { inputWasQueued: true, submissionStatus: 'submitted' });
    assert.equal(commands.filter((args) => args.includes('paste-buffer')).length, 1);
    assert.equal(commands.filter((args) => args.includes('Enter')).length, 1);
  }
});

test('Codex replacement checks pane identity after the asynchronous buffer load', async () => {
  for (const change of ['pane', 'agent', 'thread']) {
    let loaded = false;
    const commands = [];
    await assert.rejects(sendSessionMessage({
      provider: 'codex', sessionName: 'preflight-race', threadId: 'thread-1', text: 'New message',
    }, {
      listTmuxSessions: async () => [{
        name: 'preflight-race', agent: {
          kind: loaded && change === 'agent' ? 'claude' : 'codex',
          id: loaded && change === 'thread' ? 'thread-2' : 'thread-1',
          paneId: loaded && change === 'pane' ? '%8' : '%7',
        },
      }],
      loadBuffer: async () => { loaded = true; }, execTmux: async (args) => commands.push(args),
      waitForPaste: async () => {}, waitForSubmit: async () => {},
      capturePane: async () => `» ${loaded && change === 'draft' ? 'Typed locally while loading' : ''}\n\n  gpt-6-astra · /project`,
    }), /pane 已变化/, change);
    assert.equal(commands.some((args) => args.includes('paste-buffer') || args.includes('send-keys')), false, change);
    assert.equal(commands.filter((args) => args[0] === 'delete-buffer').length, 1, change);
  }
});

test('Codex preflight recognizes the existing o3 and codex-mini footer identities', async () => {
  for (const model of ['o3', 'codex-mini']) {
    const commands = [];
    await sendSessionMessage({
      provider: 'codex', sessionName: 'preflight-model', threadId: 'thread-1', text: 'Follow up',
    }, {
      listTmuxSessions: async () => [{ name: 'preflight-model', agent: { kind: 'codex', id: 'thread-1', paneId: '%7' } }],
      loadBuffer: async () => {}, execTmux: async (args) => commands.push(args),
      waitForPaste: async () => {}, waitForSubmit: async () => {},
      capturePane: async () => `› Ask Codex to do anything\n\n  ${model} high · /project`,
    });
    assert.equal(commands.filter((args) => args.includes('paste-buffer')).length, 1, model);
    assert.equal(commands.filter((args) => args.includes('Enter')).length, 1, model);
  }
});

test('real narrow Codex composers accept messages and slash commands with clipped footers', async () => {
  for (const screen of NARROW_CODEX_COMPOSERS) {
    for (const text of ['怎么样了', '/status']) {
      const commands = [];
      const result = await sendSessionMessage({
        provider: 'codex', sessionName: 'narrow', threadId: 'thread-1', text,
      }, {
        listTmuxSessions: async () => [{ name: 'narrow', agent: { kind: 'codex', id: 'thread-1', paneId: '%7' } }],
        loadBuffer: async () => {}, execTmux: async (args) => commands.push(args),
        waitForPaste: async () => {}, waitForSubmit: async () => {}, waitForSlashOutput: async () => {},
        capturePane: async () => screen,
      });
      if (!text.startsWith('/')) assert.equal(result.submissionStatus, 'submitted');
      assert.equal(commands.filter((args) => args.includes('Enter')).length, 1);
    }
  }
});

test('narrow Codex confirmation retries only the exact draft then recognizes the clipped placeholder', async () => {
  for (const text of ['怎么样了', 'Ask Codex to do anyth']) {
    let enters = 0;
    const result = await ensureAgentInputSubmitted({
      paneId: '%7', text, verifyPane: async () => true, waitForSubmit: async () => {},
      execTmux: async () => { enters += 1; },
      capturePane: async () => enters ? NARROW_CODEX_COMPOSERS[0]
        : `\x1b[1m›\x1b[0m ${text}\n \n  \x1b[38;2;246;226;183mgpt-6-astra xhigh fas…`,
    });
    assert.equal(result, 'submitted');
    assert.equal(enters, 1);
  }
});

test('autonomous input accepts the report paused-goal footer but never clears a real draft', async () => {
  for (const draft of ['', '保留这份草稿', '\n  第二行草稿']) {
    const commands = [];
    const sending = sendSessionMessage({ provider: 'codex', sessionName: 'report', threadId: 'thread-1',
      text: '按确认方案执行', requireIdle: true, isCurrent: () => true, expectedPaneId: '%3' }, {
      listTmuxSessions: async () => [{ name: 'report', agent: { kind: 'codex', id: 'thread-1', paneId: '%3' } }],
      loadBuffer: async () => {}, execTmux: async args => commands.push(args),
      waitForPaste: async () => {}, waitForSubmit: async () => {},
      capturePane: async () => `› ${draft || '\x1b[2mAsk Codex to do anything\x1b[0m'}\n\n  gpt-6… Goal paused (/goal resume)`,
    });
    if (draft) { await assert.rejects(sending, /未就绪/); assert.equal(commands.length, 0); }
    else { assert.equal((await sending).submissionStatus, 'submitted'); assert.equal(commands.filter(args => args.includes('Enter')).length, 1); }
    assert.equal(commands.some(args => args.includes('C-u') || args.includes('Escape')), false);
  }
});

test('narrow Codex replacement clears drafts resembling truncated placeholders and footers', async () => {
  for (const draft of [
    'Ask Codex to do anyth', '\x1b[38;2;2;2;2mAsk Codex to do anyth',
    '\x1b[2;22mAsk Codex to do anyth', '\x1b[2mAsk Codex\x1b[0m to do anyth',
    '\x1b[2mAsk Codex to do anyth\n  keep this second line',
    '\n  gpt-6-astra xhigh fas…\n  keep this second line',
  ]) {
    const commands = [];
    await sendSessionMessage({
      provider: 'codex', sessionName: 'narrow', threadId: 'thread-1', text: 'Continue',
    }, {
      listTmuxSessions: async () => [{ name: 'narrow', agent: { kind: 'codex', id: 'thread-1', paneId: '%7' } }],
      loadBuffer: async () => {}, execTmux: async (args) => commands.push(args),
      waitForPaste: async () => {}, waitForSubmit: async () => {},
      capturePane: async () => commands.some((args) => args.includes('C-u')) ? NARROW_CODEX_COMPOSERS[0]
        : `\x1b[1m›\x1b[0m ${draft}\n \n  \x1b[38;2;246;226;183mgpt-6-astra xhigh fas…`,
    });
    assert.equal(commands.some((args) => args.includes('C-u') && args.includes('C-k')), true);
    assert.equal(commands.filter((args) => args.includes('paste-buffer')).length, 1);
  }
});

test('Codex goal footer permits replacement and confirms only the exact submitted draft', async () => {
  const footer = '  gpt-6-astra … Goal achieved (11m)';
  const commands = [];
  await sendSessionMessage({
    provider: 'codex', sessionName: 'goal-draft', threadId: 'thread-1', text: 'New message',
  }, {
    listTmuxSessions: async () => [{ name: 'goal-draft', agent: { kind: 'codex', id: 'thread-1', paneId: '%7' } }],
    execTmux: async (args) => commands.push(args),
    loadBuffer: async () => {}, waitForPaste: async () => {}, waitForSubmit: async () => {},
    capturePane: async () => `› ${commands.some((args) => args.includes('C-u')) ? '' : 'Local draft\n  second line'}\n\n${footer}`,
  });
  assert.equal(commands.some((args) => args.includes('C-u') && args.includes('C-k')), true);
  assert.equal(commands.filter((args) => args.includes('paste-buffer')).length, 1);

  let enters = 0;
  const result = await ensureAgentInputSubmitted({
    paneId: '%7', text: 'New message', verifyPane: async () => true,
    waitForSubmit: async () => {}, execTmux: async () => { enters += 1; },
    capturePane: async () => enters ? NARROW_CODEX_COMPOSERS.at(-1) : `› New message\n\n${footer}`,
  });
  assert.equal(result, 'submitted');
  assert.equal(enters, 1);
});
