import test from 'node:test';
import assert from 'node:assert/strict';
import {
  agentActivityText,
  applyAcceptedUserMessage,
  applyTmuxSnapshot,
  applyAgentEvent,
  findTmuxThreadTarget,
  findTmuxThreadReplacement,
  latestRunningTurn,
  normalizeAgentThread,
  normalizeInteractionQuestions,
  reconcileAgentThreadRefresh,
  shouldRefreshTmuxThread,
  shouldShowTerminalActivity,
  tmuxSessionsToThreads,
  userMessageDeliveryBaseline,
  userMessageText,
} from '../public/agent-model.js';

test('describes the active Agent item in real time', () => {
  const thread = normalizeAgentThread('codex', {
    id: 'thread-1',
    turns: [{
      id: 'turn-1', status: 'inProgress', items: [
        { id: 'thought', type: 'reasoning', status: 'completed' },
        { id: 'command', type: 'commandExecution', status: 'inProgress', command: 'npm test' },
      ],
    }],
  });

  assert.equal(agentActivityText(thread), '正在运行命令');
  thread.turns[0].items[1].status = 'completed';
  thread.turns[0].items.push({ id: 'answer', type: 'agentMessage', status: 'inProgress' });
  assert.equal(agentActivityText(thread), '正在回复');
  thread.turns[0].status = 'completed';
  assert.equal(agentActivityText(thread), '');
});

test('keeps terminal Agent activity visible while structured history is catching up', () => {
  const thread = normalizeAgentThread('codex', {
    id: 'thread-1',
    turns: [{ id: 'turn-1', status: 'completed', items: [] }],
  });
  thread.tmux = { name: 'codeck', status: 'working', available: true };

  assert.equal(agentActivityText(thread), '终端 Agent 正在工作');
  thread.tmux.activity = '正在运行命令 · 25秒';
  assert.equal(agentActivityText(thread), '正在运行命令 · 25秒');
  thread.tmux.status = 'done';
  assert.equal(agentActivityText(thread), '');
});

test('hides completed Qoder terminal output once structured history is available', () => {
  const thread = normalizeAgentThread('qodercli', { id: 'thread-1', turns: [] });
  thread.tmux = {
    name: 'qoder-work', status: 'done', available: true, liveOutput: 'Files changed: 3\nReady',
  };

  assert.equal(shouldShowTerminalActivity(thread), false);
  thread.tmux.status = 'working';
  assert.equal(shouldShowTerminalActivity(thread), true);
  thread.turns.push({ id: 'turn-1', status: 'inProgress', items: [] });
  assert.equal(shouldShowTerminalActivity(thread), false);
  thread.tmux.status = 'done';
  thread.tmux.available = false;
  assert.equal(shouldShowTerminalActivity(thread), true);
});

test('keeps an explicit slash-command result across tmux polling while idle', () => {
  const thread = normalizeAgentThread('codex', { id: 'thread-1', turns: [] });
  thread.tmux = {
    name: 'codeck', status: 'done', available: true,
    commandOutput: { command: '/status', text: 'Model: gpt-5\nContext: 80% left' },
  };

  assert.equal(shouldShowTerminalActivity(thread), true);
  applyTmuxSnapshot(thread, {
    name: 'codeck', status: 'done', available: true,
  });
  assert.deepEqual(thread.tmux.commandOutput, {
    command: '/status', text: 'Model: gpt-5\nContext: 80% left',
  });
  applyTmuxSnapshot(thread, {
    name: 'codeck', status: 'working', available: true, liveOutput: '正在运行命令',
  });
  assert.equal(thread.tmux.commandOutput, undefined);
  assert.equal(shouldShowTerminalActivity(thread), true);
});

test('refreshes a completed tmux Agent transcript even if its last live output is still attached', () => {
  const thread = normalizeAgentThread('qodercli', { id: 'thread-1', turns: [] });
  thread.tmux = {
    name: 'qoder-work', status: 'done', available: true, liveOutput: '最终回答',
  };

  assert.equal(shouldRefreshTmuxThread(thread, {
    now: 10_000, refreshUntil: 12_000,
  }), true);
  thread.tmux.status = 'working';
  assert.equal(shouldRefreshTmuxThread(thread, {
    now: 10_000, refreshUntil: 12_000,
  }), false);
});

