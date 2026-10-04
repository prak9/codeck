import test from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_SCREEN_MARKERS, resolveScreenSignals, ensureAgentInputSubmitted, identifyAgentFromScreen, interruptSession, sendSessionMessage } from '../src/tmux.js';

const model = '  GPT-6-Astra medium · ~/py · 继续';
const help = '  ← for agents · ? for shortcuts                      ⚠ 1 warning · f2 to view';
const footerVariants = [
  model,
  `${model}\n${help}`,
  `${model}\n  ? for shortcuts`,
  `${model}\n  ⚠ 2 warnings · f2 to view`,
  `${model}\n  ← for agents · ? for shortcuts\n  ⚠ 1 warning · f2 to view`,
  `${model}\n  ← for agents · ? for\n  shortcuts\n  ⚠ 1 warning · f2 to view\n`,
  `  gpt-6-astra … Goal achieved (11m)\n  ? for shortcuts`,
];
const screen = (draft, footer) => `• previous reply\n\n› ${draft === 'Ask Codex to do anything' ? `\x1b[2m${draft}\x1b[0m` : draft}\n\n${footer}\n`;
const sessions = async () => [{ name: 'work', hasRunningProcess: false,
  agent: { kind: 'codex', id: 'thread-1', paneId: '%7' } }];

test('Codex identity accepts model status followed by shortcut and warning rows', () => {
  for (const footer of footerVariants.slice(0, -1)) {
    assert.equal(identifyAgentFromScreen(screen('Ask Codex to do anything', footer)), 'codex', footer);
  }
});

test('guarded Codex sends recognize multiline footers, preserve row boundaries and submit once', async () => {
  for (const footer of footerVariants) {
    let draft = 'Ask Codex to do anything', buffer = '';
    const commands = [];
    const result = await sendSessionMessage({ provider: 'codex', sessionName: 'work', threadId: 'thread-1',
      text: '规划自主任务\n等待用户确认', nonInterrupting: true, replaceDraft: true }, {
      listTmuxSessions: sessions, capturePane: async () => screen(draft, footer),
      loadBuffer: async (_name, text) => { buffer = text; },
      execTmux: async args => {
        commands.push(args);
        if (args.includes('paste-buffer')) draft = buffer.replace(/\n/g, '\n  ');
        if (args.at(-1) === 'Enter') draft = 'Ask Codex to do anything';
      },
      waitForPaste: async () => {}, waitForSubmit: async () => {},
    });
    assert.equal(result.submissionStatus, 'submitted', footer);
    assert.equal(commands.filter(args => args.includes('paste-buffer')).length, 1);
    assert.equal(commands.filter(args => args.at(-1) === 'Enter').length, 1);
    assert.equal(commands.some(args => args.includes('Escape') || args.includes('C-u')), false);
  }
});

test('Codex idle exit accepts multiline footer without sending an interrupt key', async () => {
  for (const footer of footerVariants) {
    const commands = [];
    await interruptSession({ provider: 'codex', sessionName: 'work', threadId: 'thread-1',
      expectedPaneId: '%7', waitForIdle: true, onlyIfIdle: true }, {
      listTmuxSessions: sessions, capturePane: async () => screen('Ask Codex to do anything', footer),
      execTmux: async args => commands.push(args),
    });
    assert.deepEqual(commands, []);
  }
});

test('unknown content after a Codex footer never authorizes submission or idle exit', async () => {
  for (const [footer, suffix] of [model, model.toLowerCase()].flatMap(footer =>
    ['Unexpected overlay', 'Press enter to confirm', '? for shortcuts malicious extra text'].map(suffix => [footer, suffix]))) {
    const captured = screen('Ask Codex to do anything', `${footer}\n  ${suffix}`);
    const commands = [];
    assert.notEqual(identifyAgentFromScreen(captured), 'codex');
    await assert.rejects(interruptSession({ provider: 'codex', sessionName: 'work', threadId: 'thread-1',
      waitForIdle: true }, { listTmuxSessions: sessions, capturePane: async () => captured,
      execTmux: async args => commands.push(args) }));
    const result = await ensureAgentInputSubmitted({ paneId: '%7', text: 'my request', allowBusy: false,
      capturePane: async () => captured, execTmux: async args => commands.push(args),
      waitForSubmit: async () => {}, verifyPane: async () => true });
    assert.equal(result, 'unconfirmed');
    assert.deepEqual(commands, []);
  }
});

test('multiline footer does not turn status-like draft text into a live execution', () => {
  const captured = screen('Working (1s • esc to interrupt)', `${model}\n${help}`);
  assert.equal(resolveScreenSignals(captured, AGENT_SCREEN_MARKERS.codex).busy, false);
});

test('shortcut-like rows inside a real draft are not stripped or submitted as an empty composer', async () => {
  const captured = screen('first line\n  ? for shortcuts\n  keep this draft', `${model}\n${help}`);
  const commands = [];
  const result = await ensureAgentInputSubmitted({ paneId: '%7', text: 'different message', allowBusy: false,
    capturePane: async () => captured, execTmux: async args => commands.push(args),
    waitForSubmit: async () => {}, verifyPane: async () => true });
  assert.equal(result, 'unconfirmed');
  assert.deepEqual(commands, []);
});
