export const MIN_TERMINAL_COLS = 20;
// tmux supports up to five status lines; keep at least one pane row above them.
export const MIN_TERMINAL_ROWS = 6;

export function clampTerminalGrid(cols, rows) {
  return {
    cols: Math.max(MIN_TERMINAL_COLS, cols),
    rows: Math.max(MIN_TERMINAL_ROWS, rows),
  };
}

export function isTerminalCopyShortcut(event, hasSelection) {
  if (!hasSelection || event?.type !== 'keydown' || event.altKey) return false;
  const copyKey = event.code === 'KeyC' || String(event.key || '').toLowerCase() === 'c';
  return copyKey && Boolean(event.ctrlKey || event.metaKey);
}

export function fitTerminalGrid(terminal, fit, { baseFontSize, overviewSize = null }) {
  terminal.options.fontSize = baseFontSize;
  fit.fit();
  const readableTarget = clampTerminalGrid(terminal.cols, terminal.rows);
  let overview = Boolean(overviewSize);
  let target = overview ? clampTerminalGrid(overviewSize.cols, overviewSize.rows) : readableTarget;
  const fitsTarget = () => terminal.cols >= target.cols && terminal.rows >= target.rows;
  const shrinkToFit = () => {
    for (let attempt = 0; attempt < 4 && !fitsTarget(); attempt += 1) {
      const ratio = Math.min(terminal.cols / target.cols, terminal.rows / target.rows, 1);
      const nextFontSize = Math.max(1, Math.floor(terminal.options.fontSize * ratio * 9.7) / 10);
      if (nextFontSize === terminal.options.fontSize) break;
      terminal.options.fontSize = nextFontSize;
      fit.fit();
    }
  };

  shrinkToFit();
  if (!fitsTarget() && overview) {
    // A pane taller than the 1px font limit cannot be shown as an overview. Preserve the
    // readable grid instead of feeding every newly available column back into tmux.
    overview = false;
    target = readableTarget;
    terminal.options.fontSize = baseFontSize;
    fit.fit();
    shrinkToFit();
  }
  const viewport = fitsTarget() ? target : clampTerminalGrid(terminal.cols, terminal.rows);
  if (viewport.cols !== terminal.cols || viewport.rows !== terminal.rows) terminal.resize(viewport.cols, viewport.rows);
  return { ...viewport, overview };
}

// xterm's synchronous reset() leaves already queued writes alive. An in-band RIS is
// parsed after those writes, so the next connection starts from a clean terminal state.
export function resetTerminalInput(terminal) {
  return new Promise((resolve) => terminal.write('\x1bc', resolve));
}