test('reuses an unchanged transcript refresh but accepts a delayed final Agent output', () => {
  const current = normalizeAgentThread('qodercli', {
    id: 'thread-1', updatedAt: 10,
    turns: [{
      id: 'turn-1', status: 'completed',
      items: [{ id: 'answer-1', type: 'agentMessage', text: '第一段' }],
    }],
  });
  current.tmux = { name: 'qoder-work', status: 'done', available: true };
  const unchanged = normalizeAgentThread('qodercli', {
    id: 'thread-1', updatedAt: 20,
    turns: [{
      id: 'turn-1', status: 'completed',
      items: [{ id: 'answer-1', type: 'agentMessage', text: '第一段' }],
    }],
  });

  assert.equal(reconcileAgentThreadRefresh(current, unchanged), current);

  const delayed = normalizeAgentThread('qodercli', {
    ...unchanged,
    turns: [{
      id: 'turn-1', status: 'completed',
      items: [{ id: 'answer-1', type: 'agentMessage', text: '第一段\n最终结果' }],
    }],
  });
  const reconciled = reconcileAgentThreadRefresh(current, delayed);
  assert.notEqual(reconciled, current);
  assert.equal(reconciled.turns[0].items[0].text, '第一段\n最终结果');
  assert.deepEqual(reconciled.tmux, current.tmux);
  assert.notEqual(reconciled.tmux, current.tmux);
});

test('does not reload a completed transcript while only a detached background task is running', () => {
  const [thread] = tmuxSessionsToThreads([{
    name: 'research', activityAt: 10_000, status: 'background',
    agent: { kind: 'codex', id: 'thread-1', name: 'Research', activity: '后台任务运行中' },
  }]);

  assert.equal(thread.tmux.status, 'background');
  assert.equal(shouldRefreshTmuxThread(thread, {
    now: 10_000, refreshUntil: 0,
  }), false);
  assert.equal(shouldShowTerminalActivity(thread), false);

  thread.tmux.status = 'working';
  assert.equal(applyTmuxSnapshot(thread, {
    ...thread.tmux,
    status: 'background',
  }), true);
});

test('trusts tmux completion over a stale structured running turn', () => {
  const thread = normalizeAgentThread('codex', {
    id: 'thread-1',
    turns: [{ id: 'turn-1', status: 'inProgress', items: [] }],
  });
  thread.tmux = {
    name: 'codeck', status: 'working', available: true, liveOutput: '正在回复',
  };

  const completed = applyTmuxSnapshot(thread, {
    name: 'codeck', status: 'done', available: true, liveOutput: '最终回答',
  });

  assert.equal(completed, true);
  assert.equal(thread.tmux.status, 'done');
  assert.equal(latestRunningTurn(thread)?.id, 'turn-1');
  assert.equal(shouldRefreshTmuxThread(thread, {
    now: 10_000, refreshUntil: 20_000,
  }), true);
});

test('builds one ordered sidebar from all tmux sessions', () => {
  const threads = tmuxSessionsToThreads([
    {
      name: 'codex-work', activityAt: 30_000, status: 'working',
      agent: {
        kind: 'codex', id: 'codex-id', name: 'Mobile review',
        activity: '正在查看文件 · 12秒', liveOutput: '• Explored\n  └ Read remote.js',
      },
    },
    { name: 'shell', activityAt: 20_000, status: 'done', liveOutput: '$ ', agent: null },
    {
      name: 'claude-work', activityAt: 10_000, status: 'done',
      agent: { kind: 'claude', id: 'claude-id', name: null },
    },
    {
      name: 'qoder-work', activityAt: 5_000, status: 'done',
      agent: { kind: 'qodercli', id: null, name: 'Qoder task' },
    },
  ]);

  assert.deepEqual(threads, [
    {
      id: 'codex-id', provider: 'codex', readOnly: true,
      tmux: {
        name: 'codex-work', title: 'Mobile review', activityAt: 30_000,
        status: 'working', available: true, activity: '正在查看文件 · 12秒',
      },
    },
    {
      id: 'tmux:shell:shell', provider: 'shell', readOnly: false,
      tmux: {
        name: 'shell', title: 'shell', activityAt: 20_000,
        status: 'done', available: true,
      },
    },
    {
      id: 'claude-id', provider: 'claude', readOnly: false,
      tmux: { name: 'claude-work', title: 'claude-work', activityAt: 10_000, status: 'done', available: true },
    },
    {
      id: 'tmux:qodercli:qoder-work', provider: 'qodercli', readOnly: false,
      tmux: { name: 'qoder-work', title: 'Qoder task', activityAt: 5_000, status: 'done', available: false },
    },
  ]);
});

