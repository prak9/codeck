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

// Qoder uses '*' for YOLO, '>' for other chat modes, and a colored cursor
// instead of reverse video in themes with an explicit background color.
const chatPlaceholders = ['>', '*'].flatMap(prompt => [
  ` ${prompt} \x1b[7m \x1b[0m Type your message or @path/to/file`,
  ` \x1b[31m${prompt} \x1b[7m \x1b[27m\x1b[90m Type your message or @path/to/file\x1b[0m`,
  ` \x1b[31m${prompt} \x1b[48;2;128;128;128m\x1b[38;2;0;0;0m \x1b[49m\x1b[38;2;128;128;128m Type your message or @path/to/file`,
  ` \x1b[31m${prompt} \x1b[38;5;0;48;5;244m \x1b[39;49m Type your message or @path/to/file`,
]);

test('Qoder confirms empty normal and YOLO chat composers across cursor themes after sending', async () => {
  for (const composer of chatPlaceholders) {
    for (const narrow of [false, true]) {
      const screen = pane(narrow ? composer.replace('or @path/to/file', 'or\n   @path/to/file') : composer)
        .replace('Shift+Tab to Accept Edits     14 skills', 'YOLO Shift+Tab to Auto Mode · 2 Background tasks')
        .replace('Qwen3.8-Max Model · ctx ░░░░░░░░░░ 0% · /project', 'Ultimate Model · ctx ▓▓▓▓▓▓░░░░ 63% · /project · +99 -15');
      const calls = [];
      const result = await sendSessionMessage({
        provider: 'qodercli', sessionName: 'qoder', threadId: 'thread-1', text: 'Continue',
      }, {
        listTmuxSessions: async () => [{ name: 'qoder', agent: { kind: 'qodercli', id: 'thread-1', paneId: '%7', hasBackgroundProcess: true } }],
        capturePane: async () => screen, loadBuffer: async () => {},
        execTmux: async args => calls.push(args), waitForSubmit: async () => {}, waitForPaste: async () => {},
      });
      assert.equal(result.submissionStatus, 'submitted', JSON.stringify(composer));
      assert.equal(calls.filter(args => args.includes('paste-buffer')).length, 1);
      assert.equal(calls.filter(args => args.includes('Enter')).length, 1, 'no duplicate Enter after submission');
    }
  }
});

test('Qoder YOLO retries only its complete matching draft', async () => {
  for (const text of ['Continue', 'Type your message or @path/to/file', 'First\n\n  Second']) {
    let screen = pane(` \x1b[31m*\x1b[39m ${text.replaceAll('\n', '\n   ')}`);
    let enters = 0;
    assert.equal(await ensureAgentInputSubmitted({
      paneId: '%7', provider: 'qodercli', text,
      capturePane: async () => screen, verifyPane: async () => true, waitForSubmit: async () => {},
      execTmux: async args => { assert.ok(args.includes('Enter')); enters += 1; screen = pane(chatPlaceholders[4]); },
    }), 'submitted');
    assert.equal(enters, 1);
  }
});

test('Qoder confirmation never retries shell mode, search, an unfocused widget or a different draft', async () => {
  for (const screen of [
    pane(chatPlaceholders[4].replace('*', '!')),
    pane(chatPlaceholders[4].replace('*', '(r:)')),
    pane(' * Another draft'),
    pane(' * Continue\n   extra'),
    pane(' * Type your message or @path/to/file'),
    pane(' * \x1b[7mT\x1b[27mype your message or @path/to/file'),
    pane(' * \x1b[7m  Type your message or @path/to/file\x1b[27m'),
    pane('\x1b[48;5;244m *   Type your message or @path/to/file\x1b[49m'),
    pane(' * \x1b[38;2;7;48;27m  Type your message or @path/to/file'),
    `${pane(chatPlaceholders[4])}\nAllow this tool? Enter to confirm`,
  ]) {
    assert.equal(await ensureAgentInputSubmitted({
      paneId: '%7', provider: 'qodercli', text: 'Continue', capturePane: async () => screen,
      verifyPane: async () => true, waitForSubmit: async () => {},
      execTmux: async () => assert.fail('unsafe retry'),
    }), 'unconfirmed');
  }
});

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

