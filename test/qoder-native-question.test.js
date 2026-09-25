import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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

// Qoder CLI 1.1.46 ExitPlanMode layout: unlike Asking User, no navigation footer.
const planScreen = fs.readFileSync(new URL('./fixtures/qoder-plan-screen.txt', import.meta.url), 'utf8');
const clippedPlanScreen = fs.readFileSync(new URL('./fixtures/qoder-plan-screen-clipped.txt', import.meta.url), 'utf8');
const chatScreen = fs.readFileSync(new URL('./fixtures/qoder-asking-user-chat.txt', import.meta.url), 'utf8');

test('IMG_1577 Asking User exposes answers before the text and chat editors', () => {
  const question = tmux.parseQoderQuestion(chatScreen);
  assert.ok(question, 'the screenshot layout must produce a Remote question');
  assert.equal(question.question, '是否在推送并继续生产验证前，对已提\n交的 TASK-035/TASK-036 变更运行 L3\n深度安全审查？');
  assert.deepEqual(question.options, [
    { label: 'Run L3 deep security review', description: '先审查已提交变更，确认无安全阻\n塞后再推送。' },
    { label: 'Skip scan and continue', description: '跳过本次安全审查，直接继续既定\n交付。' },
  ]);
  assert.equal(question.cursor, 0);
  assert.notEqual(question.selectByNumber, true, 'use the visible arrow/Enter navigation contract');
  const tracker = new QoderQuestionTracker();
  const agent = { kind: 'qodercli', id: 'thread', paneId: '%42' };
  const observed = tracker.observe('qoder', agent, chatScreen);
  const [thread] = tmuxSessionsToThreads([{ name: 'qoder', status: 'done', agent: { ...agent, question: observed } }]);
  assert.equal(thread.tmux.question.id, observed.id);
  assert.equal(threadExecutionState(thread), 'waitingForInput');
  assert.equal(tracker.observe('qoder', agent, chatScreen.replace('❯ 1.', '  1.').replace('  2.', '❯ 2.')).id, observed.id);
});

test('text spelling and wrapped navigation hints retain supported single-choice layouts', () => {
  for (const label of ['Type Something', 'Type Something.', 'Type something…', 'Type\n     something.']) {
    for (const action of ['back', 'cancel', 'close']) {
      const variant = screen.replace('Type Something', label).replace('Esc\nback', `Esc\n${action}`);
      assert.ok(tmux.parseQoderQuestion(variant), `${label}: ${action}`);
    }
  }
  assert.ok(tmux.parseQoderQuestion(chatScreen.replace('↑↓ navigate · Enter select · Esc\ncancel',
    '↑↓ navigate · Enter\nselect · Esc cancel')));
});

test('auxiliary controls are classified structurally rather than by a fixed suffix layout', () => {
  const variants = [
    chatScreen.replace('Type something.\n\n────────────────────────────────────', 'Type something.'),
    chatScreen.replace('  4. Chat about this', ''),
    chatScreen.replace('Type something.', 'TYPE   SOMETHING…').replace('Chat about this', 'CHAT ABOUT THIS.'),
    chatScreen.replace('Chat about this', 'Chat about\n     this.'),
    chatScreen.replace('Type something.', 'Chat about this').replace('4. Chat about this', '4. Type Something'),
    chatScreen.replace('↑↓ navigate · Enter select · Esc\ncancel', '↑↓\nnavigate • ENTER select • ESC cancel'),
    chatScreen.replace('  2.', '────────────────────────────────────\n  2.'),
  ];
  const baseline = tmux.parseQoderQuestion(chatScreen);
  for (const variant of variants) {
    const parsed = tmux.parseQoderQuestion(variant);
    assert.ok(parsed, variant);
    assert.deepEqual(parsed.options, baseline.options);
    assert.equal(parsed.fingerprint, baseline.fingerprint, 'cosmetic changes cannot create a new question');
  }
});

