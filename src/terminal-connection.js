import pty from 'node-pty';
import {
  clampViewport,
  getLinkedWindowSessions,
  getSessionSize,
  preferLatestClientSize,
  scrollSession,
  withoutTmuxEnvironment,
} from './tmux.js';

function spawnTerminal(session, size) {
  return pty.spawn('tmux', ['attach-session', '-d', '-t', session], {
    name: 'xterm-256color',
    cols: size.width,
    rows: size.height,
    cwd: process.cwd(),
    env: withoutTmuxEnvironment(process.env),
  });
}

const defaultDependencies = {
  clampViewport,
  createTerminal: spawnTerminal,
  getLinkedWindowSessions,
  getSessionSize,
  preferLatestClientSize,
  scrollSession,
};

export async function handleTerminalConnection(ws, session, viewport, overrides = {}) {
  const dependencies = { ...defaultDependencies, ...overrides };
  let terminal = null;
  let closed = ws.readyState !== ws.OPEN;
  const pending = [];
  const isOpen = () => !closed && ws.readyState === ws.OPEN;
  const killTerminal = () => {
    const attached = terminal;
    terminal = null;
    attached?.kill();
  };

  // Register cancellation before the first await. A closed setup must never reach the
  // side-effectful attach-session -d, where it could evict a newer connection.
  ws.on('close', () => {
    closed = true;
    pending.length = 0;
    killTerminal();
  });

  const handleMessage = (raw) => {
    try {
      const message = JSON.parse(raw.toString());
      if (message.type === 'input' && typeof message.data === 'string') terminal.write(message.data);
      if (message.type === 'resize' && Number.isInteger(message.cols) && Number.isInteger(message.rows)) {
        terminal.resize(...dependencies.clampViewport(message.cols, message.rows));
      }
      if (message.type === 'scroll' && Number.isInteger(message.lines)) {
        dependencies.scrollSession(session, message.lines).catch(() => {});
      }
    } catch { /* Ignore malformed terminal frames. */ }
  };
  ws.on('message', (raw, binary) => {
    if (binary || closed) return;
    if (terminal) handleMessage(raw); else pending.push(raw);
  });

  let initialSize = viewport;
  let linkedSessions;
  try {
    const setup = [dependencies.getLinkedWindowSessions(session)];
    if (!initialSize) setup.push(dependencies.getSessionSize(session));
    const [links, detectedSize] = await Promise.all(setup);
    linkedSessions = links;
    if (detectedSize) initialSize = detectedSize;
    if (!isOpen()) return;
    // A window has one grid even when linked into multiple sessions. Refuse the attach
    // instead of disconnecting unrelated clients or letting their activity resize a phone.
    if (linkedSessions.length) {
      ws.close(1008, '当前窗口被多个 tmux 会话共享，请先取消窗口链接');
      return;
    }
    await dependencies.preferLatestClientSize();
    if (!isOpen()) return;
  } catch (error) {
    if (isOpen()) ws.close(1011, error.message || 'tmux size configuration failed');
    return;
  }

  const [width, height] = dependencies.clampViewport(initialSize.width, initialSize.height);
  const attachSize = { width, height };
  try {
    terminal = dependencies.createTerminal(session, attachSize);
  } catch (error) {
    if (isOpen()) ws.close(1011, error.message || 'tmux attach failed');
    return;
  }
  if (!isOpen()) {
    killTerminal();
    return;
  }

  const attached = terminal;
  attached.onData((data) => isOpen() && ws.send(data));
  attached.onExit(({ exitCode }) => {
    if (terminal === attached) terminal = null;
    if (isOpen()) ws.close(1000, `terminal exited (${exitCode})`);
  });
  // tmux 2.7 has no window-size=latest. Once -d leaves this as the sole client, this
  // explicit SIGWINCH makes the old server adopt the browser's exact dimensions.
  attached.resize(attachSize.width, attachSize.height);
  while (pending.length && terminal === attached) handleMessage(pending.shift());
}
