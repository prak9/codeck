// Changing the kernel PTY size wakes a stale TUI layout without sending keys or
// changing tmux's window-size policy. Restore even when capture/cancellation fails.
export async function redrawTerminalPane(paneId, { execTmux, execStty, wait }) {
  const inspect = async () => {
    const result = await execTmux(['display-message', '-p', '-t', paneId,
      '#{pane_id}\t#{pane_tty}\t#{pane_height}\t#{pane_width}']);
    const [id, tty, height, width] = (result?.stdout || '').trim().split('\t');
    if (id !== paneId || !/^\/dev\/pts\/\d+$/.test(tty || '')) return null;
    const rows = Number(height), cols = Number(width);
    return Number.isInteger(rows) && rows > 2 && Number.isInteger(cols) && cols > 0
      ? { tty, rows, cols } : null;
  };
  const size = async tty => (await execStty(['-F', tty, 'size'])).stdout.trim();
  const initial = await inspect();
  if (!initial || await size(initial.tty) !== `${initial.rows} ${initial.cols}`) return false;
  try {
    await execStty(['-F', initial.tty, 'rows', String(initial.rows - 1)]);
    await wait();
  } finally {
    const current = await inspect();
    // A concurrent real resize owns the new grid; never restore over it.
    if (current?.tty === initial.tty
      && await size(initial.tty) === `${initial.rows - 1} ${initial.cols}`) {
      await execStty(['-F', initial.tty, 'rows', String(current.rows)]);
    }
  }
  await wait();
  return true;
}
