// 终端模式默认走本地输入: 逐字符直通 pty 意味着每敲一个键都要一次网络往返,
// 打字跟手程度直接等于 RTT。本地编辑把往返压缩成"回车那一次"。
//
// 代价是 CLI 收不到逐字符按键, 它自己的补全与快捷键会失效。所以这些按原样直通:
// Esc(中断) / Shift+Tab(切模式) / Ctrl-*(信号) / Tab(补全) / 草稿为空时的方向键
// (调历史)。而 '@' 是路径补全的触发字符 —— 它需要 CLI 接管后续每一个按键, 所以
// 先把已输入的内容原样送过去(不带回车), 再把控制权交给终端。
const PASSTHROUGH_KEYS = new Map([
  ['Escape', 'escape'],
  ['Tab', 'tab'],
  ['ArrowLeft', 'left'],
  ['ArrowUp', 'up'],
  ['ArrowDown', 'down'],
  ['ArrowRight', 'right'],
]);

const CONTROL_KEYS = new Map([
  ['c', 'ctrl-c'],
  ['d', 'ctrl-d'],
  ['l', 'ctrl-l'],
]);

export function terminalComposerKeyAction(event, { draft = '' } = {}) {
  if (!event || event.isComposing) return { type: 'insert' };
  const key = event.key;

  if (key === 'Enter') {
    if (event.shiftKey) return { type: 'insert' };
    return { type: 'send' };
  }
  // '@' 触发 CLI 的路径补全, 它需要接管后续按键。
  if (key === '@') return { type: 'handoff' };

  if ((event.ctrlKey || event.metaKey) && CONTROL_KEYS.has(key?.toLowerCase?.())) {
    return { type: 'passthrough', key: CONTROL_KEYS.get(key.toLowerCase()) };
  }
  // Shift+Tab 是切换模式, 与补全的 Tab 是两回事, 但都该交给 CLI。
  if (key === 'Tab') return { type: 'passthrough', key: 'tab', shift: event.shiftKey };
  if (key === 'Escape') return { type: 'passthrough', key: 'escape' };
  // 方向键: 草稿非空时是在编辑本地文本, 只有空草稿才是"调历史"。
  if (PASSTHROUGH_KEYS.has(key)) {
    return draft ? { type: 'insert' } : { type: 'passthrough', key: PASSTHROUGH_KEYS.get(key) };
  }
  return { type: 'insert' };
}

export const TERMINAL_SHIFT_TAB = '\x1b[Z';
