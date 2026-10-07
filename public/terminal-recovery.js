// Recover transport/display failures, never a normal tmux detach or auth rejection.
export function bindTerminalRecovery(socket, reconnect, {
  page = document, window = globalThis.window,
  schedule = setTimeout, cancel = clearTimeout,
} = {}) {
  let timer = null, eligible = false, stopped = false;
  const clear = () => {
    if (timer !== null) cancel(timer);
    timer = null;
  };
  const wake = () => {
    if (stopped || !eligible || page.hidden || timer !== null) return;
    timer = schedule(() => {
      timer = null;
      if (stopped || !eligible || page.hidden) return;
      eligible = false;
      reconnect();
    }, 1_000);
  };
  const recover = () => { eligible = true; wake(); };
  const close = event => {
    if (event.code === 1006 || event.code === 4000
      || (event.code === 1011 && event.reason?.startsWith('终端显示同步超时'))) recover();
    else { eligible = false; clear(); }
  };
  socket.addEventListener('close', close);
  page.addEventListener('visibilitychange', wake);
  window.addEventListener('pageshow', wake);
  window.addEventListener('online', wake);
  const stop = () => {
    stopped = true; clear();
    socket.removeEventListener('close', close);
    page.removeEventListener('visibilitychange', wake);
    window.removeEventListener('pageshow', wake);
    window.removeEventListener('online', wake);
  };
  return { recover, stop };
}