test('chat layout fails closed for editors, partial menus, stale output and unsupported controls', () => {
  for (const invalid of [
    chatScreen.replace('❯ 1.', '  1.'),
    chatScreen.replace('❯ 1.', '  1.').replace('  3.', '❯ 3.'),
    chatScreen.replace('❯ 1.', '  1.').replace('  4.', '❯ 4.'),
    chatScreen.replace('  4.', '❯ 4.'),
    chatScreen.replace('  4.', '  5.'),
    chatScreen.replace('  4. Chat about this', '  4. Submit'),
    chatScreen.replace('  4. Chat about this', '  4. Chat about this\n  5. Unknown action'),
    chatScreen.replace('  4. Chat about this', '  4. Type Something'),
    chatScreen.replace('  3. Type something.\n', ''),
    chatScreen.replace('Type something.', 'Type something.\n     unfinished text'),
    chatScreen.replace('Chat about this', 'Chat about this\n     unfinished text'),
    chatScreen.replace('Enter select', 'Enter toggle'),
    chatScreen.replace('Esc\ncancel', 'Esc\nunknown'),
    chatScreen + '> 新的输入\n',
    chatScreen + 'User answered: Skip scan and continue\n',
    chatScreen + 'Generating...\n',
    chatScreen + '› 新的输入\n',
    '```\n' + chatScreen + '```\n',
  ]) assert.equal(tmux.parseQoderQuestion(invalid), null, invalid);
});

test('IMG_1564 Plan menu works with a scrolled-off title, truncated descriptions and Ctrl+X', () => {
  const parsed = tmux.parseQoderQuestion(clippedPlanScreen);
  assert.ok(parsed);
  assert.deepEqual(parsed.options.map(option => option.index), [0, 1, 3]);
  assert.match(parsed.question, /不提交或推送代码/);
  assert.match(parsed.question, /片段/);
  for (const invalid of [
    clippedPlanScreen.replace('Ctrl+X to edit plan', ''),
    clippedPlanScreen.replace('─────────────────────────────────────', ''),
    clippedPlanScreen + '> Work resumed\n',
  ]) assert.equal(tmux.parseQoderQuestion(invalid), null);
});

test('Plan approval exposes executable choices and preserves native indices without an Asking User footer', () => {
  const parsed = tmux.parseQoderQuestion(planScreen);
  assert.ok(parsed);
  assert.match(parsed.question, /Fix history reads and run tests/);
  assert.deepEqual(parsed.options.map(option => option.label), ['Yes, start executing', 'Yes, execute as Goal', 'Reject plan']);
  assert.deepEqual(parsed.options.map(option => option.index), [0, 1, 3]);
  assert.equal(parsed.cursor, 0);
  const tracker = new QoderQuestionTracker();
  const agent = { kind: 'qodercli', id: 'thread', paneId: '%42' };
  const first = tracker.observe('qoder', agent, planScreen);
  assert.notEqual(tracker.observe('qoder', agent, planScreen.replace('Fix history reads', 'Delete all history')).id, first.id);
  for (const invalid of [
    planScreen.replace('Fix history reads and run tests.', ''),
    planScreen.replace('❯ 1.', '  1.'),
    planScreen.replace('  4. Reject plan', '  5. Reject plan'),
    planScreen.replace('  4. Reject plan\n     Reject this plan without', ''),
    planScreen.replace('Yes, start executing', 'Yes, allow everything'),
    planScreen + '> Continue working\n',
    '```\n' + planScreen + '```\n',
  ]) assert.equal(tmux.parseQoderQuestion(invalid), null);
});

function planFixture(initialScreen = planScreen) {
  const tracker = new QoderQuestionTracker();
  const agent = { kind: 'qodercli', id: 'thread', paneId: '%42' };
  let visible = initialScreen;
  const question = tracker.observe('qoder', agent, visible);
  const calls = [];
  const overrides = { questionTracker: tracker,
    listTmuxSessions: async () => [{ name: 'qoder', agent }],
    capturePane: async () => visible, waitForQuestion: async () => {},
    execTmux: async args => {
      const key = args.at(-1);
      calls.push(key);
      if (['1', '2', '4'].includes(key)) visible = 'Plan choice submitted';
    },
  };
  return { tracker, agent, calls, overrides, setScreen: value => { visible = value; },
    params: { provider: 'qodercli', sessionName: 'qoder', threadId: 'thread', questionId: question?.id, answer: 'Reject plan' } };
}

test('Plan rejection directly selects the fourth option without opening feedback and is not replayed', async () => {
  for (const screen of [planScreen, clippedPlanScreen]) {
    const f = planFixture(screen);
    assert.equal((await tmux.answerSessionQuestion(f.params, f.overrides)).submitted, true);
    assert.deepEqual(f.calls, ['4']);
    await assert.rejects(tmux.answerSessionQuestion(f.params, f.overrides));
    assert.equal(f.calls.length, 1);
  }
});

