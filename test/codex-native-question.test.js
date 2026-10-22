import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCodexQuestion } from '../src/codex-question.js';
import { QoderQuestionTracker } from '../src/qoder-question.js';
import { answerSessionQuestion } from '../src/tmux.js';
import { tmuxSessionsToThreads, threadExecutionState } from '../public/agent-model.js';

const screen = `Approaching rate limits
Switch to a model that uses fewer credits?
› 1. Switch to gpt-6-mini
     Uses fewer credits for upcoming turns
  2. Keep current model
  3. Keep current model (never show again)
     Hide future rate limit reminders about switching models
Press enter to confirm or esc to go back`;

test('Codex native questions survive the session-to-remote snapshot boundary', () => {
  const question = new QoderQuestionTracker().observe('research', { kind: 'codex', id: 'thread', paneId: '%42' }, screen);
  const [thread] = tmuxSessionsToThreads([{ name: 'research', status: 'done', agent: { kind: 'codex', id: 'thread', question } }]);
  assert.deepEqual(thread.tmux.question, question);
  assert.equal(threadExecutionState(thread), 'waitingForInput');
});

test('Codex rate-limit switch is an actionable native question, including wrapped rows', () => {
  for (const value of [screen, screen.replace('Keep current model (never show again)', 'Keep current model (never\n     show again)').replace('or esc to go back', 'or esc to\n go back')]) {
    const parsed = parseCodexQuestion(value);
    assert.equal(parsed.options.length, 3);
    assert.equal(parsed.options[2].label, 'Keep current model (never show again)');
    assert.equal(parsed.cursor, 0);
  }
  for (const value of [screen + '\n› Ask Codex to do anything', screen.replace('› 1.', '  1.'),
    screen.replace('  2.', '  4.'), screen.replace('Approaching rate limits', 'Example'),
    screen.replace('Keep current model', 'Delete files')]) assert.equal(parseCodexQuestion(value), null);
});

test('Codex native answer verifies cursor and consumes the question exactly once', async () => {
  const agent = { kind: 'codex', id: 'thread', paneId: '%42' };
  const tracker = new QoderQuestionTracker();
  const question = tracker.observe('research', agent, screen);
  assert.ok(question);
  let visible = screen;
  const keys = [];
  const params = { provider: 'codex', sessionName: 'research', threadId: 'thread', questionId: question.id, answer: 'Keep current model' };
  const overrides = { questionTracker: tracker, listTmuxSessions: async () => [{ name: 'research', agent }],
    capturePane: async () => visible, waitForQuestion: async () => {},
    execTmux: async args => {
      keys.push(args.at(-1));
      if (args.at(-1) === 'Down') visible = screen.replace('› 1.', '  1.').replace('  2.', '› 2.');
      if (args.at(-1) === 'Enter') visible = '› Ask Codex to do anything';
    } };
  assert.deepEqual(await answerSessionQuestion(params, overrides), { submitted: true });
  await assert.rejects(answerSessionQuestion(params, overrides));
  assert.deepEqual(keys, ['Down', 'Enter']);
});
