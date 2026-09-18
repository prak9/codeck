import test from 'node:test';
import assert from 'node:assert/strict';
import { sendSessionMessage } from '../src/tmux.js';

function fixture({ draft = '', footer = 'gpt-… Goal stalled (/goal resume)', menu = false, clipped = false } = {}) {
  let cursor = Math.floor(draft.length / 2);
  const sent = [];
  const keys = [];
  let buffer = '';
  const overrides = {
    listTmuxSessions: async () => [{ name: 'replacement', agent: { kind: 'codex', id: 'one', paneId: '%7' } }],
    loadBuffer: async (_name, text) => { buffer = text; },
    waitForPaste: async () => {}, waitForSubmit: async () => {}, waitForSlashOutput: async () => {},
    capturePane: async () => menu
      ? 'Choose response\n› 1. Approve\n  2. Deny\nPress enter to confirm or esc to go back'
      : `› ${(clipped ? draft.split('\n').slice(0, 4).join('\n') : draft).replaceAll('\n', '\n  ')}\n\n  ${footer}`,
    execTmux: async (args) => {
      if (args.includes('paste-buffer')) {
        draft = draft.slice(0, cursor) + buffer + draft.slice(cursor);
        cursor += buffer.length;
      }
      const index = args.indexOf('send-keys');
      if (index < 0) return;
      const input = args.slice(args.indexOf('%7', index) + 1);
      if (args.includes('-l')) {
        const text = args.at(-1);
        draft = draft.slice(0, cursor) + text + draft.slice(cursor);
        cursor += text.length;
        return;
      }
      for (const key of input) {
        keys.push(key);
        if (key === 'Escape') { menu = false; continue; }
        assert.equal(menu, false, 'never type or confirm into an approval menu');
        assert.notEqual(key, 'C-c', 'never interrupt to clear a draft');
        if (key === 'C-u') {
          const start = draft.lastIndexOf('\n', cursor - 1) + 1;
          const from = start === cursor ? Math.max(0, cursor - 1) : start;
          draft = draft.slice(0, from) + draft.slice(cursor);
          cursor = from;
        } else if (key === 'C-k') {
          const newline = draft.indexOf('\n', cursor);
          const to = newline < 0 ? draft.length : newline === cursor ? cursor + 1 : newline;
          draft = draft.slice(0, cursor) + draft.slice(to);
        } else if (key === 'Enter') {
          sent.push(draft);
          draft = ''; cursor = 0;
        }
      }
    },
  };
  return { overrides, sent, keys };
}

test('Codex replaces drafts without recognizing the model/footer layout', async () => {
  for (const draft of ['', 'old draft', 'before\ncurrent\nafter', Array(90).fill('old').join('\n')]) {
    for (const text of ['New message', '/status']) {
      const f = fixture({ draft });
      await sendSessionMessage({ provider: 'codex', sessionName: 'replacement', threadId: 'one', text }, f.overrides);
      assert.deepEqual(f.sent, [text.startsWith('/') ? `${text} ` : text]);
      assert.equal(f.keys.includes('Escape'), false);
    }
  }
});

test('Codex cancels a visible approval instead of approving it before replacing the draft', async () => {
  const f = fixture({ draft: 'old\ndraft', menu: true });
  await sendSessionMessage({ provider: 'codex', sessionName: 'replacement', threadId: 'one', text: 'Continue' }, f.overrides);
  assert.equal(f.keys[0], 'Escape');
  assert.deepEqual(f.sent, ['Continue']);
});

test('identical visible lines do not stop clearing a draft that exceeds the viewport', async () => {
  const f = fixture({ draft: Array(90).fill('old').join('\n'), clipped: true });
  await sendSessionMessage({ provider: 'codex', sessionName: 'replacement', threadId: 'one', text: 'Continue' }, f.overrides);
  assert.deepEqual(f.sent, ['Continue']);
});

test('a changed pane after draft clearing receives neither paste nor Enter', async () => {
  const f = fixture({ draft: 'old' });
  f.overrides.listTmuxSessions = async () => [{ name: 'replacement', agent: {
    kind: 'codex', id: 'one', paneId: f.keys.includes('C-u') ? '%8' : '%7',
  } }];
  await assert.rejects(sendSessionMessage({ provider: 'codex', sessionName: 'replacement', threadId: 'one', text: 'Continue' }, f.overrides), /pane 已变化/);
  assert.deepEqual(f.sent, []);
  assert.equal(f.keys.includes('Enter'), false);
});

test('approval cancellation and update menus never receive Enter if dismissal fails', async () => {
  for (const hint of ['Press enter to confirm or esc to cancel', 'Press enter to continue']) {
    const f = fixture();
    f.overrides.capturePane = async () => `Choose response\n› 1. Approve\n  2. Deny\n${hint}`;
    await assert.rejects(sendSessionMessage({ provider: 'codex', sessionName: 'replacement', threadId: 'one', text: 'Continue' }, f.overrides), /弹窗尚未关闭/);
    assert.deepEqual(f.keys, ['Escape']);
    assert.deepEqual(f.sent, []);
  }
});

test('unprocessed clear keys cannot silently append to a still-visible draft', async () => {
  const f = fixture();
  f.overrides.capturePane = async () => '› Existing draft\n\n  gpt-… Goal stalled (/goal resume)';
  await assert.rejects(sendSessionMessage({ provider: 'codex', sessionName: 'replacement', threadId: 'one', text: 'Continue' }, f.overrides), /草稿未能清除/);
  assert.deepEqual(f.sent, []);
  assert.equal(f.keys.includes('Enter'), false);
});

test('a draft equal to the placeholder is also replaced', async () => {
  const f = fixture({ draft: 'Ask Codex to do anything', footer: 'gpt-6-astra · /project' });
  await sendSessionMessage({ provider: 'codex', sessionName: 'replacement', threadId: 'one', text: 'Continue' }, f.overrides);
  assert.deepEqual(f.sent, ['Continue']);
});