test('tmux session name disambiguates duplicate backend thread ids', () => {
  const threads = tmuxSessionsToThreads([
    {
      name: 'skills', activityAt: 10_000, status: 'done',
      agent: { kind: 'codex', id: 'shared-thread', name: 'Skills' },
    },
    {
      name: 'codeck', activityAt: 12_000, status: 'working',
      agent: { kind: 'codex', id: 'shared-thread', name: 'Codeck' },
    },
  ]);

  assert.equal(findTmuxThreadTarget(threads, {
    id: 'shared-thread', provider: 'codex', tmux: { name: 'skills' },
  })?.tmux.name, 'skills');
  assert.equal(findTmuxThreadTarget(threads, {
    id: 'shared-thread', provider: 'codex', tmux: { name: 'codeck' },
  })?.tmux.name, 'codeck');
});

test('a tmux-backed Codex thread stays backend-read-only while retaining its direct session target', () => {
  const [thread] = tmuxSessionsToThreads([{
    name: 'codex-work', activityAt: 30_000, status: 'done',
    agent: { kind: 'codex', id: 'codex-id', name: 'Mobile review' },
  }]);

  assert.equal(thread.readOnly, true);
  assert.equal(thread.tmux.name, 'codex-work');
});

test('replaces a pending tmux thread only with the same provider and session', () => {
  const pending = tmuxSessionsToThreads([{
    name: 'codeck', activityAt: 10_000, status: 'working',
    agent: { kind: 'codex', id: null, name: 'codeck' },
  }])[0];
  const threads = tmuxSessionsToThreads([
    {
      name: 'codeck', activityAt: 12_000, status: 'working',
      agent: { kind: 'claude', id: 'claude-thread', name: 'codeck' },
    },
    {
      name: 'other', activityAt: 12_000, status: 'working',
      agent: { kind: 'codex', id: 'other-thread', name: 'other' },
    },
    {
      name: 'codeck', activityAt: 12_000, status: 'working',
      agent: { kind: 'codex', id: 'codex-thread', name: 'Codeck task' },
    },
  ]);

  assert.equal(findTmuxThreadReplacement(threads, pending)?.id, 'codex-thread');
  assert.equal(findTmuxThreadReplacement(threads.slice(0, 2), pending), null);
});

test('follows a new Agent thread id inside the same live tmux session', () => {
  const current = normalizeAgentThread('codex', { id: 'old-thread', turns: [] });
  current.tmux = { name: 'skills', available: true, status: 'done' };
  const [replacement] = tmuxSessionsToThreads([{
    name: 'skills', activityAt: 20_000, status: 'working',
    agent: { kind: 'codex', id: 'new-thread', name: 'Current task' },
  }]);

  assert.equal(findTmuxThreadReplacement([replacement], current), replacement);
});

test('follows the same tmux session when an ssh shell starts or exits an Agent', () => {
  const shell = tmuxSessionsToThreads([{
    name: 'cli', activityAt: 10_000, status: 'working', agent: null,
  }])[0];
  const remoteCodex = tmuxSessionsToThreads([{
    name: 'cli', activityAt: 12_000, status: 'working',
    agent: { kind: 'codex', id: null, name: 'cli' },
  }])[0];

  assert.equal(findTmuxThreadReplacement([remoteCodex], shell), remoteCodex);
  assert.equal(findTmuxThreadReplacement([shell], remoteCodex), shell);
  assert.equal(findTmuxThreadReplacement([
    { ...remoteCodex, tmux: { ...remoteCodex.tmux, name: 'other' } },
  ], shell), null);
});

test('normalizes missing turn arrays without changing provider identity', () => {
  const thread = normalizeAgentThread('qodercli', { id: 'q-1', preview: 'Mobile review', readOnly: true });
  assert.equal(thread.provider, 'qodercli');
  assert.equal(thread.preview, 'Mobile review');
  assert.equal(thread.readOnly, true);
  assert.deepEqual(thread.turns, []);
});

