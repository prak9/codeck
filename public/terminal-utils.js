export const MIN_TERMINAL_COLS = 20;
// tmux supports up to five status lines; keep at least one pane row above them.
export const MIN_TERMINAL_ROWS = 6;
const TERMINAL_WRITE_DISCARD_WATERMARK = 50_000_000;

// tmux 才是会话历史的持有者; xterm 的本地缓冲对全屏 TUI 来说只是一帧帧重绘的残片。
// 所以滚轮要翻的是 tmux 的历史, 不是 xterm 自己的。lines > 0 = 往历史里翻。
const WHEEL_MAX_LINES = 60;

// xterm's built-in DOM renderer is its compatibility fallback and rebuilds DOM rows
// during TUI repaints. Prefer the official GPU renderer when WebGL2 is available, but
// preserve a working terminal on unsupported GPUs and after browser context loss.
export function activateTerminalWebgl(terminal, WebglAddon) {
  if (typeof WebglAddon !== 'function') return false;
  let addon;
  try {
    addon = new WebglAddon();
    addon.onContextLoss(() => addon.dispose());
    terminal.loadAddon(addon);
    return true;
  } catch {
    addon?.dispose?.();
    return false;
  }
}

function wheelRows(event, cellHeight = 20, pageRows = 24) {
  const mode = event?.deltaMode ?? 0;
  const raw = Number(event?.deltaY) || 0;
  return -(mode === 1 ? raw : mode === 2 ? raw * pageRows : raw / Math.max(1, cellHeight));
}

export function wheelScrollLines(event, cellHeight = 20) {
  const lines = Math.trunc(wheelRows(event, cellHeight));
  if (!lines) return 0;
  return Math.max(-WHEEL_MAX_LINES, Math.min(WHEEL_MAX_LINES, lines));
}

// Own wheel events before xterm converts them into arrow/mouse input. Return true even
// for a fraction of a row; letting those events through would send unintended CLI keys.
export function createTerminalWheelScroller(requestScroll, {
  schedule = requestAnimationFrame,
  cancel = cancelAnimationFrame,
} = {}) {
  let remainder = 0;
  let pending = 0;
  let direction = 0;
  let frame = null;

  const clearFrame = () => {
    if (frame !== null) cancel(frame);
    frame = null;
  };
  const flush = () => {
    clearFrame();
    const lines = pending;
    pending = 0;
    if (lines) requestScroll(lines);
  };
  const scroll = (event, cellHeight = 20, pageRows = 24) => {
    if (event?.ctrlKey || event?.metaKey || event?.shiftKey) return false;
    const rows = wheelRows(event, cellHeight, pageRows);
    if (!Number.isFinite(rows) || !rows) return false;
    const nextDirection = Math.sign(rows);
    if (direction && direction !== nextDirection) {
      // tmux ignores down outside copy mode, so down then up must not cancel to zero.
      flush();
      remainder = 0;
    }
    direction = nextDirection;
    remainder += Math.max(-WHEEL_MAX_LINES, Math.min(WHEEL_MAX_LINES, rows));
    const lines = Math.trunc(remainder);
    remainder -= lines;
    // Match the server's per-session scroll queue limit for unusually large bursts.
    pending = Math.max(-500, Math.min(500, pending + lines));
    if (pending && frame === null) {
      const scheduled = schedule(() => {
        if (frame !== scheduled) return;
        frame = null;
        flush();
      });
      frame = scheduled;
    }
    return true;
  };
  const reset = () => {
    clearFrame();
    remainder = pending = direction = 0;
  };
  return { scroll, cancel: reset };
}

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

