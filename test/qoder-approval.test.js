import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseQoderQuestion, QoderQuestionTracker } from '../src/qoder-question.js';
import { answerSessionQuestion } from '../src/tmux.js';

const command = fs.readFileSync(new URL('./fixtures/qoder-permission-command.txt', import.meta.url), 'utf8');
const emptyPlan = fs.readFileSync(new URL('./fixtures/qoder-empty-plan.txt', import.meta.url), 'utf8');
const permission = (body, scope = 'Allow for this session [session]', editor = false) =>
  `Permission Required\n─────────────────────────────────────\n${body}\n`
  + `❯ 1. Allow once\n  2. ${scope}\n`
  + (editor ? '  3. Modify with external editor\n' : '')
  + `  ${editor ? 4 : 3}. Reject and type something\n  ${editor ? 5 : 4}. No\n`
  + '↑↓ navigate · Enter select · Esc close\n';

test('native permissions preserve command details, explicit scope and terminal indices', () => {
  const parsed = parseQoderQuestion(command);
  assert.ok(parsed);
  assert.match(parsed.question, /Command: printf 'hello\\n'\n  printf 'done\\n'/);
  assert.deepEqual(parsed.options.map(option => option.index), [0, 1, 3]);
  assert.match(parsed.options[1].label, /future sessions \[local\]/);
  assert.match(parsed.options[1].description, /后续会话/);
  assert.equal(parsed.selectByNumber, true);
});

test('file read/edit, network, MCP and sandbox permissions use complete native evidence', () => {
  for (const screen of [
    permission('Tool: Read\nFile: /fixture/data.txt\nAllow reading this file?'),
    permission('Tool: Edit\nFile: /fixture/app.js\n- old value\n+ new value\nApply this change?', undefined, true),
    permission('Tool: WebFetch\nRequest: Fetch documentation\nURLs to fetch:\nhttps://example.com/docs\nDo you want to proceed?', 'Always allow "example.com" for future sessions [local]'),
    permission('Tool: mcp__demo__read\nServer: demo\nMCP Tool: read\nAllow execution of MCP tool "read" from server "demo"?\nArguments:\n path: /fixture/data.txt', 'Always allow "demo/read" for future sessions [local]'),
    permission('Tool: Bash\nCommand: curl\n┌────────────────┐\ncurl https://example.com\n└────────────────┘\nTo run [curl], allow access to the following?\n• Network: All Urls'),
  ]) {
    const parsed = parseQoderQuestion(screen);
    assert.ok(parsed, screen);
    assert.equal(parsed.options.at(-1).label, 'No');
    assert.equal(parsed.options.at(-1).index, screen.includes('external editor') ? 4 : 3);
  }
});

test('incomplete, stale, ambiguous or editing permissions fail closed', () => {
  for (const screen of [
    command.replace('Permission Required', 'Example'),
    command.replace('Command:', 'Output:'),
    command.replace('printf', 'printf…'),
    command.replace('  4. No', ''),
    command.replace('  4. No', '  5. No'),
    command.replace('[local]', '[session]'),
    command.replace('Esc close', 'Esc unknown'),
    command.replace('❯ 1.', '  1.'),
    command.replace('❯ 1.', '  1.').replace('  3.', '❯ 3.'),
    command + '> continue\n',
    command + 'Generating...\n',
    permission('Tool: Edit\nFile: /fixture/app.js\nApply this change?'),
    permission('Tool: Unknown\nDo you want to proceed?'),
  ]) assert.equal(parseQoderQuestion(screen), null, screen);
});

test('empty Plan fallback preserves the native exit/stay choices and missing-content warning', () => {
  const parsed = parseQoderQuestion(emptyPlan);
  assert.ok(parsed);
  assert.deepEqual(parsed.options.map(option => option.label), ['Yes, exit plan mode', 'No, stay in plan mode']);
  assert.match(parsed.question, /no plan content/);
  assert.equal(parseQoderQuestion(emptyPlan + '> next\n'), null);
});

function fixture(screen, answer) {
  const tracker = new QoderQuestionTracker();
  const agent = { kind: 'qodercli', id: 'thread', paneId: '%42' };
  let visible = screen;
  const question = tracker.observe('qoder', agent, visible);
  const calls = [];
  const overrides = { questionTracker: tracker,
    listTmuxSessions: async () => [{ name: 'qoder', agent }],
    capturePane: async () => visible, waitForQuestion: async () => {},
    execTmux: async args => { calls.push(args); visible = 'Action completed'; },
  };
  return { calls, overrides, setScreen: value => { visible = value; },
    params: { provider: 'qodercli', sessionName: 'qoder', threadId: 'thread', questionId: question?.id, answer } };
}

test('permissions and empty Plan submit exactly the chosen numeric option once', async () => {
  for (const [screen, answer, key] of [[command, 'Allow once', '1'], [command, 'No', '4'],
    [command, 'Always allow "printf" for future sessions [local]', '2'],
    [permission('Tool: Read\nFile: /fixture/data.txt\nAllow reading this file?'), 'Allow for this session [session]', '2'],
    [permission('Tool: Edit\nFile: /fixture/app.js\n- old value\n+ new value\nApply this change?', undefined, true), 'No', '5'],
    [emptyPlan, 'Yes, exit plan mode', '1'], [emptyPlan, 'No, stay in plan mode', '2']]) {
    const f = fixture(screen, answer);
    assert.equal((await answerSessionQuestion(f.params, f.overrides)).submitted, true);
    assert.deepEqual(f.calls.map(args => args.at(-1)), [key]);
    assert.ok(f.calls.every(args => args.includes('%42')));
    await assert.rejects(answerSessionQuestion(f.params, f.overrides));
    assert.equal(f.calls.length, 1);
  }
});

test('changed command or authorization scope cannot reuse an observed approval', async () => {
  for (const next of [command.replace("printf 'hello", "rm 'hello"), command.replace('"printf"', '"sh"')]) {
    const f = fixture(command, 'Allow once');
    f.setScreen(next);
    await assert.rejects(answerSessionQuestion(f.params, f.overrides), /已变化/);
    assert.equal(f.calls.length, 0);
  }
});

test('ambiguous permission writes and partial redraws never report success or replay', async () => {
  for (const screen of [command, emptyPlan]) for (const failure of ['transport', 'redraw']) {
    const f = fixture(screen, screen === command ? 'Allow once' : 'Yes, exit plan mode');
    f.overrides.execTmux = async args => {
      f.calls.push(args);
      if (failure === 'transport') throw new Error('transport failed');
      f.setScreen(screen.replace('❯ 1.', '  1.'));
    };
    await assert.rejects(answerSessionQuestion(f.params, f.overrides), failure === 'transport' ? /送达状态未知/ : /未确认/);
    await assert.rejects(answerSessionQuestion(f.params, f.overrides));
    assert.equal(f.calls.length, 1);
  }
});