test('Qoder sends once without a recognizable or empty composer and reports confirmation separately', async () => {
  for (const screen of ['', '⠋ Generating... (esc to cancel, 1m 33s)',
    pane().replace('Qwen3.8-Max Model', 'Custom status line'), pane(' > My draft'),
    'Select permission\nEnter to confirm', null]) {
    const calls = [];
    const result = await sendSessionMessage({
      provider: 'qodercli', sessionName: 'qoder', threadId: 'thread-1', text: 'Continue',
    }, {
      listTmuxSessions: async () => [{ name: 'qoder', agent: { kind: 'qodercli', id: 'thread-1', paneId: '%7' } }],
      capturePane: async () => { if (screen === null) throw new Error('capture unavailable'); return screen; },
      loadBuffer: async () => {},
      execTmux: async (args) => calls.push(args), waitForSubmit: async () => {}, waitForPaste: async () => {},
    });
    assert.equal(result.submissionStatus, 'unconfirmed');
    assert.equal(calls.filter(args => args.includes('paste-buffer')).length, 1);
    assert.equal(calls.filter(args => args.includes('Enter')).length, 1);
    assert.equal(calls.some(args => args.includes('Escape') || args.includes('C-u')), false);
  }
});

test('Qoder still revalidates its exact Agent and pane before injecting text or commands', async () => {
  for (const text of ['Continue', 'First\nSecond', '/usage']) {
    for (const change of [{ paneId: '%8' }, { id: 'another-thread' }, { kind: 'codex' }]) {
      let prepared = false;
      const calls = [];
      await assert.rejects(sendSessionMessage({ provider: 'qodercli', sessionName: 'qoder', threadId: 'thread-1', text }, {
        listTmuxSessions: async () => [{ name: 'qoder', agent: {
          kind: 'qodercli', id: 'thread-1', paneId: '%7', ...(prepared ? change : {}),
        } }],
        loadBuffer: async () => { prepared = true; },
        capturePane: async () => pane(), captureSlashPane: async () => { prepared = true; return ''; },
        execTmux: async args => calls.push(args), waitForSubmit: async () => {}, waitForPaste: async () => {}, waitForSlashOutput: async () => {},
      }), /pane 已变化/);
      assert.ok(calls.every(args => args[0] === 'delete-buffer'), 'cleanup is allowed, input is not');
    }
  }
});

test('Qoder commands do not require the terminal composer layout either', async () => {
  const calls = [];
  await sendSessionMessage({ provider: 'qodercli', sessionName: 'qoder', threadId: 'thread-1', text: '/usage' }, {
    listTmuxSessions: async () => [{ name: 'qoder', agent: { kind: 'qodercli', id: 'thread-1', paneId: '%7' } }],
    capturePane: async () => 'custom terminal layout', execTmux: async args => calls.push(args),
    waitForPaste: async () => {}, waitForSlashOutput: async () => {},
  });
  assert.equal(calls.filter(args => args.includes('/usage')).length, 1);
  assert.equal(calls.filter(args => args.includes('Enter')).length, 1);
});

test('Qoder does not send a delayed Enter into a changed pane after text was delivered', async () => {
  for (const text of ['Continue', '/usage']) {
    let wrote = false;
    const calls = [];
    const result = await sendSessionMessage({ provider: 'qodercli', sessionName: 'qoder', threadId: 'thread-1', text }, {
      listTmuxSessions: async () => [{ name: 'qoder', agent: { kind: 'qodercli', id: 'thread-1', paneId: wrote ? '%8' : '%7' } }],
      loadBuffer: async () => {}, capturePane: async () => '',
      execTmux: async args => { calls.push(args); wrote = true; },
      waitForPaste: async () => {}, waitForSubmit: async () => {}, waitForSlashOutput: async () => {},
    });
    assert.equal(result.submissionStatus, 'unconfirmed');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].includes('Enter'), false);
  }
});

test('Qoder tolerates a transient redraw while confirming its single injection', async () => {
  let afterWrite = 0;
  let pastes = 0;
  const result = await sendSessionMessage({
    provider: 'qodercli', sessionName: 'qoder', threadId: 'thread-1', text: 'Continue',
  }, {
    listTmuxSessions: async () => [{ name: 'qoder', agent: { kind: 'qodercli', id: 'thread-1', paneId: '%7' } }],
    capturePane: async () => ++afterWrite === 1 ? 'redrawing' : pane(),
    loadBuffer: async () => {},
    execTmux: async args => { if (args.includes('paste-buffer')) pastes += 1; },
    waitForSubmit: async () => {}, waitForPaste: async () => {},
  });
  assert.equal(result.submissionStatus, 'submitted');
  assert.equal(pastes, 1);
});