// xterm's write callback means a chunk has left its parser queue. Coalesce those
// acknowledgements so flow control costs at most one tiny upstream frame per display
// frame, while a large repaint releases the server immediately after it is parsed.
export function createTerminalOutputAcknowledger(send, flowId, {
  maxDelayMs = 16,
  immediateChars = 64 * 1024,
  schedule = setTimeout,
  cancel = clearTimeout,
} = {}) {
  let pendingChars = 0;
  let timer = null;
  let stopped = false;

  const clearTimer = () => {
    if (timer !== null) cancel(timer);
    timer = null;
  };
  const flush = () => {
    clearTimer();
    if (stopped || !pendingChars) return false;
    const chars = pendingChars;
    pendingChars = 0;
    try { return send({ type: 'outputAck', flowId, chars }) !== false; }
    catch { stopped = true; return false; }
  };
  const acknowledge = (chars) => {
    if (stopped || !Number.isSafeInteger(chars) || chars <= 0) return false;
    pendingChars = Math.min(Number.MAX_SAFE_INTEGER, pendingChars + chars);
    if (pendingChars >= immediateChars) return flush();
    if (timer === null) {
      const scheduled = schedule(() => {
        if (timer !== scheduled) return;
        timer = null;
        flush();
      }, maxDelayMs);
      timer = scheduled;
    }
    return true;
  };
  const stop = () => {
    stopped = true;
    pendingChars = 0;
    clearTimer();
  };

  return { acknowledge, flush, cancel: stop };
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

const terminalFitCache = new WeakMap();

export function fitTerminalGrid(terminal, fit, { baseFontSize, overviewSize = null, layout = null }) {
  // The caller supplies actual container dimensions, DPR and a revision incremented on
  // font loading. Without that evidence, keep measuring as before. Cache one result per
  // terminal; external font/grid changes or a replacement FitAddon also invalidate it.
  // WebGL context loss can switch to DOM cells with different fractional dimensions.
  const cell = terminal._core?._renderService?.dimensions?.css?.cell;
  const cacheable = layout && [layout.width, layout.height, layout.dpr].every((value) => Number.isFinite(value) && value > 0)
    && Number.isSafeInteger(layout.fontRevision) && layout.fontRevision >= 0;
  const key = cacheable ? JSON.stringify([
    layout.width, layout.height, layout.dpr, layout.fontRevision,
    baseFontSize, overviewSize?.cols, overviewSize?.rows,
    terminal.options.fontFamily, terminal.options.fontWeight, terminal.options.fontWeightBold,
    terminal.options.lineHeight, terminal.options.letterSpacing, terminal.options.scrollback,
  ]) : null;
  const cached = terminalFitCache.get(terminal);
  if (key && cached?.key === key && cached.fit === fit && cached.fontSize === terminal.options.fontSize
    && cached.cellWidth === cell?.width && cached.cellHeight === cell?.height
    && cached.result.cols === terminal.cols && cached.result.rows === terminal.rows) return { ...cached.result };
  terminalFitCache.delete(terminal);

  // Measure while searching for a font size; never resize. Each terminal.resize() rewraps
  // the buffer, and rewrapping is lossy — widen then narrow back and the original line
  // breaks are gone. The search ran fit.fit() up to five times, so it could land back on
  // the grid the server already had: the resize gate then sent nothing, tmux never
  // repainted, and the rewrap damage stayed on screen. Toggling the input bar in overview
  // mode does exactly that, because there the fit moves the font size, not the grid.
  let measured = true;
  const measure = () => {
    const proposed = fit.proposeDimensions?.();
    if (Number.isFinite(proposed?.cols) && Number.isFinite(proposed?.rows)) return proposed;
    measured = false;
    return { cols: terminal.cols, rows: terminal.rows };
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
  // FitAddon 的 fit() 会在 resize 前清一次渲染缓存, 不走它就少了那一步; 而全览模式下
  // 变的是字号、网格不动, 那条路径上连 resize 都没有, 屏幕不会自己跟上。统一重绘一次。
  terminal.refresh?.(0, Math.max(0, terminal.rows - 1));
  const result = { ...viewport, overview };
  if (key && measured) terminalFitCache.set(terminal, {
    key, fit, fontSize: terminal.options.fontSize, result,
    cellWidth: cell?.width, cellHeight: cell?.height,
  });
  return result;
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
