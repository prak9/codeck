// Qoder 1.1.46 /tasks: the live list advertises "k kill" only for a
// cancellable selected task. Never use k in an unknown panel or clear history.
export function qoderTaskPanel(screen) {
  const rows = String(screen).replace(/\x1b\[[0-9;]*[A-Za-z]/gu, '').split('\n').map(row => row.trim())
    .filter(row => row && !/^[─━-]{4,}$/u.test(row));
  const start = rows.lastIndexOf('Background tasks');
  const footer = rows.findLastIndex(row => /Esc close/iu.test(row));
  if (footer < 0 || rows.slice(footer + 1).some(row => /^[>*❯›](?:\s|$)/u.test(row))) return null;
  if (rows.slice(0, footer).at(-1) === 'No background tasks.') return { remaining: 0, selected: '', kill: false };
  if (start < 0 || start >= footer || !/^\d+ (?:running|completed|failed|paused)(?:, \d+ (?:running|completed|failed|paused))*$/u.test(rows[start + 1] || '')) return null;
  const selected = rows.slice(start + 2, footer).filter(row => /^[>❯›]\s/u.test(row));
  if (selected.length !== 1 || !/Enter (?:output|details)/u.test(rows.slice(footer - 2, footer + 1).join(' '))) return null;
  const remaining = [...rows[start + 1].matchAll(/(\d+) (?:running|paused)/gu)].reduce((sum, match) => sum + Number(match[1]), 0);
  return { remaining, selected: selected[0], kill: /\bk kill\b/u.test(rows.slice(footer - 2, footer + 1).join(' ')) };
}

export async function stopQoderTasks({ read, key, wait }) {
  let previous = null;
  for (let step = 0; step < 80; step++) {
    const panel = qoderTaskPanel(await read());
    if (!panel) throw new Error('Qoder 后台任务面板未就绪；未继续发送停止按键');
    if (!panel.remaining) { await key('Escape', panel); return; }
    if (previous && panel.selected === previous.selected && panel.remaining === previous.remaining && panel.kill === previous.kill) {
      await wait(); continue; // A delayed redraw is not permission to repeat k.
    }
    previous = panel;
    await key(panel.kill ? 'k' : 'Down', panel);
    await wait();
  }
  throw new Error('Qoder 后台任务停止未确认，请在 /tasks 检查仍在运行的任务');
}
