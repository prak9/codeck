// 终端模式默认走本地输入: 逐字符直通 pty 意味着每敲一个键都要一次网络往返,
// 打字跟手程度直接等于 RTT。本地编辑把往返压缩成"回车那一次"。
//
// 代价是 CLI 收不到逐字符按键, 它自己的补全与快捷键会失效。所以默认相反: 凡是终端里
// 本来就该原样送达的按键一律直通, 只把浏览器真正需要的少数几个留在本地。白名单枚举不出
// CLI 会绑什么 —— Codex 用了 Ctrl+R, 下一版可能是别的。
const PASSTHROUGH_KEYS = new Map([
  ['Escape', '\x1b'],
  ['Tab', '\t'],
  ['ArrowLeft', '\x1b[D'],
  ['ArrowUp', '\x1b[A'],
  ['ArrowDown', '\x1b[B'],
  ['ArrowRight', '\x1b[C'],
]);

// 浏览器在文本框里离不开这几个。Ctrl+J 是我们自己的换行。
// Ctrl+C 不在其中: 只有选中了文字时才让给浏览器复制, 否则它是中断。
const BROWSER_OWNED = new Set(['v', 'x', 'z', 'y', 'a', 'j']);

export function terminalComposerKeyAction(event, { draft = '', caret = null, hasSelection = false } = {}) {
  if (!event || event.isComposing) return { type: 'insert' };
  const key = event.key;
  // Cmd 是浏览器的地盘 —— 复制、粘贴、全选。把它和 Ctrl 一样对待, macOS 上 Cmd+C
  // 就会给 CLI 发中断而不是复制。
  const control = event.ctrlKey && !event.metaKey && !event.altKey;
  const letter = key?.length === 1 ? key.toLowerCase() : '';

  if (key === 'Enter') {
    // Shift+Enter 交给浏览器原生插入换行 —— 那样撤销栈是完整的。
    if (event.shiftKey) return { type: 'insert' };
    // 行尾反斜杠续行, 与 Codex 和 Claude Code 一致: 换行, 并吃掉那个反斜杠。
    const before = draft.slice(0, caret ?? draft.length);
    if (before.endsWith('\\')) return { type: 'newline', stripBackslash: true };
    return { type: 'send' };
  }
  // Ctrl+J 就是 \n, TUI 读作换行而非提交。
  if (control && letter === 'j') return { type: 'newline' };
  // 进入模式的键: 之后每个按键都是这个模式的输入(补全的路径、搜索的查询串), 必须逐键
  // 到达 CLI。一次性的键(Ctrl+L 清屏、Ctrl+C 中断)不该抢焦点, 所以只列这两个。
  if (key === '@') return { type: 'handoff', data: '@' };
  if (control && letter === 'r') return { type: 'handoff', data: '\x12' };

  if (control && letter >= 'a' && letter <= 'z') {
    if (BROWSER_OWNED.has(letter)) return { type: 'insert' };
    // 草稿里选中了文字时 Ctrl+C 是复制; 没有选中才是中断。
    if (letter === 'c' && hasSelection) return { type: 'insert' };
    return { type: 'passthrough', data: String.fromCharCode(letter.charCodeAt(0) - 96) };
  }
  // Shift+Tab 是切换模式, 与补全的 Tab 是两回事, 但都该交给 CLI。
  if (key === 'Tab') return { type: 'passthrough', data: event.shiftKey ? '\x1b[Z' : '\t' };
  // 方向键: 草稿非空时是在编辑本地文本, 只有空草稿才是"调历史"。
  if (PASSTHROUGH_KEYS.has(key)) {
    if (key !== 'Escape' && draft) return { type: 'insert' };
    return { type: 'passthrough', data: PASSTHROUGH_KEYS.get(key) };
  }
  return { type: 'insert' };
}

// 交权只由一个裸 Esc 结束。方向键是 \x1b[A, 也含 \x1b —— 按字符匹配会让用户在补全
// 菜单或搜索结果里按一下方向键就被踢回本地模式, 而那正是最需要停留的时候。回车也不结束:
// 在补全菜单里它是"选中", 不是"我说完了"。
export function endsTerminalHandoff(data) {
  return data === '\x1b';
}

// 发送时保留换行。\n 是 Ctrl+J, TUI 读作"换行, 不要提交"; 结尾的 \r 才是提交。
export function terminalDraftForSend(draft) {
  return String(draft || '').replace(/\r\n?/gu, '\n').trim();
}
