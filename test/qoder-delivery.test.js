import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureAgentInputSubmitted, sendSessionMessage } from '../src/tmux.js';

// QoderCLI 1.1.28: the reverse-video space is the cursor before its placeholder.
const placeholder = ' > \x1b[7m \x1b[0m Type your message or @path/to/file';
const pane = (composer = placeholder) => [
  '────────────────────────────────────────',
  ' Shift+Tab to Accept Edits     14 skills',
  '────────────────────────────────────────', composer,
  '────────────────────────────────────────',
  ' Qwen3.8-Max Model · ctx ░░░░░░░░░░ 0% · /project',
].join('\n');

test('Qoder recognizes its empty composer even while a previous task is busy', async () => {
  const narrow = pane(' > \x1b[7m \x1b[0m Type your message or\n   @path/to/file')
    .replace('Qwen3.8-Max Model · ctx ░░░░░░░░░░ 0% · /project', 'Qwen3.8-Max Model · /data/.../codeck');
  const smallest = narrow.replace('Type your message or\n   @path/to/file', 'Type your message\n   or @path/to/file')
    .replace('Qwen3.8-Max Model · /data/.../codeck', 'Qwen3.8-Max Model');
  for (const screen of [pane(), narrow, smallest, pane().replace('/project', '/my project'),
    `⠋ Generating... (esc to cancel, 25s)\n${pane()}`,
    `✶ Waiting for 1 background agent to finish\n${pane()}`]) {
    assert.equal(await ensureAgentInputSubmitted({
      paneId: '%7', provider: 'qodercli', text: 'Continue', allowBusy: false,
      capturePane: async () => screen, verifyPane: async () => true,
      waitForSubmit: async () => {}, execTmux: async () => assert.fail('no extra Enter'),
    }), 'submitted');
  }
});

test('Qoder retries only the matching complete draft, including literal placeholder text', async () => {
  for (const text of ['Continue', 'Type your message or @path/to/file', 'First\n\n  Second']) {
    let draft = ` > ${text.replaceAll('\n', '\n   ')}`;
    let enters = 0;
    assert.equal(await ensureAgentInputSubmitted({
      paneId: '%7', provider: 'qodercli', text,
      capturePane: async () => pane(draft), verifyPane: async () => true,
      waitForSubmit: async () => {},
      execTmux: async (args) => { assert.ok(args.includes('Enter')); enters += 1; draft = placeholder; },
    }), 'submitted');
    assert.equal(enters, 1);
  }
});

test('Qoder never retries a different draft, a modal, or a clipped composer', async () => {
  for (const screen of [pane(' > Another draft'), pane(' > Continue\n   extra'),
    '> Continue\nSelect permission\nEnter to confirm', ' > Continue', '',
    `${pane(' > Continue')}\nAllow this tool? Enter to confirm`,
  ]) {
    assert.equal(await ensureAgentInputSubmitted({
      paneId: '%7', provider: 'qodercli', text: 'Continue',
      capturePane: async () => screen, verifyPane: async () => true,
      waitForSubmit: async () => {}, execTmux: async () => assert.fail('unsafe Enter'),
    }), 'unconfirmed');
  }
});

test('Qoder uses delayed bracketed paste and returns its actual submission result', async () => {
  const calls = [];
  let wrote = false;
  const result = await sendSessionMessage({
    provider: 'qodercli', sessionName: 'qoder', threadId: 'thread-1', text: 'Continue',
  }, {
    listTmuxSessions: async () => [{ name: 'qoder', agent: { kind: 'qodercli', id: 'thread-1', paneId: '%7' } }],
    capturePane: async () => wrote ? 'redrawing' : pane(),
    loadBuffer: async () => {}, bufferName: 'qoder-test',
    execTmux: async (args) => { wrote = true; calls.push(args); },
    waitForPaste: async () => calls.push('wait'), waitForSubmit: async () => {},
  });
  assert.equal(result.submissionStatus, 'unconfirmed');
  assert.deepEqual(calls, [
    ['copy-mode', '-q', '-t', '%7', ';', 'paste-buffer', '-p', '-d', '-b', 'qoder-test', '-t', '%7'],
    'wait', ['copy-mode', '-q', '-t', '%7', ';', 'send-keys', '-t', '%7', 'Enter'],
  ]);
});

test('Qoder refuses to append to an existing terminal draft or confirm an unseen modal', async () => {
  for (const screen of [pane(' > My draft'), 'Select permission\nEnter to confirm']) {
    const calls = [];
    await assert.rejects(sendSessionMessage({
      provider: 'qodercli', sessionName: 'qoder', threadId: 'thread-1', text: 'Continue',
    }, {
      listTmuxSessions: async () => [{ name: 'qoder', agent: { kind: 'qodercli', id: 'thread-1', paneId: '%7' } }],
      capturePane: async () => screen, loadBuffer: async () => {},
      execTmux: async (args) => calls.push(args), waitForSubmit: async () => {}, waitForPaste: async () => {},
    }), /消息未发送/);
    assert.equal(calls.length, 0);
  }
});

test('Qoder tolerates a transient redraw before and after its single injection', async () => {
  let captures = 0;
  let wrote = false;
  let afterWrite = 0;
  let pastes = 0;
  const result = await sendSessionMessage({
    provider: 'qodercli', sessionName: 'qoder', threadId: 'thread-1', text: 'Continue',
  }, {
    listTmuxSessions: async () => [{ name: 'qoder', agent: { kind: 'qodercli', id: 'thread-1', paneId: '%7' } }],
    capturePane: async () => {
      if (!wrote) return ++captures === 1 ? '' : pane();
      return ++afterWrite === 1 ? 'redrawing' : pane();
    },
    loadBuffer: async () => {},
    execTmux: async args => { wrote = true; if (args.includes('paste-buffer')) pastes += 1; },
    waitForSubmit: async () => {}, waitForPaste: async () => {},
  });
  assert.equal(result.submissionStatus, 'submitted');
  assert.equal(pastes, 1);
});
