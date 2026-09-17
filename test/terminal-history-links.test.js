import test from 'node:test';
import assert from 'node:assert/strict';
import { createTerminalHistoryLinkReader, historyUrls } from '../src/terminal-history-links.js';
import { matchTerminalHistoryLinks } from '../public/terminal-history-links.js';

test('only complete logical HTTP URLs survive bounded capture, with Markdown and punctuation excluded', () => {
  assert.deepEqual(historyUrls('https://clipped.test/start\n[查看详情](https://example.com/a?b=2#part)\nhttp://other.test/x\nhttps://clipped.test/end\n'),
    ['https://example.com/a?b=2#part', 'http://other.test/x']);
  assert.deepEqual(historyUrls('https://first.test/full\nlast\n', { startComplete: true }), ['https://first.test/full']);
  assert.deepEqual(historyUrls('first\nhttps://a.test/part\nother-part\nlast\n'), ['https://a.test/part']);
});

function readerFixture({ mode = '1', changed = false, modern = true } = {}) {
  const calls = [];
  const state = `work\t%7\t60\t20\t3000\t${mode}\t10000\n`;
  return { calls, read: createTerminalHistoryLinkReader({ execTmux: async args => {
    calls.push(args);
    if (args[0] === 'display-message') return { stdout: state };
    if (args[0] === 'list-commands') return { stdout: `capture-pane [-pJ${modern ? 'M' : ''}]\n` };
    const marker = args[args.indexOf(';') + 3];
    return { stdout: `clipped\nhttps://example.com/full?q=1#end\nclipped\n${marker}\n${changed ? state.replace('3000', '3001') : state}` };
  } }) };
}

test('history reader deduplicates requests and reads only bounded copy-mode context', async () => {
  for (const modern of [true, false]) {
    const { read, calls } = readerFixture({ modern });
    const request = read('work');
    assert.equal(read('work'), request);
    assert.deepEqual(await request, { urls: ['https://example.com/full?q=1#end'] });
    const capture = calls.find(args => args[0] === 'capture-pane');
    assert.equal(capture.includes('-M'), modern);
    assert.equal(capture[capture.indexOf('-S') + 1], '-3128');
    assert.equal(capture[capture.indexOf('-E') + 1], '-2852');
    assert.equal(capture[capture.indexOf('-t') + 1], '%7');
  }
});

test('history reader ignores live panes and rejects changed snapshots or invalid targets', async () => {
  const live = readerFixture({ mode: '0' });
  assert.deepEqual(await live.read('work'), { urls: [] });
  assert.equal(live.calls.length, 1);
  assert.deepEqual(await readerFixture({ changed: true }).read('work'), { urls: [] });
  await assert.rejects(live.read('bad;target'), /无效/);
  assert.equal(live.calls.length, 1);
});

function screenTerminal(rows, viewportY = 0) {
  const lines = rows.map(text => {
    const cells = [];
    for (const char of text) {
      const width = /[\u4e00-\u9fff]/u.test(char) ? 2 : 1;
      cells.push({ getWidth: () => width, getChars: () => char });
      if (width === 2) cells.push({ getWidth: () => 0, getChars: () => '' });
    }
    return { length: cells.length, translateToString: () => text.trimEnd(), getCell: col => cells[col] };
  });
  return { rows: rows.length, cols: Math.max(...lines.map(line => line.length)), buffer: { active: { viewportY, getLine: row => lines[row - viewportY] } } };
}

test('historical URL ranges match every visible character across hard rows and wide text', () => {
  const terminal = screenTerminal(['查看 https://example.com/', 'path?q=1&b=2#anchor'], 12);
  const url = 'https://example.com/path?q=1&b=2#anchor';
  const [link] = matchTerminalHistoryLinks(terminal, [url], () => {});
  assert.deepEqual(link.range, { start: { x: 6, y: 13 }, end: { x: 19, y: 14 } });
  assert.equal(link.text, url);
  assert.deepEqual(matchTerminalHistoryLinks(terminal, [url.replace('q=1', 'q=2')], () => {}), []);
  assert.deepEqual(matchTerminalHistoryLinks(terminal, ['javascript:evil'], () => {}), []);
  assert.deepEqual(matchTerminalHistoryLinks(screenTerminal(['https://example.com/', 'unrelated text']), [url], () => {}), []);
  assert.deepEqual(matchTerminalHistoryLinks(screenTerminal(['https://example.com/', '', 'path?q=1&b=2#anchor']), [url], () => {}), []);
});

test('historical URLs never match only a prefix of another visible address', () => {
  const short = 'https://example.com/';
  const long = `${short}path?q=1#end`;
  const terminal = screenTerminal([long]);
  assert.deepEqual(matchTerminalHistoryLinks(terminal, [short], () => {}), []);
  assert.deepEqual(matchTerminalHistoryLinks(terminal, [short, long], () => {}).map(link => link.text), [long]);
});
