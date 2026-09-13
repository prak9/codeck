// A readonly native textarea gives touch browsers selection handles without routing
// gestures through xterm or sending any input to the CLI. Freeze only this snapshot.
export function bindTerminalTextSelection({ dialog, text, status, copy, close, getSnapshot, clipboard = globalThis.navigator?.clipboard }) {
  let generation = 0;
  const open = () => {
    generation += 1;
    text.value = getSnapshot();
    status.textContent = text.value ? '' : '当前画面没有文本，请返回终端后重试';
    dialog.showModal();
    text.selectionStart = text.selectionEnd = 0;
    text.scrollTop = text.scrollLeft = 0;
  };
  const clear = () => {
    generation += 1;
    text.value = '';
    status.textContent = '';
  };
  close.addEventListener('click', () => {
    clear();
    dialog.close();
  });
  dialog.addEventListener('cancel', clear);
  dialog.addEventListener('close', () => {
    // Native close events are queued; a quick reopen already owns a new snapshot.
    if (!dialog.open) clear();
  });
  copy.addEventListener('click', async () => {
    const selected = text.value.slice(text.selectionStart, text.selectionEnd);
    if (!selected) {
      status.textContent = '请先长按文本，拖动选区手柄选择需要的部分';
      return;
    }
    const current = generation;
    try {
      if (!clipboard?.writeText) throw new Error('Clipboard unavailable');
      await clipboard.writeText(selected);
      if (current === generation) status.textContent = '已复制选中文本';
    } catch {
      if (current === generation) status.textContent = '剪贴板访问失败，请使用系统选区菜单中的“复制”';
    }
  });
  return open;
}
