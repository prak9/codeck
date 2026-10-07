// Application-level probes work in browsers and keep idle proxy connections alive.
// They never enter the PTY, replay input, or take ownership of another client's pane.
export function bindTerminalHeartbeat(socket, onTimeout, {
  page = document, window = globalThis.window,
  schedule = setTimeout, cancel = clearTimeout,
  intervalMs = 15_000, timeoutMs = 10_000,
  textFrames = false,
} = {}) {
  let timer = null, pending = null, sequence = 0, stopped = false;
  const clear = () => {
    if (timer !== null) cancel(timer);
    timer = null;
  };
  const arm = () => {
    clear();
    if (!stopped && !page.hidden && socket.readyState === 1) timer = schedule(probe, intervalMs);
  };
  const fail = () => { stop(); onTimeout(); };
  const probe = () => {
    clear();
    if (stopped || page.hidden || socket.readyState !== 1) return;
    pending = ++sequence;
    try { socket.send(JSON.stringify({ type: 'ping', id: pending })); }
    catch { fail(); return; }
    timer = schedule(() => {
      if (page.hidden) { clear(); pending = null; return; }
      fail();
    }, timeoutMs);
  };
  const receive = event => {
    if (textFrames ? typeof event.data !== 'string' : !(event.data instanceof ArrayBuffer)) return;
    let message;
    try { message = JSON.parse(textFrames ? event.data : new TextDecoder().decode(event.data)); } catch { return; }
    if (message.type !== 'pong' || message.id !== pending) return;
    pending = null;
    arm();
  };
  const visibility = () => {
    clear(); pending = null;
    if (!page.hidden) probe();
  };
  const wake = () => { if (pending === null) probe(); };
  const stop = () => {
    stopped = true; clear(); pending = null;
    socket.removeEventListener('open', arm);
    socket.removeEventListener('message', receive);
    socket.removeEventListener('close', stop);
    page.removeEventListener('visibilitychange', visibility);
    window.removeEventListener('focus', wake);
    window.removeEventListener('online', wake);
    window.removeEventListener('pageshow', visibility);
  };
  socket.addEventListener('open', arm);
  socket.addEventListener('message', receive);
  socket.addEventListener('close', stop);
  page.addEventListener('visibilitychange', visibility);
  window.addEventListener('focus', wake);
  window.addEventListener('online', wake);
  window.addEventListener('pageshow', visibility);
  arm();
  return stop;
}
