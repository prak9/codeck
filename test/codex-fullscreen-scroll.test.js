import test from 'node:test';
import assert from 'node:assert/strict';
import { scrollSession, clickSessionTranscript } from '../src/tmux.js';

function fixture({ alternate = true, codex = true, current = true, footer = '? for shortcuts', draft = '', firstRow = 'Show details', width = 80, prefixWidth = 1 } = {}) {
  const commands = [];
  return { commands, options: {
    isCurrent: () => current,
    execTmux: async args => {
      commands.push(args);
      if (args[0] === 'display-message' && args.at(-1).startsWith('#{w:')) return { stdout: String(prefixWidth) };
      if (args[0] === 'display-message') return { stdout: `%7\t${Number(alternate)}\t${width}\n` };
      if (args[0] === 'capture-pane') return { stdout: codex
        ? ` ${firstRow}\n\n› ${draft}\n\n  GPT-6-Astra medium · ~/project\n  ${footer}`
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

test('right-aligned history overlay remains clickable alongside transcript text', async () => {
  const banner = 'New activity · ↓ Back to bottom · esc';
  const firstRow = `   资料来源${' '.repeat(80 - 11 - banner.length)}${banner}`;
  const f = fixture({ firstRow, prefixWidth: 45 });
  await clickSessionTranscript('work', 65, 1, f.options);
  assert.ok(f.commands.some(args => args[0] === 'if-shell'));
  const body = fixture({ firstRow, prefixWidth: 45 });
  await clickSessionTranscript('work', 5, 1, body.options);
  assert.equal(body.commands.some(args => args[0] === 'if-shell'), false);
  for (const options of [{ readOnly: true }, { isCurrent: () => false }]) {
    const blocked = fixture({ firstRow, prefixWidth: 45 });
    await clickSessionTranscript('work', 65, 1, { ...blocked.options, ...options });
    assert.equal(blocked.commands.some(args => args[0] === 'if-shell'), false);
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


test('native back-to-bottom banner accepts a click without Escape, Enter or draft edits', async () => {
  const f = fixture({ firstRow: 'New activity · ↓ Back to bottom · esc', draft: 'keep draft' });
  await clickSessionTranscript('work', 20, 1, f.options);
  assert.ok(f.commands.some(args => args[0] === 'if-shell'));
  assert.equal(f.commands.some(args => args.includes('Escape') || args.includes('Enter') || args.includes('C-u')), false);
  for (const options of [{ readOnly: true }, { isCurrent: () => false }]) {
    const blocked = fixture({ firstRow: 'New activity · ↓ Back to bottom · esc' });
    await clickSessionTranscript('work', 20, 1, { ...blocked.options, ...options });
    assert.equal(blocked.commands.some(args => args[0] === 'if-shell'), false);
  }
  const quoted = fixture({ firstRow: 'Agent says: New activity · ↓ Back to bottom · esc' });
  await clickSessionTranscript('work', 20, 1, quoted.options);
  assert.equal(quoted.commands.some(args => args[0] === 'if-shell'), false);
});

test('history viewport without composer footer can return to latest and scroll natively', async () => {
  const commands = [];
  const options = { execTmux: async args => {
    commands.push(args);
    if (args[0] === 'display-message' && args.at(-1).startsWith('#{w:')) return { stdout: '45' };
    if (args[0] === 'display-message') return { stdout: '%7\t1\t80\n' };
    if (args[0] === 'capture-pane') return { stdout: 'Agent response\n'
      + ' '.repeat(45) + 'New activity · ↓ Back to bottom · esc' };
    return { stdout: '' };
  } };
  await clickSessionTranscript('work', 65, 2, options);
  assert.ok(commands.some(args => args[0] === 'if-shell'), 'return control is reachable without a composer');
  commands.length = 0;
  await scrollSession('work', -6, options);
  assert.ok(commands.some(args => args[0] === 'if-shell'), 'history stays in Codex instead of tmux copy-mode');
  for (const guard of [{ readOnly: true }, { isCurrent: () => false }]) {
    commands.length = 0;
    await clickSessionTranscript('work', 65, 2, { ...options, ...guard });
    assert.equal(commands.some(args => args[0] === 'if-shell'), false);
  }
  commands.length = 0;
  await clickSessionTranscript('work', 5, 1, options);
  assert.equal(commands.some(args => args[0] === 'if-shell'), false);
});

test('native return control can overlay the middle of a CJK row with text on both sides', async () => {
  const firstRow = '资料来源  New activity · ↓ Back to bottom · esc  trailing transcript';
  const f = fixture({ firstRow, prefixWidth: 11 });
  await clickSessionTranscript('work', 25, 1, f.options);
  assert.ok(f.commands.some(args => args[0] === 'if-shell'));
  for (const column of [5, 60]) {
    const body = fixture({ firstRow, prefixWidth: 11 });
    await clickSessionTranscript('work', column, 1, body.options);
    assert.equal(body.commands.some(args => args[0] === 'if-shell'), false);
  }
});

test('return-control width queries treat transcript formats as literal text', async () => {
  const f = fixture({ firstRow: '汉#{pane_width}  ↓ Back to bottom · esc', prefixWidth: 18 });
  await clickSessionTranscript('work', 25, 1, f.options);
  const measure = f.commands.find(args => args.at(-1).startsWith('#{w:'));
  assert.equal(measure.at(-1), '#{w:#{l: 汉##{pane_width#}  }}');
  assert.ok(f.commands.some(args => args[0] === 'if-shell'));
});

test('stale return clicks stop after the asynchronous cell-width query', async () => {
  const f = fixture({ firstRow: '↓ Back to bottom · esc' });
  let current = true;
  await clickSessionTranscript('work', 8, 1, { isCurrent: () => current, execTmux: async args => {
    const result = await f.options.execTmux(args);
    if (args.at(-1).startsWith('#{w:')) current = false;
    return result;
  } });
  assert.equal(f.commands.some(args => args[0] === 'if-shell'), false);
});
