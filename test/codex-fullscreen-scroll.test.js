import test from 'node:test';
import assert from 'node:assert/strict';
import { scrollSession, clickSessionTranscript } from '../src/tmux.js';

function fixture({ alternate = true, codex = true, current = true, footer = '? for shortcuts', draft = '' } = {}) {
  const commands = [];
  return { commands, options: {
    isCurrent: () => current,
    execTmux: async args => {
      commands.push(args);
      if (args[0] === 'display-message') return { stdout: `%7\t${Number(alternate)}\n` };
      if (args[0] === 'capture-pane') return { stdout: codex
        ? `Show details\n\n› ${draft}\n\n  GPT-6-Astra medium · ~/project\n  ${footer}`
        : 'shell$ ' };
      return { stdout: '' };
    },
  } };
}

test('Codex fullscreen scroll uses native wheel reports, not tmux scrollback or arrow keys', async () => {
  for (const lines of [3, -6]) {
    const f = fixture();
    await scrollSession('work', lines, f.options);
    const send = f.commands.find(args => args[0] === 'if-shell');
    assert.ok(send, 'mode is rechecked atomically before injecting native scroll');
    assert.ok(send.some(arg => arg.includes(lines > 0 ? '[<64;2;2M' : '[<65;2;2M')));
    assert.equal(f.commands.some(args => args.includes('scroll-up') || args.includes('scroll-down')), false);
  }
});

test('busy Codex with an unsent draft still routes scroll to native history', async () => {
  const f = fixture({ footer: 'tab to queue message', draft: '^ do not change this' });
  await scrollSession('work', 24, f.options);
  assert.equal(f.commands.some(args => args[0] === 'if-shell'), true);
  assert.equal(f.commands.some(args => args.includes('scroll-up')), false);
  assert.equal(f.commands.some(args => args.includes('Enter') || args.includes('Escape') || args.includes('C-u')), false);
});

test('only fullscreen disclosure rows accept clicks; drafts and readonly views do not', async () => {
  const f = fixture();
  await clickSessionTranscript('work', 5, 1, f.options);
  assert.ok(f.commands.at(-1).at(-1).includes('\x1b[<0;5;1M\x1b[<0;5;1m'));
  for (const row of [2, 3, 6, -1, 1001]) {
    const safe = fixture();
    await clickSessionTranscript('work', 5, row, safe.options);
    assert.equal(safe.commands.some(args => args[0] === 'if-shell'), false);
  }
  const readonly = fixture();
  await clickSessionTranscript('work', 5, 1, { ...readonly.options, readOnly: true });
  assert.deepEqual(readonly.commands, []);
});

test('inline Codex and alternate-screen non-Codex retain tmux scrolling', async () => {
  for (const config of [{ alternate: false }, { codex: false }]) {
    const f = fixture(config);
    await scrollSession('work', 3, f.options);
    assert.equal(f.commands.some(args => args.includes('scroll-up')), true);
    assert.equal(f.commands.some(args => args[0] === 'if-shell'), false);
  }
});

test('read-only clients cannot inject native input and stale scrolls do nothing', async () => {
  const f = fixture();
  await scrollSession('work', 3, { ...f.options, readOnly: true });
  assert.equal(f.commands.some(args => args[0] === 'if-shell'), false);
  const stale = fixture({ current: false });
  await scrollSession('work', 3, stale.options);
  assert.deepEqual(stale.commands, []);
});
