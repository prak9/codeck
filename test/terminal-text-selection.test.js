import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { bindTerminalTextSelection } from '../public/terminal-text-selection.js';

function fixture() {
  const nodes = Object.fromEntries(['dialog', 'text', 'status', 'copy', 'close'].map(id => [id, {
    value: '', textContent: '', selectionStart: 0, selectionEnd: 0, open: false,
    listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; },
    showModal() { this.open = true; }, close() { this.open = false; this.listeners.close?.(); },
  }]));
  let snapshot = '第一行\n部分文本 <script>\n最后一行';
  const copied = [];
  const clipboard = { async writeText(text) { copied.push(text); } };
  const open = bindTerminalTextSelection({ ...nodes, getSnapshot: () => snapshot, clipboard });
  return { ...nodes, open, copied, clipboard, setSnapshot: value => { snapshot = value; } };
}

test('selection copy captures a stable plain-text snapshot and copies only the chosen substring', async () => {
  const f = fixture();
  f.open();
  assert.equal(f.dialog.open, true);
  f.setSnapshot('new output');
  assert.equal(f.text.value, '第一行\n部分文本 <script>\n最后一行');
  f.text.selectionStart = 4;
  f.text.selectionEnd = 8;
  await f.copy.listeners.click();
  assert.deepEqual(f.copied, ['部分文本']);
  assert.equal(f.status.textContent, '已复制选中文本');
});

test('empty selection never falls back to copying the whole screen; denied clipboard preserves selection', async () => {
  const f = fixture();
  f.open();
  await f.copy.listeners.click();
  assert.deepEqual(f.copied, []);
  assert.match(f.status.textContent, /先.*选择/);
  f.text.selectionStart = 0;
  f.text.selectionEnd = 3;
  f.clipboard.writeText = async () => { throw new Error('denied'); };
  await f.copy.listeners.click();
  assert.match(f.status.textContent, /系统.*复制/);
  assert.equal(f.text.selectionEnd, 3);
});

test('closing clears the snapshot; late clipboard results cannot change a reopened dialog', async () => {
  const f = fixture();
  let finish;
  f.clipboard.writeText = () => new Promise(resolve => { finish = resolve; });
  f.open();
  f.text.selectionEnd = 3;
  const pending = f.copy.listeners.click();
  f.close.listeners.click();
  assert.equal(f.text.value, '');
  f.setSnapshot('new session');
  f.open();
  finish();
  await pending;
  assert.equal(f.text.value, 'new session');
  assert.equal(f.status.textContent, '');
});

test('mobile entry uses a readonly native selection surface separate from xterm', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /data-terminal-action="select"/);
  assert.match(html, /<textarea[^>]*id="terminalSelectionText"[^>]*readonly/);
});

test('a queued native close event does not erase a newly opened snapshot', () => {
  const f = fixture();
  f.open();
  f.dialog.close = () => { f.dialog.open = false; };
  f.close.listeners.click();
  assert.equal(f.text.value, '');
  f.setSnapshot('replacement');
  f.open();
  f.dialog.listeners.close();
  assert.equal(f.text.value, 'replacement');
});