test('an ambiguous Plan numeric selection is consumed and never replayed', async () => {
  const f = planFixture(clippedPlanScreen);
  f.overrides.execTmux = async args => { f.calls.push(args.at(-1)); throw new Error('transport failure'); };
  await assert.rejects(tmux.answerSessionQuestion(f.params, f.overrides), /送达状态未知/);
  await assert.rejects(tmux.answerSessionQuestion(f.params, f.overrides), /已回答/);
  assert.deepEqual(f.calls, ['4']);
});

test('Plan execution choices confirm only the explicitly selected mode', async () => {
  for (const [answer, keys] of [['Yes, start executing', ['1']], ['Yes, execute as Goal', ['2']]]) {
    const f = planFixture();
    f.params.answer = answer;
    assert.equal((await tmux.answerSessionQuestion(f.params, f.overrides)).submitted, true);
    assert.deepEqual(f.calls, keys);
  }
});

test('Plan approval rejects changed plans, free-text editors and incomplete post-selection redraws', async () => {
  for (const kind of ['changed', 'feedback', 'editing', 'redraw']) {
    const f = planFixture();
    f.params.answer = 'Yes, start executing';
    if (kind === 'changed') f.setScreen(planScreen.replace('run tests', 'delete tests'));
    if (kind === 'feedback') f.params.answer = 'Refuse and say something';
    if (kind === 'editing') f.setScreen(planScreen.replace('❯ 1.', '  1.').replace('  3.', '❯ 3.'));
    if (kind === 'redraw') f.overrides.execTmux = async args => {
      f.calls.push(args.at(-1));
      f.setScreen(planScreen.replace('❯ 1.', '  1.'));
    };
    await assert.rejects(tmux.answerSessionQuestion(f.params, f.overrides), undefined, kind);
    assert.equal(f.calls.length, kind === 'redraw' ? 1 : 0, kind);
  }
});

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

function nativeFixture(initialScreen = screen) {
  const tracker = new QoderQuestionTracker();
  const agent = { kind: 'qodercli', id: 'thread', paneId: '%42' };
  const question = tracker.observe('qoder', agent, initialScreen);
  let visible = initialScreen;
  const calls = [];
  const overrides = { questionTracker: tracker,
    listTmuxSessions: async () => [{ name: 'qoder', agent }],
    capturePane: async () => visible,
    waitForQuestion: async () => {},
    execTmux: async args => {
      calls.push(args);
      if (args.at(-1) === 'Down') visible = initialScreen.replace('❯ 1.', '  1.').replace('  2.', '❯ 2.');
      if (args.at(-1) === 'Enter') visible = 'AskUserQuestion\nUser answered: Skip scan';
    },
  };
  return { tracker, agent, question, calls, overrides, setScreen: value => { visible = value; },
    params: { provider: 'qodercli', sessionName: 'qoder', threadId: 'thread', questionId: question.id, answer: 'Skip scan' } };
}

test('chat-layout answers use the native answer row once and never enter an editor', async () => {
  for (const [answer, keys] of [['Run L3 deep security review', ['Enter']], ['Skip scan and continue', ['Down', 'Enter']]]) {
    const f = nativeFixture(chatScreen); f.params.answer = answer;
    assert.equal((await tmux.answerSessionQuestion(f.params, f.overrides)).submitted, true);
    assert.deepEqual(f.calls.map(args => args.at(-1)), keys);
    assert.ok(f.calls.every(args => args.includes('%42')));
    await assert.rejects(tmux.answerSessionQuestion(f.params, f.overrides));
    assert.equal(f.calls.length, keys.length, 'a consumed answer cannot be replayed');
  }
});

test('chat-layout stale answers, editor rows and stalled navigation cannot send Enter', async () => {
  for (const kind of ['question', 'text', 'chat', 'editing', 'stalled']) {
    const f = nativeFixture(chatScreen); f.params.answer = 'Skip scan and continue';
    if (kind === 'question') f.setScreen(chatScreen.replace('TASK-035', 'TASK-999'));
    if (kind === 'text') f.params.answer = 'Type something.';
    if (kind === 'chat') f.params.answer = 'Chat about this';
    if (kind === 'editing') f.setScreen(chatScreen.replace('❯ 1.', '  1.').replace('  3.', '❯ 3.'));
    if (kind === 'stalled') f.overrides.execTmux = async args => { f.calls.push(args); };
    await assert.rejects(tmux.answerSessionQuestion(f.params, f.overrides), undefined, kind);
    assert.equal(f.calls.some(args => args.at(-1) === 'Enter'), false, kind);
  }
});

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
