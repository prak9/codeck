import pty from 'node-pty';
import {
  clampViewport,
  getLinkedWindowSessions,
  getSessionSize,
  preferLatestClientSize,
  scrollSession,
  validateSessionName,
  withoutTmuxEnvironment,
} from './tmux.js';

export function terminalAttachArgs(session, { readOnly = false, detachOtherClients = true } = {}) {
  const accessArgs = readOnly ? ['-r'] : detachOtherClients ? ['-d'] : [];
  return ['attach-session', ...accessArgs, '-t', session];
}

function spawnTerminal(session, size, options) {
  return pty.spawn('tmux', terminalAttachArgs(session, options), {
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
  validateSessionName,
};

// node-pty can split one tmux repaint across adjacent data callbacks. Sending each
// fragment as a WebSocket message lets xterm render a half-written screen between them.
// A tiny bounded window joins those fragments while keeping terminal-query latency below
// one display frame; a session switch can also discard the pending old frame.
export function createTerminalOutputBatcher(send, {
  settleMs = 2,
  maxWaitMs = 8,
  schedule = setTimeout,
  cancel = clearTimeout,
} = {}) {
  let pending = '';
  let settleTimer = null;
  let maxWaitTimer = null;
  let stopped = false;

  const clearTimers = () => {
    if (settleTimer !== null) cancel(settleTimer);
    if (maxWaitTimer !== null) cancel(maxWaitTimer);
    settleTimer = null;
    maxWaitTimer = null;
  };
  const flush = () => {
    clearTimers();
    if (stopped || !pending) return;
    const output = pending;
    pending = '';
    send(output);
  };
  const write = (data) => {
    if (stopped || !data) return false;
    pending += data;
    if (settleTimer !== null) cancel(settleTimer);
    const settle = schedule(() => {
      if (settleTimer !== settle) return;
      settleTimer = null;
      flush();
    }, settleMs);
    settleTimer = settle;
    if (maxWaitTimer === null) {
      const maximum = schedule(() => {
        if (maxWaitTimer !== maximum) return;
        maxWaitTimer = null;
        flush();
      }, maxWaitMs);
      maxWaitTimer = maximum;
    }
    return true;
  };
  const stop = () => {
    stopped = true;
    pending = '';
    clearTimers();
  };

  return { write, cancel: stop };
}

export async function handleTerminalConnection(ws, session, viewport, overrides = {}) {
  const {
    readOnly = false,
    detachOtherClients = true,
    canSwitchSession = false,
    ...dependencyOverrides
  } = overrides;
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  let activeSession = session;
  let terminal = null;
  let terminalOutput = null;
  let terminalGrid = '';
  let closed = ws.readyState !== ws.OPEN;
  let attachSequence = 0;
  let awaitingSessionActivity = false;
  const pending = [];
  const isOpen = () => !closed && ws.readyState === ws.OPEN;
  const killTerminal = () => {
    const attached = terminal;
    terminal = null;
    terminalOutput?.cancel();
    terminalOutput = null;
    terminalGrid = '';
    attached?.kill();
  };

  // Register cancellation before the first await. A closed setup must never reach the
  // side-effectful attach-session, where an exclusive owner attach could evict a newer connection.
  ws.on('close', () => {
    closed = true;
    attachSequence += 1;
    pending.length = 0;
    killTerminal();
  });

  const handleMessage = (raw) => {
    try {
      const message = JSON.parse(raw.toString());
      if (message.type === 'switch') {
        if (!canSwitchSession) {
          ws.close(1008, '当前凭据不能切换 tmux 会话');
          return;
        }
        if (!dependencies.validateSessionName(message.session)
          || !Number.isInteger(message.cols) || !Number.isInteger(message.rows)) {
          ws.close(1008, '无效的 tmux 会话切换请求');
          return;
        }
        pending.length = 0;
        awaitingSessionActivity = false;
        const [width, height] = dependencies.clampViewport(message.cols, message.rows);
        attachTerminal(message.session, { width, height }, true).catch((error) => {
          if (isOpen()) ws.close(1011, error.message || 'tmux session switch failed');
        });
        return;
      }
      if (!terminal) {
        pending.push(raw);
        return;
      }
      if (!readOnly && message.type === 'input' && typeof message.data === 'string') {
        terminal.write(message.data);
        if (/[\r\n]/.test(message.data)) awaitingSessionActivity = true;
      }
      if (message.type === 'resize' && Number.isInteger(message.cols) && Number.isInteger(message.rows)) {
        const [cols, rows] = dependencies.clampViewport(message.cols, message.rows);
        const nextGrid = `${cols}x${rows}`;
        if (nextGrid !== terminalGrid) {
          terminalGrid = nextGrid;
          terminal.resize(cols, rows);
        }
      }
      if (message.type === 'scroll' && Number.isInteger(message.lines)) {
        dependencies.scrollSession(activeSession, message.lines).catch(() => {});
      }
    } catch { /* Ignore malformed terminal frames. */ }
  };
  ws.on('message', (raw, binary) => {
    if (binary || closed) return;
    handleMessage(raw);
  });

  async function attachTerminal(nextSession, nextViewport, resetScreen = false) {
    const sequence = ++attachSequence;
    activeSession = nextSession;
    killTerminal();
    let initialSize = nextViewport;
    let usesLatestClientSize = false;
    try {
      const setup = [dependencies.getLinkedWindowSessions(nextSession)];
      if (!initialSize) setup.push(dependencies.getSessionSize(nextSession));
      const [linkedSessions, detectedSize] = await Promise.all(setup);
      if (detectedSize) initialSize = detectedSize;
      if (!isOpen() || sequence !== attachSequence) return;
      // A window has one grid even when linked into multiple sessions. Refuse the attach
      // instead of disconnecting unrelated clients or letting their activity resize a phone.
      if (linkedSessions.length) {
        ws.close(1008, '当前窗口被多个 tmux 会话共享，请先取消窗口链接');
        return;
      }
      usesLatestClientSize = await dependencies.preferLatestClientSize();
      if (!isOpen() || sequence !== attachSequence) return;
    } catch (error) {
      if (isOpen() && sequence === attachSequence) ws.close(1011, error.message || 'tmux size configuration failed');
      return;
    }

    const [width, height] = dependencies.clampViewport(initialSize.width, initialSize.height);
    const attachSize = { width, height };
    let attached;
    try {
      attached = dependencies.createTerminal(nextSession, attachSize, {
        readOnly,
        ...(detachOtherClients === false ? { detachOtherClients: false } : {}),
      });
    } catch (error) {
      if (isOpen() && sequence === attachSequence) ws.close(1011, error.message || 'tmux attach failed');
      return;
    }
    if (!isOpen() || sequence !== attachSequence) {
      attached.kill();
      return;
    }

    terminal = attached;
    terminalGrid = `${attachSize.width}x${attachSize.height}`;
    terminalOutput = createTerminalOutputBatcher((data) => {
      if (terminal === attached && isOpen()) ws.send(data);
    });
    if (resetScreen) ws.send('\x1bc');
    attached.onData((data) => {
      if (terminal !== attached || !isOpen()) return;
      terminalOutput.write(data);
      if (!awaitingSessionActivity) return;
      awaitingSessionActivity = false;
      try { dependencies.onSessionActivity?.(activeSession); }
      catch { /* Session snapshots retain their periodic fallback. */ }
    });
    attached.onExit(({ exitCode }) => {
      if (terminal !== attached) return;
      terminalOutput?.cancel();
      terminalOutput = null;
      terminal = null;
      terminalGrid = '';
      if (isOpen()) ws.close(1000, `terminal exited (${exitCode})`);
    });
    // Modern tmux receives the exact pty dimensions at spawn and follows the newest
    // client. Older servers need one explicit SIGWINCH after attaching.
    if (!usesLatestClientSize) attached.resize(attachSize.width, attachSize.height);
    while (pending.length && terminal === attached) handleMessage(pending.shift());
  }

  await attachTerminal(session, viewport);
}