test('applies streamed events without losing content on completion', () => {
  let thread = normalizeAgentThread('codex', { id: 'thread-1', turns: [] });
  thread = applyAgentEvent(thread, 'turn/started', {
    threadId: 'thread-1', turn: { id: 'turn-1', status: 'inProgress', items: [] },
  });
  thread = applyAgentEvent(thread, 'item/agentMessage/delta', {
    threadId: 'thread-1', turnId: 'turn-1', itemId: 'answer-1', delta: '手机端',
  });
  thread = applyAgentEvent(thread, 'item/agentMessage/delta', {
    threadId: 'thread-1', turnId: 'turn-1', itemId: 'answer-1', delta: '已修复',
  });
  thread = applyAgentEvent(thread, 'turn/completed', {
    threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [] },
  });
  assert.equal(thread.turns[0].items[0].text, '手机端已修复');
  assert.equal(thread.turns[0].status, 'completed');
  assert.equal(latestRunningTurn(thread), null);
});

test('streamed deltas preserve unchanged turn and item references without mutating prior state', () => {
  const thread = normalizeAgentThread('codex', {
    id: 'thread-1',
    turns: [
      {
        id: 'turn-1', status: 'completed',
        items: [{ id: 'answer-1', type: 'agentMessage', text: 'Earlier answer' }],
      },
      {
        id: 'turn-2', status: 'inProgress',
        items: [
          { id: 'reasoning-2', type: 'reasoning', summary: ['Thinking'], status: 'completed' },
          { id: 'answer-2', type: 'agentMessage', text: 'Live' },
        ],
      },
    ],
  });

  const updated = applyAgentEvent(thread, 'item/agentMessage/delta', {
    threadId: 'thread-1', turnId: 'turn-2', itemId: 'answer-2', delta: ' output',
  });

  assert.notEqual(updated, thread);
  assert.equal(updated.turns[0], thread.turns[0]);
  assert.notEqual(updated.turns[1], thread.turns[1]);
  assert.equal(updated.turns[1].items[0], thread.turns[1].items[0]);
  assert.notEqual(updated.turns[1].items[1], thread.turns[1].items[1]);
  assert.equal(thread.turns[1].items[1].text, 'Live');
  assert.equal(updated.turns[1].items[1].text, 'Live output');
});

test('a changed transcript snapshot preserves unchanged turns for keyed rendering', () => {
  const current = normalizeAgentThread('qodercli', {
    id: 'thread-1',
    turns: [
      { id: 'turn-1', status: 'completed', items: [{ id: 'one', type: 'agentMessage', text: 'One' }] },
      { id: 'turn-2', status: 'completed', items: [{ id: 'two', type: 'agentMessage', text: 'Two' }] },
    ],
  });
  current.tmux = { name: 'qoder-work', status: 'working', available: true };
  const refreshed = normalizeAgentThread('qodercli', {
    id: 'thread-1',
    turns: [
      { id: 'turn-1', status: 'completed', items: [{ id: 'one', type: 'agentMessage', text: 'One' }] },
      { id: 'turn-2', status: 'completed', items: [{ id: 'two', type: 'agentMessage', text: 'Two final' }] },
    ],
  });

  const reconciled = reconcileAgentThreadRefresh(current, refreshed);
  assert.equal(reconciled.turns[0], current.turns[0]);
  assert.notEqual(reconciled.turns[1], current.turns[1]);
  assert.equal(reconciled.turns[1].items[0].text, 'Two final');
  assert.deepEqual(reconciled.tmux, current.tmux);
});

test('a lightweight snapshot cannot delete a streamed user follow-up from the same turn', () => {
  const first = {
    id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'Start' }],
  };
  const followUp = {
    id: 'user-2', type: 'userMessage', content: [{ type: 'text', text: 'Also verify mobile' }],
  };
  const current = normalizeAgentThread('codex', {
    id: 'thread-1',
    turns: [{
      id: 'turn-1', status: 'inProgress',
      items: [first, { id: 'reasoning-1', type: 'reasoning', summary: ['Working'] }, followUp],
    }],
  });
  current.tmux = { name: 'report', status: 'working', available: true };
  const refreshed = normalizeAgentThread('codex', {
    id: 'thread-1',
    turns: [{
      id: 'turn-1', status: 'completed',
      items: [first, { id: 'answer-1', type: 'agentMessage', text: 'Done' }],
    }],
  });

  const reconciled = reconcileAgentThreadRefresh(current, refreshed);

  assert.deepEqual(reconciled.turns[0].items.map((item) => item.type), [
    'userMessage', 'userMessage', 'agentMessage',
  ]);
  assert.equal(userMessageText(reconciled.turns[0].items[1]), 'Also verify mobile');
  assert.equal(reconciled.turns[0].status, 'completed');
});

