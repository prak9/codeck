import test from 'node:test';
import assert from 'node:assert/strict';
import { terminalComposerKeyAction } from '../public/terminal-compose.js';

const press = (key, extra = {}) => ({ key, shiftKey: false, ctrlKey: false, metaKey: false, isComposing: false, ...extra });

test('ordinary typing stays local so it costs no round trip', () => {
  for (const key of ['a', '中', ' ', '1', '-']) {
    assert.equal(terminalComposerKeyAction(press(key)).type, 'insert', key);
  }
});

test('Enter sends the line, Shift+Enter keeps editing', () => {
  assert.equal(terminalComposerKeyAction(press('Enter')).type, 'send');
  assert.equal(terminalComposerKeyAction(press('Enter', { shiftKey: true })).type, 'insert');
});

test('interrupt, mode cycling and completion reach the CLI untouched', () => {
  assert.deepEqual(terminalComposerKeyAction(press('Escape')), { type: 'passthrough', data: '\x1b' });
  assert.deepEqual(terminalComposerKeyAction(press('Tab')), { type: 'passthrough', data: '\t' });
  assert.deepEqual(terminalComposerKeyAction(press('Tab', { shiftKey: true })), { type: 'passthrough', data: '\x1b[Z' });
  assert.deepEqual(terminalComposerKeyAction(press('c', { ctrlKey: true })), { type: 'passthrough', data: '\x03' });
  assert.deepEqual(terminalComposerKeyAction(press('d', { ctrlKey: true })), { type: 'passthrough', data: '\x04' });
});

test('any Ctrl combination the browser does not need goes to the CLI as its control byte', () => {
  // 白名单枚举不出 CLI 会绑什么。终端里 Ctrl+字母 本来就是原样送达, 所以默认直通,
  // 只把浏览器真正需要的几个留在本地。Ctrl+R 尤其重要 —— 不接管的话它会刷新整个页面。
  assert.deepEqual(terminalComposerKeyAction(press('r', { ctrlKey: true })), { type: 'passthrough', data: '\x12' });
  assert.deepEqual(terminalComposerKeyAction(press('t', { ctrlKey: true })), { type: 'passthrough', data: '\x14' });
  assert.deepEqual(terminalComposerKeyAction(press('b', { ctrlKey: true })), { type: 'passthrough', data: '\x02' });
  assert.deepEqual(terminalComposerKeyAction(press('u', { ctrlKey: true })), { type: 'passthrough', data: '\x15' });
});

test('the browser keeps the editing shortcuts a textarea cannot do without', () => {
  for (const key of ['v', 'x', 'z', 'y', 'a']) {
    assert.equal(terminalComposerKeyAction(press(key, { ctrlKey: true })).type, 'insert', `Ctrl+${key}`);
  }
  // Ctrl+J 是我们自己的换行, 不该变成 \n 直通。
  assert.equal(terminalComposerKeyAction(press('j', { ctrlKey: true })).type, 'newline');
});

test('@ hands control to the CLI so its path completion can take over', () => {
  assert.equal(terminalComposerKeyAction(press('@')).type, 'handoff');
});

test('arrow keys navigate history only when the draft is empty', () => {
  assert.deepEqual(terminalComposerKeyAction(press('ArrowUp'), { draft: '' }), { type: 'passthrough', data: '\x1b[A' });
  assert.equal(terminalComposerKeyAction(press('ArrowUp'), { draft: 'hello' }).type, 'insert',
    '草稿非空时方向键是在编辑本地文本, 不该被抢走');
  assert.equal(terminalComposerKeyAction(press('ArrowLeft'), { draft: 'hi' }).type, 'insert');
});

test('an in-flight IME composition is never intercepted', () => {
  // 中文输入法组字期间抢键会把候选framework打断。
  assert.equal(terminalComposerKeyAction(press('Enter', { isComposing: true })).type, 'insert');
  assert.equal(terminalComposerKeyAction(press('Escape', { isComposing: true })).type, 'insert');
});

test('Ctrl+J inserts a newline instead of doing nothing', () => {
  // Codex 与 Claude Code 的 TUI 都把 \r 当提交、\n 当换行, Ctrl+J 正是 \n。
  assert.deepEqual(terminalComposerKeyAction(press('j', { ctrlKey: true })), { type: 'newline' });
  // Shift+Enter 走浏览器原生插入, 撤销栈才完整; 只有浏览器不认的 Ctrl+J 需要我们动手。
  assert.equal(terminalComposerKeyAction(press('Enter', { shiftKey: true })).type, 'insert');
});

test('a trailing backslash turns Enter into a newline and eats the backslash', () => {
  assert.deepEqual(terminalComposerKeyAction(press('Enter'), { draft: 'first \\', caret: 7 }),
    { type: 'newline', stripBackslash: true });
  // 反斜杠不在光标正前方时, 回车仍然是发送。
  assert.equal(terminalComposerKeyAction(press('Enter'), { draft: 'a \\ b', caret: 5 }).type, 'send');
});

test('Cmd shortcuts stay with the browser so copy and paste still work', () => {
  // 之前 metaKey 与 ctrlKey 同等对待, 于是 macOS 上 Cmd+C 会给 CLI 发中断而不是复制。
  assert.equal(terminalComposerKeyAction(press('c', { metaKey: true })).type, 'insert');
  assert.equal(terminalComposerKeyAction(press('a', { metaKey: true })).type, 'insert');
});

test('Ctrl+C copies when something is selected, and interrupts when nothing is', () => {
  assert.equal(terminalComposerKeyAction(press('c', { ctrlKey: true }), { hasSelection: true }).type, 'insert');
  assert.deepEqual(terminalComposerKeyAction(press('c', { ctrlKey: true }), { hasSelection: false }),
    { type: 'passthrough', data: '\x03' });
});
