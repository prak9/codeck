import test from 'node:test';
import assert from 'node:assert/strict';
import {
  agentActivityText,
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
        liveOutput: '• Explored\n  └ Read remote.js',
      },
    },
    {
      id: 'tmux:shell:shell', provider: 'shell', readOnly: false,
      tmux: {
        name: 'shell', title: 'shell', activityAt: 20_000,
        status: 'done', available: true, liveOutput: '$ ',
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
