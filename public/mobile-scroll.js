export function bindMobileScroll(container, terminal, requestScroll, options = {}) {
  const isMobile = options.isMobile || (() => matchMedia('(max-width: 720px), (max-width: 932px) and (orientation: landscape)').matches);
  const getViewportScale = options.getViewportScale || (() => globalThis.visualViewport?.scale ?? 1);
  const log = options.log || (() => {});
  const longPressMs = options.longPressMs ?? 450;
  const isMac = ['Macintosh', 'MacIntel', 'MacPPC', 'Mac68K'].includes(globalThis.navigator?.platform);
  const TOUCH_DEADZONE_PX = 12;
  let pressTimer = 0;
  let selecting = false;
  const sendMouse = (type, target, x, y, modifiers = {}) => target?.dispatchEvent(new MouseEvent(type, {
    bubbles: true, cancelable: true, view: window, button: 0, buttons: type === 'mouseup' ? 0 : 1, detail: 1, clientX: x, clientY: y,
    ...modifiers,
  }));
  const beginSelection = (x, y) => {
    selecting = true;
    terminal.clearSelection?.();
    const target = container.querySelector('.xterm');
    log(`long-press fired, target=${target ? '.xterm' : 'MISSING'} mobile=${isMobile()}`);
    const tracking = terminal.modes?.mouseTrackingMode && terminal.modes.mouseTrackingMode !== 'none';
    const macOption = terminal.options.macOptionClickForcesSelection;
    // xterm forces local selection with Shift, or Option on Mac. Scope the Mac
    // option to this event, and never put Alt on mouseup (it can move the CLI cursor).
    if (tracking && isMac) terminal.options.macOptionClickForcesSelection = true;
    try {
      sendMouse('mousedown', target, x, y, { shiftKey: tracking && !isMac, altKey: tracking && isMac });
    } finally {
      if (tracking && isMac) terminal.options.macOptionClickForcesSelection = macOption;
    }
    log(`after mousedown hasSelection=${terminal.hasSelection()}`);
  };
  const endSelection = (x, y) => {
    if (!selecting) return;
    selecting = false;
    sendMouse('mouseup', document, x, y);
    log(`mouseup -> selection=${JSON.stringify((terminal.getSelection() || '').slice(0, 24))}`);
  };
  let lastX = 0;
  let lastY = null;
  let startX = 0;
  let startY = 0;
  let carriedPixels = 0;
  let travelled = 0;
  let pendingRows = 0;
  let flushHandle = 0;
  const flush = () => {
    flushHandle = 0;
    const rows = pendingRows;
    pendingRows = 0;
    if (rows) requestScroll(rows);
  };
  const rowHeight = () => {
    const screen = container.querySelector('.xterm-screen');
    const height = screen?.clientHeight / (terminal.rows || 1);
    return height > 0 ? height : terminal.options.fontSize * 1.2;
  };
  const finishTouch = (type) => {
    clearTimeout(pressTimer);
    log(`${type} selecting=${selecting} travelled=${Math.round(travelled)}`);
    endSelection(lastX, lastY);
    lastY = null;
  };

  container.addEventListener('mousedown', (event) => {
    if (isMobile() && event.isTrusted) event.stopPropagation();
  }, { capture: true });
  container.addEventListener('touchstart', (event) => {
    clearTimeout(pressTimer);
    endSelection(lastX, lastY);
    if (!isMobile() || event.touches.length !== 1) { lastY = null; return; }
    lastX = startX = event.touches[0].clientX;
    lastY = startY = event.touches[0].clientY;
    carriedPixels = 0;
    travelled = 0;
    pressTimer = setTimeout(() => beginSelection(startX, startY), longPressMs);
    log(`touchstart @${Math.round(startX)},${Math.round(startY)}`);
  }, { capture: true, passive: true });
  container.addEventListener('touchmove', (event) => {
    if (lastY === null || event.touches.length !== 1) return;
    const currentX = event.touches[0].clientX;
    const currentY = event.touches[0].clientY;
    if (selecting) {
      lastX = currentX;
      lastY = currentY;
      sendMouse('mousemove', document, currentX, currentY);
      log(`selecting move -> len=${(terminal.getSelection() || '').length}`);
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (getViewportScale() > 1.01) {
      clearTimeout(pressTimer);
      lastX = currentX;
      lastY = currentY;
      return;
    }
    const step = currentY - lastY;
    lastX = currentX;
    lastY = currentY;
    travelled += Math.abs(step);
    if (Math.hypot(currentX - startX, currentY - startY) >= TOUCH_DEADZONE_PX) clearTimeout(pressTimer);
    if (travelled < TOUCH_DEADZONE_PX) return;
    carriedPixels += step;
    const rows = Math.trunc(carriedPixels / rowHeight());
    if (rows !== 0) {
      carriedPixels -= rows * rowHeight();
      pendingRows += rows;
      if (!flushHandle) flushHandle = requestAnimationFrame(flush);
    }
    event.preventDefault();
    event.stopPropagation();
  }, { capture: true, passive: false });
  for (const type of ['touchend', 'touchcancel']) {
    container.addEventListener(type, () => finishTouch(type), { capture: true, passive: true });
  }

  return () => {
    clearTimeout(pressTimer);
    if (flushHandle) cancelAnimationFrame(flushHandle);
    flushHandle = 0;
    pendingRows = 0;
    endSelection(lastX, lastY);
    lastY = null;
  };
}
