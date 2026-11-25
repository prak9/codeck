import { visibleOutput, writeAgentOutputToClipboard } from './remote-copy.js?v=5';

export function bindOutputHistory({ getTarget, loadPage, notify }) {
  const dialog = document.querySelector('#outputHistoryDialog');
  const list = dialog.querySelector('#outputHistoryList');
  const status = dialog.querySelector('#outputHistoryStatus');
  const more = dialog.querySelector('#outputHistoryMore');
  let page;

  const current = request => page === request && dialog.open && getTarget()?.key === request.target.key;
  async function load() {
    const request = page;
    if (!current(request) || request.loading) return;
    request.loading = true;
    status.textContent = '读取中…';
    more.hidden = true;
    try {
      const { provider, threadId } = request.target;
      const { turns, nextCursor } = await loadPage({ provider, threadId, cursor: request.cursor, limit: 20 });
      if (!current(request)) return;
      for (const turn of [...turns].reverse()) {
        for (const item of [...(turn.items || [])].reverse()) {
          if (item.type !== 'agentMessage') continue;
          const text = visibleOutput(item.text);
          if (!text) continue;
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'output-history-row';
          button.textContent = text.slice(0, 240);
          button.addEventListener('click', async () => {
            if (!current(request)) return;
            try {
              await writeAgentOutputToClipboard(text);
              if (current(request)) { dialog.close(); notify('已复制所选回复'); }
            } catch (error) { if (current(request)) status.textContent = error.message; }
          });
          list.append(button);
        }
      }
      request.cursor = nextCursor;
      status.textContent = list.childElementCount ? '' : nextCursor ? '本页暂无模型输出' : '暂无模型输出';
      more.textContent = '加载更早的输出';
      more.hidden = !nextCursor;
    } catch (error) {
      if (!current(request)) return;
      status.textContent = error.message;
      more.textContent = '重试读取';
      more.hidden = false;
    } finally { request.loading = false; }
  }

  for (const trigger of document.querySelectorAll('[data-output-history]')) {
    trigger.addEventListener('click', () => {
      const target = getTarget();
      if (!target || dialog.open) return;
      page = { target, cursor: '', loading: false };
      list.replaceChildren();
      dialog.showModal();
      void load();
    });
  }
  more.addEventListener('click', load);
  dialog.addEventListener('close', () => {
    if (!dialog.open) { page = null; list.replaceChildren(); }
  });
  return { syncTarget() { if (dialog.open && getTarget()?.key !== page?.target.key) dialog.close(); } };
}