test('an accepted direct-tmux follow-up appears immediately in its active turn', () => {
  const thread = normalizeAgentThread('codex', {
    id: 'thread-1',
    turns: [{
      id: 'turn-1', status: 'inProgress',
      items: [{
        id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'Start' }],
      }],
    }],
  });

  const updated = applyAcceptedUserMessage(thread, {
    turnId: 'turn-1', text: 'Also verify mobile', commandId: 'command-12345678',
  });

  assert.notEqual(updated, thread);
  assert.deepEqual(updated.turns[0].items.map(userMessageText), ['Start', 'Also verify mobile']);
  assert.equal(updated.turns[0].items[1].id, 'delivery:command-12345678');
});

test('an input absorbed by a running Claude turn stays ahead of that turn output', () => {
  const thread = normalizeAgentThread('claude', {
    id: 'thread-1',
    turns: [{
      id: 'turn-running', status: 'completed',
      items: [
        { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'Start' }] },
        { id: 'answer-1', type: 'agentMessage', text: 'Final answer' },
      ],
    }],
  });

  const updated = applyAcceptedUserMessage(thread, {
    text: 'Also inspect receipts', commandId: 'command-queued-1',
    inputWasQueued: true, baselineVersion: 2,
    baselineUserMessageId: 'user-1', baselineTurnId: 'turn-running',
    baselineMatchingTextCount: 0,
  });

  assert.equal(updated.turns.length, 1);
  assert.deepEqual(updated.turns[0].items.map((item) => item.type), [
    'userMessage', 'userMessage', 'agentMessage',
  ]);
  assert.equal(updated.turns[0].items[1].id, 'delivery:command-queued-1');
  assert.equal(updated.turns[0].items.at(-1).text, 'Final answer');
});

test('an accepted tmux message without a running turn survives stale snapshots', () => {
  const current = normalizeAgentThread('codex', {
    id: 'thread-1',
    turns: [{
      id: 'turn-old', status: 'completed',
      items: [{
        id: 'user-old', type: 'userMessage', content: [{ type: 'text', text: '怎么样了' }],
      }],
    }],
  });
  const accepted = applyAcceptedUserMessage(current, {
    text: '怎么样了', commandId: 'command-12345678',
  });

  assert.equal(accepted.turns.length, 2);
  assert.equal(accepted.turns[1].deliveryOnly, true);
  assert.equal(userMessageText(accepted.turns[1].items[0]), '怎么样了');

  const stale = normalizeAgentThread('codex', {
    id: 'thread-1',
    turns: current.turns,
  });
  const preserved = reconcileAgentThreadRefresh(accepted, stale);
  assert.equal(preserved.turns.length, 2, 'an older snapshot cannot erase the accepted bubble');

  const actual = normalizeAgentThread('codex', {
    id: 'thread-1',
    turns: [...current.turns, {
      id: 'turn-new', status: 'completed',
      items: [{
        id: 'user-new', type: 'userMessage', content: [{ type: 'text', text: '怎么样了' }],
      }],
    }],
  });
  const reconciled = reconcileAgentThreadRefresh(preserved, actual);
  const users = reconciled.turns.flatMap((turn) => turn.items)
    .filter((item) => item.type === 'userMessage');
  assert.deepEqual(users.map((item) => item.id), ['user-old', 'user-new']);
  assert.equal(reconciled.turns.some((turn) => turn.deliveryOnly), false);
});

