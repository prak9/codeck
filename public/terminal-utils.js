export const MIN_TERMINAL_COLS = 20;
// tmux supports up to five status lines; keep at least one pane row above them.
export const MIN_TERMINAL_ROWS = 6;
const TERMINAL_WRITE_DISCARD_WATERMARK = 50_000_000;

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

// A terminal focus or resize forces xterm to repaint, which can hide a missed render
// after the input buffer was already parsed. Keep the healthy path untouched and only
// redraw when parsed output produces no render event by the deadline.
export function bindTerminalRenderWatchdog(terminal, {
  delayMs = 80,
  schedule = setTimeout,
  cancel = clearTimeout,
  isVisible = () => true,
} = {}) {
  let timer = null;
  let timerVersion = 0;
  let pendingRender = false;
  let disposed = false;

  const cancelPending = () => {
    if (timer !== null) cancel(timer);
    timer = null;
    timerVersion += 1;
  };
  const parsed = terminal.onWriteParsed(() => {
    pendingRender = true;
    if (timer !== null) return;
    const version = ++timerVersion;
    timer = schedule(() => {
      if (disposed || version !== timerVersion) return;
      timer = null;
      if (!pendingRender || !isVisible()) return;
      pendingRender = false;
      if (terminal.rows > 0) terminal.refresh(0, terminal.rows - 1);
    }, delayMs);
  });
  const rendered = terminal.onRender(() => {
    pendingRender = false;
    cancelPending();
  });

  return () => {
    disposed = true;
    cancelPending();
    parsed.dispose?.();
    rendered.dispose?.();
  };
}

export function createTerminalRevealGate(onReveal, {
  settleMs = 80,
  maxWaitMs = 240,
  schedule = setTimeout,
  cancel = clearTimeout,
} = {}) {
  let settleTimer = null;
  let maxWaitTimer = null;
  let settleVersion = 0;
  let finished = false;

  const clearTimers = () => {
    if (settleTimer !== null) cancel(settleTimer);
    if (maxWaitTimer !== null) cancel(maxWaitTimer);
    settleTimer = null;
    maxWaitTimer = null;
  };
  const finish = () => {
    if (finished) return;
    finished = true;
    settleVersion += 1;
    clearTimers();
    onReveal();
  };
  const parsed = () => {
    if (finished) return;
    const version = ++settleVersion;
    if (settleTimer !== null) cancel(settleTimer);
    settleTimer = schedule(() => {
      if (version === settleVersion) finish();
    }, settleMs);
    if (maxWaitTimer === null) maxWaitTimer = schedule(finish, maxWaitMs);
  };
  const dispose = () => {
    if (finished) return;
    finished = true;
    settleVersion += 1;
    clearTimers();
  };

  return { parsed, cancel: dispose };
}

// xterm's internal write buffer cannot be cleared. Keep only one session chunk in that
// buffer at a time so a session switch can discard every older chunk still waiting here.
export function createTerminalWriteQueue(terminal) {
  let first = null;
  let last = null;
  let pendingBytes = 0;
  let writing = false;
  let cancelled = false;

  const drain = () => {
    if (cancelled || writing) return;
    const entry = first;
    if (!entry) return;
    first = entry.next;
    entry.next = null;
    if (!first) last = null;
    writing = true;
    terminal.write(entry.data, () => {
      writing = false;
      if (cancelled) return;
      pendingBytes -= entry.size;
      try {
        entry.callback?.();
      } finally {
        drain();
      }
    });
  };

  const write = (data, callback) => {
    if (cancelled) return false;
    if (pendingBytes > TERMINAL_WRITE_DISCARD_WATERMARK) {
      throw new Error('write data discarded, use flow control to avoid losing data');
    }
    const entry = { data, callback, size: data.length, next: null };
    pendingBytes += entry.size;
    if (last) last.next = entry;
    else first = entry;
    last = entry;
    drain();
    return true;
  };

  const cancel = () => {
    cancelled = true;
    first = null;
    last = null;
    pendingBytes = 0;
  };

  return { write, cancel };
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
// parsed after those writes, then clear() drops the previous session's scrollback before
// the next queued terminal frame is parsed.
export function resetTerminalInput(terminal) {
  return new Promise((resolve) => terminal.write('\x1bc', () => {
    terminal.clear();
    resolve();
  }));
}
