import test from 'node:test';
import assert from 'node:assert/strict';
import {
  agentActivityText,
  applyAgentEvent,
  findTmuxThreadReplacement,
  latestRunningTurn,
  normalizeAgentThread,
  normalizeInteractionQuestions,
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

test('shows captured Qoder output even when legacy tmux cannot expose a busy footer', () => {
  const thread = normalizeAgentThread('qodercli', { id: 'thread-1', turns: [] });
  thread.tmux = {
    name: 'qoder-work', status: 'done', available: true, liveOutput: 'Files changed: 3\nReady',
  };

  assert.equal(shouldShowTerminalActivity(thread), true);
  thread.turns.push({ id: 'turn-1', status: 'inProgress', items: [] });
  assert.equal(shouldShowTerminalActivity(thread), true);
  delete thread.tmux.liveOutput;
  assert.equal(shouldShowTerminalActivity(thread), false);
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
