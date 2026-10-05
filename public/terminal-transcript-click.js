// Preserve browser drag-selection and links; native disclosure only needs a click.
export function bindTranscriptClick(element, terminal, send) {
  let down;
  element.addEventListener('pointerdown', event => {
    down = event.button === 0 ? { x: event.clientX, y: event.clientY, at: Date.now() } : null;
  });
  element.addEventListener('click', event => {
    const start = down;
    down = null;
    if (!start || Date.now() - start.at > 500 || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4
      || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || terminal.hasSelection()
      || event.target.closest('a') || (terminal.modes?.mouseTrackingMode && terminal.modes.mouseTrackingMode !== 'none')) return;
    const screen = element.querySelector('.xterm-screen');
    const rect = screen?.getBoundingClientRect();
    if (!rect?.width || !rect.height) return;
    const column = Math.floor((event.clientX - rect.left) * terminal.cols / rect.width) + 1;
    const row = Math.floor((event.clientY - rect.top) * terminal.rows / rect.height) + 1;
    if (column >= 1 && column <= terminal.cols && row >= 1 && row <= terminal.rows) send({ column, row });
  });
}
