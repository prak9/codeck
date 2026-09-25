// Scope selection is shared by terminal and Remote; cancelling sends nothing.
export function chooseStopScope(background, document = globalThis.document) {
  if (!background) return Promise.resolve('foreground');
  return new Promise(resolve => {
    const dialog = document.createElement('dialog');
    dialog.className = 'session-stop-dialog';
    dialog.setAttribute('aria-label', '停止任务');
    const title = document.createElement('h2'); title.textContent = '停止任务'; dialog.append(title);
    const finish = scope => { dialog.close(); dialog.remove(); resolve(scope); };
    for (const [scope, text] of [['all', '全部停止'], ['foreground', '仅停止当前执行'], [null, '取消']]) {
      const button = document.createElement('button'); button.type = 'button';
      button.className = 'secondary-button'; button.textContent = text;
      button.addEventListener('click', () => finish(scope)); dialog.append(button);
    }
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
    document.body.append(dialog); dialog.showModal();
  });
}