test('history expansion cannot impersonate a newly accepted repeated message', () => {
  const expanded = normalizeAgentThread('codex', {
    id: 'thread-1',
    turns: [
      {
        id: 'turn-history-1', status: 'completed',
        items: [{
          id: 'user-history-1', type: 'userMessage', content: [{ type: 'text', text: 'Earlier' }],
        }],
      },
      {
        id: 'turn-history-2', status: 'completed',
        items: [{
          id: 'user-history-2', type: 'userMessage', content: [{ type: 'text', text: 'Earlier again' }],
        }],
      },
      {
        id: 'turn-old-repeat', status: 'completed',
        items: [{
          id: 'user-old-repeat', type: 'userMessage', content: [{ type: 'text', text: '怎么样了' }],
        }],
      },
      {
        id: 'turn-recent', status: 'completed',
        items: [
          { id: 'user-recent', type: 'userMessage', content: [{ type: 'text', text: '继续' }] },
          { id: 'user-anchor', type: 'userMessage', content: [{ type: 'text', text: '检查结果' }] },
        ],
      },
    ],
  });

  const accepted = applyAcceptedUserMessage(expanded, {
    text: '怎么样了',
    commandId: 'command-12345678',
    baselineVersion: 2,
    baselineUserMessageId: 'user-anchor',
    baselineTurnId: 'turn-recent',
    baselineMatchingTextCount: 0,
  });

  assert.notEqual(accepted, expanded, 'history inserted before the stable anchor is not this send');
  assert.equal(accepted.turns.at(-1).items[0].id, 'delivery:command-12345678');

  const preserved = reconcileAgentThreadRefresh(accepted, expanded);
  assert.equal(preserved.turns.at(-1).items[0].id, 'delivery:command-12345678');

  const actual = normalizeAgentThread('codex', {
    ...expanded,
    turns: [...expanded.turns, {
      id: 'turn-new', status: 'inProgress',
      items: [{
        id: 'user-new', type: 'userMessage', content: [{ type: 'text', text: '怎么样了' }],
      }],
    }],
  });
  const responseRace = applyAcceptedUserMessage(actual, {
    text: '怎么样了',
    commandId: 'command-racing-response',
    baselineVersion: 2,
    baselineUserMessageId: 'user-anchor',
    baselineTurnId: 'turn-recent',
    baselineMatchingTextCount: 0,
  });
  assert.equal(responseRace, actual, 'the real post-anchor message wins the response race');

  const reconciled = reconcileAgentThreadRefresh(preserved, actual);
  assert.deepEqual(reconciled.turns.flatMap((turn) => turn.items)
    .filter((item) => item.type === 'userMessage').map((item) => item.id), [
    'user-history-1', 'user-history-2', 'user-old-repeat', 'user-recent', 'user-anchor', 'user-new',
  ]);
});

test('repeated accepted messages reconcile one at a time in transcript order', () => {
  const empty = normalizeAgentThread('codex', { id: 'thread-1', turns: [] });
  const firstBaseline = userMessageDeliveryBaseline(empty, '怎么样了');
  const first = applyAcceptedUserMessage(empty, {
    text: '怎么样了', commandId: 'command-first', ...firstBaseline,
  });
  const secondBaseline = userMessageDeliveryBaseline(first, '怎么样了');
  const second = applyAcceptedUserMessage(first, {
    text: '怎么样了', commandId: 'command-second', ...secondBaseline,
  });
  assert.equal(firstBaseline.baselineMatchingTextCount, 0);
  assert.equal(secondBaseline.baselineMatchingTextCount, 1);
  const oneActual = reconcileAgentThreadRefresh(second, normalizeAgentThread('codex', {
    id: 'thread-1',
    turns: [{
      id: 'turn-1', status: 'completed',
      items: [{
        id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: '怎么样了' }],
      }],
    }],
  }));

  assert.deepEqual(oneActual.turns.flatMap((turn) => turn.items).map((item) => item.id), [
    'user-1', 'delivery:command-second',
  ]);

  const bothActual = reconcileAgentThreadRefresh(oneActual, normalizeAgentThread('codex', {
    id: 'thread-1',
    turns: [
      {
        id: 'turn-1', status: 'completed',
        items: [{
          id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: '怎么样了' }],
        }],
      },
      {
        id: 'turn-2', status: 'completed',
        items: [{
          id: 'user-2', type: 'userMessage', content: [{ type: 'text', text: '怎么样了' }],
        }],
      },
    ],
  }));

  assert.deepEqual(bothActual.turns.flatMap((turn) => turn.items).map((item) => item.id), [
    'user-1', 'user-2',
  ]);
  assert.equal(bothActual.turns.some((turn) => turn.deliveryOnly), false);
});

