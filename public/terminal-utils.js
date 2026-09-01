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
  settleMs = 120,
  maxWaitMs = 500,
  schedule = setTimeout,
  cancel = clearTimeout,
  isVisible = () => true,
} = {}) {
  let settleTimer = null;
  let maxWaitTimer = null;
  let pendingRender = false;
  let forcedSinceRender = false;
  let disposed = false;

  const clearTimers = () => {
    if (settleTimer !== null) cancel(settleTimer);
    if (maxWaitTimer !== null) cancel(maxWaitTimer);
    settleTimer = null;
    maxWaitTimer = null;
  };
  const forceRender = () => {
    if (disposed || forcedSinceRender || !pendingRender) return;
    clearTimers();
    pendingRender = false;
    if (!isVisible() || terminal.rows <= 0) return;
    // One forced redraw is enough to wake a renderer that missed its frame. Repeating
    // full-viewport refreshes while ANSI output is still arriving creates visible
    // flashes and cannot repair a renderer that did not react to the first refresh.
    forcedSinceRender = true;
    terminal.refresh(0, terminal.rows - 1);
  };
  const parsed = terminal.onWriteParsed(() => {
    pendingRender = true;
    if (forcedSinceRender) return;
    if (settleTimer !== null) cancel(settleTimer);
    const settle = schedule(() => {
      if (settleTimer !== settle) return;
      settleTimer = null;
      forceRender();
    }, settleMs);
    settleTimer = settle;
    if (maxWaitTimer === null) {
      const maximum = schedule(() => {
        if (maxWaitTimer !== maximum) return;
        maxWaitTimer = null;
        forceRender();
      }, maxWaitMs);
      maxWaitTimer = maximum;
    }
  });
  const rendered = terminal.onRender(() => {
    pendingRender = false;
    forcedSinceRender = false;
    clearTimers();
  });

  return () => {
    disposed = true;
    clearTimers();
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
  let queuedData = '';
  let queuedSize = 0;
  let queuedCallbacks = [];
  let pendingBytes = 0;
  let writing = false;
  let cancelled = false;

  const start = (data, size, callbacks) => {
    if (cancelled) return;
    writing = true;
    terminal.write(data, () => {
      writing = false;
      if (cancelled) return;
      pendingBytes -= size;
      try {
        for (const callback of callbacks) callback?.();
      } finally {
        drain();
      }
    });
  };

  const drain = () => {
    if (cancelled || writing || !queuedSize) return;
    const data = queuedData;
    const size = queuedSize;
    const callbacks = queuedCallbacks;
    queuedData = '';
    queuedSize = 0;
    queuedCallbacks = [];
    start(data, size, callbacks);
  };

  const write = (data, callback) => {
    if (cancelled) return false;
    if (pendingBytes > TERMINAL_WRITE_DISCARD_WATERMARK) {
      throw new Error('write data discarded, use flow control to avoid losing data');
    }
    const size = data.length;
    pendingBytes += size;
    if (!writing && !queuedSize) start(data, size, [callback]);
    else {
      queuedData += data;
      queuedSize += size;
      queuedCallbacks.push(callback);
    }
    return true;
  };

  const cancel = () => {
    cancelled = true;
    queuedData = '';
    queuedSize = 0;
    queuedCallbacks = [];
    pendingBytes = 0;
  };

  return { write, cancel };
}

export function createTerminalResizeGate(sendResize) {
  let lastGrid = '';
  const gridKey = (cols, rows) => `${cols}x${rows}`;
  const mark = (cols, rows) => {
    lastGrid = gridKey(cols, rows);
  };
  const send = (cols, rows) => {
    const nextGrid = gridKey(cols, rows);
    if (nextGrid === lastGrid) return false;
    if (sendResize(cols, rows) === false) return false;
    lastGrid = nextGrid;
    return true;
  };
  return { mark, send };
}

export function fitTerminalGrid(terminal, fit, { baseFontSize, overviewSize = null }) {
  // Measure while searching for a font size; never resize. Each terminal.resize() rewraps
  // the buffer, and rewrapping is lossy — widen then narrow back and the original line
  // breaks are gone. The search ran fit.fit() up to five times, so it could land back on
  // the grid the server already had: the resize gate then sent nothing, tmux never
  // repainted, and the rewrap damage stayed on screen. Toggling the input bar in overview
  // mode does exactly that, because there the fit moves the font size, not the grid.
  const measure = () => {
    const proposed = fit.proposeDimensions?.();
    return Number.isFinite(proposed?.cols) && Number.isFinite(proposed?.rows)
      ? proposed
      : { cols: terminal.cols, rows: terminal.rows };
  };
  terminal.options.fontSize = baseFontSize;
  let available = measure();
  const readableTarget = clampTerminalGrid(available.cols, available.rows);
  let overview = Boolean(overviewSize);
  let target = overview ? clampTerminalGrid(overviewSize.cols, overviewSize.rows) : readableTarget;
  const fitsTarget = () => available.cols >= target.cols && available.rows >= target.rows;
  const shrinkToFit = () => {
    for (let attempt = 0; attempt < 4 && !fitsTarget(); attempt += 1) {
      const ratio = Math.min(available.cols / target.cols, available.rows / target.rows, 1);
      const nextFontSize = Math.max(1, Math.floor(terminal.options.fontSize * ratio * 9.7) / 10);
      if (nextFontSize === terminal.options.fontSize) break;
      terminal.options.fontSize = nextFontSize;
      available = measure();
    }
  };

  shrinkToFit();
  if (!fitsTarget() && overview) {
    // A pane taller than the 1px font limit cannot be shown as an overview. Preserve the
    // readable grid instead of feeding every newly available column back into tmux.
    overview = false;
    target = readableTarget;
    terminal.options.fontSize = baseFontSize;
    available = measure();
    shrinkToFit();
  }
  const viewport = fitsTarget() ? target : clampTerminalGrid(available.cols, available.rows);
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
