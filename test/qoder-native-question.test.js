import test from 'node:test';
import assert from 'node:assert/strict';
import * as tmux from '../src/tmux.js';
import { tmuxSessionsToThreads, threadExecutionState } from '../public/agent-model.js';
import { QoderQuestionTracker } from '../src/qoder-question.js';

const screen = `> 你再问我下

Asking User
────────────────────────────────────
是否现在对部署后的最终提交运行 L3
深度安全扫描？

❯ 1. Run L3 deep security review
     立即审查当前最终提交集。
  2. Skip scan
     保持现状，不运行扫描。
  3. Type Something

↑↓ navigate · Enter select · Esc
back
YOLO mode
`;

test('screenshot Asking User becomes a selectable native question, not answered history', () => {
  const question = tmux.parseQoderQuestion?.(screen);
  assert.ok(question, 'native Qoder question must be recognized');
  assert.equal(question.question, '是否现在对部署后的最终提交运行 L3\n深度安全扫描？');
  assert.deepEqual(question.options.map(o => o.label), ['Run L3 deep security review', 'Skip scan']);
  assert.equal(question.options[1].description, '保持现状，不运行扫描。');
  assert.equal(question.cursor, 0);
  for (const invalid of [
    'AskUserQuestion\nUser answered:\nQ: 是否扫描？\nThinking',
    screen.replace('Asking User', 'Answer example'),
    screen.replace('❯ 1.', '  1.'),
    screen.replace('  2.', '  4.'),
    screen.replace('Enter select', 'Enter toggle'),
    screen + '> 这是模型引用的旧菜单\n',
  ]) assert.equal(tmux.parseQoderQuestion?.(invalid), null);
});

test('native question round-trips through session model and overrides false ready state', () => {
  const question = { id: 'question-id', question: 'Continue?', options: [{ label: 'Yes' }] };
  const [thread] = tmuxSessionsToThreads([{ name: 'qoder', status: 'done',
    agent: { kind: 'qodercli', id: 'thread', question } }]);
  assert.deepEqual(thread.tmux.question, question);
  assert.equal(threadExecutionState(thread), 'waitingForInput');
});

function nativeFixture() {
  const tracker = new QoderQuestionTracker();
  const agent = { kind: 'qodercli', id: 'thread', paneId: '%42' };
  const question = tracker.observe('qoder', agent, screen);
  let visible = screen;
  const calls = [];
  const overrides = { questionTracker: tracker,
    listTmuxSessions: async () => [{ name: 'qoder', agent }],
    capturePane: async () => visible,
    waitForQuestion: async () => {},
    execTmux: async args => {
      calls.push(args);
      if (args.at(-1) === 'Down') visible = screen.replace('❯ 1.', '  1.').replace('  2.', '❯ 2.');
      if (args.at(-1) === 'Enter') visible = 'AskUserQuestion\nUser answered: Skip scan';
    },
  };
  return { tracker, agent, question, calls, overrides, setScreen: value => { visible = value; },
    params: { provider: 'qodercli', sessionName: 'qoder', threadId: 'thread', questionId: question.id, answer: 'Skip scan' } };
}

test('native selection waits for cursor repaint before Enter and rejects concurrent duplicate answers', async () => {
  const f = nativeFixture();
  const results = await Promise.allSettled([
    tmux.answerSessionQuestion(f.params, f.overrides), tmux.answerSessionQuestion(f.params, f.overrides),
  ]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.deepEqual(f.calls.map(args => args.at(-1)), ['Down', 'Enter']);
  assert.ok(f.calls.every(args => args.includes('%42')));
});

test('stale question, changed pane, unsupported answer and stalled navigation never send Enter', async () => {
  for (const kind of ['question', 'pane', 'answer', 'stalled', 'history', 'scope']) {
    const f = nativeFixture();
    if (kind === 'question') f.setScreen(screen.replace('是否现在', '新的问题是否现在'));
    if (kind === 'pane') f.agent.paneId = '%43';
    if (kind === 'answer') f.params.answer = 'Type Something';
    if (kind === 'stalled') f.overrides.execTmux = async args => { f.calls.push(args); };
    if (kind === 'history') f.setScreen('AskUserQuestion\nUser answered: Skip scan');
    if (kind === 'scope') f.params.threadId = 'other-thread';
    await assert.rejects(tmux.answerSessionQuestion(f.params, f.overrides), undefined, kind);
    assert.equal(f.calls.some(args => args.at(-1) === 'Enter'), false, kind);
  }
});

test('a question changing during navigation is never confirmed', async () => {
  const f = nativeFixture();
  f.overrides.execTmux = async args => {
    f.calls.push(args);
    f.setScreen(screen.replace('是否现在', '新问题'));
  };
  await assert.rejects(tmux.answerSessionQuestion(f.params, f.overrides), /询问已变化/);
  assert.deepEqual(f.calls.map(args => args.at(-1)), ['Down']);
});

test('ambiguous Enter failure is consumed and cannot be replayed', async () => {
  const f = nativeFixture();
  f.params.answer = 'Run L3 deep security review';
  f.overrides.execTmux = async args => { f.calls.push(args); throw new Error('tmux transport failure'); };
  await assert.rejects(tmux.answerSessionQuestion(f.params, f.overrides), /送达状态未知/);
  await assert.rejects(tmux.answerSessionQuestion(f.params, f.overrides), /已回答/);
  assert.equal(f.calls.length, 1);
});

test('observation token survives cursor changes but not disappearance, scope changes or a new question', () => {
  const f = nativeFixture();
  assert.equal(f.tracker.observe('qoder', f.agent, screen.replace('❯ 1.', '  1.').replace('  2.', '❯ 2.')).id, f.question.id);
  f.tracker.observe('qoder', f.agent, 'User answered');
  assert.notEqual(f.tracker.observe('qoder', f.agent, screen).id, f.question.id);
  assert.equal(f.tracker.observe('qoder', { ...f.agent, kind: 'claude' }, screen), null);
});

test('an unchanged native picker after Enter is not reported as a successful answer', async () => {
  const f = nativeFixture();
  f.params.answer = 'Run L3 deep security review';
  f.overrides.execTmux = async args => { f.calls.push(args); };
  await assert.rejects(tmux.answerSessionQuestion(f.params, f.overrides), /未确认/);
  await assert.rejects(tmux.answerSessionQuestion(f.params, f.overrides));
  assert.equal(f.calls.length, 1);
});

test('native title spacing and wrapped shortcut hints do not hide a complete single-choice menu', () => {
  const wrapped = screen.replace('Asking User\n', 'Asking User\n\n')
    .replace('↑↓ navigate · Enter select · Esc\nback', '↑↓ navigate · Enter\nselect · Esc back');
  assert.ok(tmux.parseQoderQuestion(wrapped));
});