test('a sparse server echo cannot erase the stable delivery anchor', () => {
  const base = normalizeAgentThread('codex', {
    id: 'thread-1',
    turns: [{
      id: 'turn-1', status: 'inProgress',
      items: [{
        id: 'user-anchor', type: 'userMessage', content: [{ type: 'text', text: '继续' }],
      }],
    }],
  });
  const accepted = applyAcceptedUserMessage(base, {
    turnId: 'turn-1', text: '怎么样了', commandId: 'command-12345678',
    ...userMessageDeliveryBaseline(base, '怎么样了'),
  });
  const serverEcho = normalizeAgentThread('codex', {
    id: 'thread-1',
    turns: [{
      id: 'turn-1', status: 'inProgress',
      items: [
        base.turns[0].items[0],
        {
          id: 'delivery:command-12345678', type: 'userMessage',
          content: [{ type: 'text', text: '怎么样了' }], delivery: { status: 'accepted' },
        },
      ],
    }],
  });

  const preserved = reconcileAgentThreadRefresh(accepted, serverEcho);
  const pending = preserved.turns[0].items.at(-1);
  assert.equal(pending.delivery.baselineVersion, 2);
  assert.equal(pending.delivery.baselineUserMessageId, 'user-anchor');

  const actual = normalizeAgentThread('codex', {
    id: 'thread-1',
    turns: [{
      id: 'turn-1', status: 'inProgress',
      items: [
        base.turns[0].items[0],
        { id: 'user-new', type: 'userMessage', content: [{ type: 'text', text: '怎么样了' }] },
      ],
    }],
  });
  assert.deepEqual(reconcileAgentThreadRefresh(preserved, actual).turns[0].items
    .map((item) => item.id), ['user-anchor', 'user-new']);
});

test('a live user item replaces its matching no-turn delivery without a duplicate flash', () => {
  const current = applyAcceptedUserMessage(normalizeAgentThread('codex', {
    id: 'thread-1', turns: [],
  }), {
    text: '怎么样了', commandId: 'command-12345678',
  });
  const updated = applyAgentEvent(current, 'item/started', {
    threadId: 'thread-1',
    turnId: 'turn-new',
    item: {
      id: 'user-new', type: 'userMessage', content: [{ type: 'text', text: '怎么样了' }],
    },
  });

  assert.equal(updated.turns.some((turn) => turn.deliveryOnly), false);
  assert.deepEqual(updated.turns.flatMap((turn) => turn.items).map((item) => item.id), ['user-new']);
});

test('an Agent update that wins the send-response race prevents a duplicate accepted bubble', () => {
  const actual = normalizeAgentThread('codex', {
    id: 'thread-1',
    turns: [
      {
        id: 'turn-old', status: 'completed',
        items: [{
          id: 'user-old', type: 'userMessage', content: [{ type: 'text', text: '怎么样了' }],
        }],
      },
      {
        id: 'turn-new', status: 'inProgress',
        items: [{
          id: 'user-new', type: 'userMessage', content: [{ type: 'text', text: '怎么样了' }],
        }],
      },
    ],
  });

  const updated = applyAcceptedUserMessage(actual, {
    text: '怎么样了', commandId: 'command-12345678',
    baselineVersion: 2,
    baselineUserMessageId: 'user-old',
    baselineTurnId: 'turn-old',
    baselineMatchingTextCount: 0,
  });

  assert.equal(updated, actual);
});

test('adds provider-neutral user and command content safely', () => {
  let thread = normalizeAgentThread('claude', { id: 'thread-1', turns: [] });
  thread = applyAgentEvent(thread, 'item/started', {
    threadId: 'thread-1', turnId: 'turn-1',
    item: { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: '运行测试' }] },
  });
  thread = applyAgentEvent(thread, 'item/commandExecution/outputDelta', {
    threadId: 'thread-1', turnId: 'turn-1', itemId: 'command-1', delta: '60 tests passed',
  });
  assert.equal(userMessageText(thread.turns[0].items[0]), '运行测试');
  assert.equal(thread.turns[0].items[1].aggregatedOutput, '60 tests passed');
});

test('normalizes agent questions for a shared mobile form', () => {
  const questions = normalizeInteractionQuestions({
    questions: [{
      header: 'Target',
      question: 'Which target?',
      options: ['Mobile', { label: 'Desktop', description: 'Wide layout' }],
      multiSelect: true,
      isOther: true,
    }],
  });
  assert.deepEqual(questions, [{
    id: 'question-1',
    header: 'Target',
    question: 'Which target?',
    options: [
      { label: 'Mobile', description: '' },
      { label: 'Desktop', description: 'Wide layout' },
    ],
    multiSelect: true,
    isOther: true,
    isSecret: false,
  }]);
});

test('the session list no longer carries the tmux pane excerpt', () => {
  // pane 摘录只对"正在看的那个会话"有用, 却随全局会话列表广播给每个客户端:
  // 实测占增量帧 84% 且随并发工作会话数放大。它改由 thread 通道投递。
  const [thread] = tmuxSessionsToThreads([{
    name: 'skills', activityAt: 10_000, status: 'working',
    liveOutput: 'shell pane text',
    agent: { kind: 'claude', id: 'thread-1', name: 'Skills', activity: '正在处理', liveOutput: 'agent pane text' },
  }]);

  assert.equal(thread.tmux.liveOutput, undefined);
  assert.equal(thread.tmux.status, 'working');
  assert.equal(thread.tmux.activity, '正在处理');
});

test('a thread keeps showing its pane excerpt once the thread payload supplies one', () => {
  // 面板可见性看的是 status, 不是 liveOutput, 所以列表不带摘录也不会有布局跳动;
  // 但内容必须能从 thread 侧填进来, 否则打开会话会先空一拍。
  const [thread] = tmuxSessionsToThreads([{
    name: 'skills', activityAt: 10_000, status: 'working',
    agent: { kind: 'claude', id: 'thread-1', name: 'Skills', activity: '正在处理' },
  }]);

  assert.equal(shouldShowTerminalActivity(thread), true);
  applyTmuxSnapshot(thread, { ...thread.tmux, liveOutput: 'from thread channel' });
  assert.equal(thread.tmux.liveOutput, 'from thread channel');
  assert.equal(shouldShowTerminalActivity(thread), true);
});

test('a thread that already has live output from its own stream is not re-polled', () => {
  // 这个判据原本读 tmux.liveOutput —— 列表不再带摘录后它会恒为空, 导致每个
  // 工作中的会话每拍都多打一次 openThread, 把省下的字节又换成往返。
  const [thread] = tmuxSessionsToThreads([{
    name: 'skills', activityAt: 10_000, status: 'working',
    agent: { kind: 'claude', id: 'thread-1', name: 'Skills', activity: '正在处理' },
  }]);

  assert.equal(shouldRefreshTmuxThread(thread, { now: 10_000, refreshUntil: 0 }), true,
    'no live output yet: polling is the only way to get it');

  thread.liveOutput = 'pane text from the thread stream';
  assert.equal(shouldRefreshTmuxThread(thread, { now: 10_000, refreshUntil: 0 }), false,
    'the thread stream already supplies it: do not poll on top of it');
});

test('a windowed refresh keeps the history that falls outside the window', () => {
  // thread 流只推尾部窗口以省下序列化与传输; 但 reconcile 是拿 refreshed.turns
  // 整个重建 turns 的, 不保留就等于每秒把用户往回翻的历史删掉一次。
  const current = normalizeAgentThread('claude', {
    id: 'thread-1',
    turns: [
      { id: 'old-1', status: 'completed', items: [{ id: 'a', type: 'agentMessage', text: '很早以前' }] },
      { id: 'old-2', status: 'completed', items: [{ id: 'b', type: 'agentMessage', text: '稍早' }] },
      { id: 'recent', status: 'completed', items: [{ id: 'c', type: 'agentMessage', text: '最近' }] },
    ],
  });
  const windowed = normalizeAgentThread('claude', {
    id: 'thread-1',
    truncated: true,
    turns: [{ id: 'recent', status: 'completed', items: [{ id: 'c', type: 'agentMessage', text: '最近+更新' }] }],
  });

  const reconciled = reconcileAgentThreadRefresh(current, windowed);

  assert.deepEqual(reconciled.turns.map((turn) => turn.id), ['old-1', 'old-2', 'recent']);
  assert.equal(reconciled.turns[2].items[0].text, '最近+更新');
});

test('a full refresh still replaces the whole transcript', () => {
  // 没有 truncated 标记时必须保持原语义: 服务端说没有的 turn 就是被删了。
  const current = normalizeAgentThread('claude', {
    id: 'thread-1',
    turns: [
      { id: 'gone', status: 'completed', items: [{ id: 'a', type: 'agentMessage', text: '删掉' }] },
      { id: 'kept', status: 'completed', items: [{ id: 'b', type: 'agentMessage', text: '留着' }] },
    ],
  });
  const refreshed = normalizeAgentThread('claude', {
    id: 'thread-1',
    turns: [{ id: 'kept', status: 'completed', items: [{ id: 'b', type: 'agentMessage', text: '留着' }] }],
  });

  assert.deepEqual(reconcileAgentThreadRefresh(current, refreshed).turns.map((t) => t.id), ['kept']);
});
