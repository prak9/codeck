import pty from 'node-pty';
import {
  clampViewport,
  getLinkedWindowSessions,
  getSessionSize,
  preferLatestClientSize,
  scrollSession,
  submitTerminalInput,
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
  submitTerminalInput,
  validateSessionName,
};

const TERMINAL_OUTPUT_HIGH_WATERMARK = 256 * 1024;

function validOutputFlowId(value) {
  return typeof value === 'string' && /^[1-9]\d{0,15}$/.test(value);
}

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

  return { write, flush, cancel: stop };
}

export async function handleTerminalConnection(ws, session, viewport, overrides = {}) {
  const {
    readOnly = false,
    detachOtherClients = true,
    canSwitchSession = false,
    outputFlowControl = false,
    outputFlowId = null,
    outputHighWaterMark = TERMINAL_OUTPUT_HIGH_WATERMARK,
    ...dependencyOverrides
  } = overrides;
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  const flowControlEnabled = outputFlowControl && validOutputFlowId(outputFlowId);
  const highWaterMark = Number.isFinite(outputHighWaterMark)
    ? Math.max(1, Math.floor(outputHighWaterMark))
    : TERMINAL_OUTPUT_HIGH_WATERMARK;
  let activeSession = session;
  let activeViewport = viewport;
  let activeFlowId = flowControlEnabled ? outputFlowId : null;
  let terminal = null;
  let terminalOutput = null;
  let terminalGrid = '';
  let unacknowledgedOutput = 0;
  let resyncPending = false;
  let closed = ws.readyState !== ws.OPEN;
  let attachSequence = 0;
  let awaitingSessionActivity = false;
  let inputGeneration = 0;
  let inputOperation = null;
  let pendingScroll = Promise.resolve();
  const pending = [];
  const isOpen = () => !closed && ws.readyState === ws.OPEN;
  const sendInputResult = (message, error) => {
    if (!isOpen()) return;
    if (typeof message.inputId !== 'string' || !message.inputId.length || message.inputId.length > 128) {
      if (error) ws.close(1011, '终端输入未发送，请重新连接后检查草稿');
      return;
    }
    // Terminal output remains text. Only opted-in submission clients receive these
    // binary acknowledgements, so old xterm clients never render protocol JSON.
    ws.send(Buffer.from(JSON.stringify({
      type: 'inputResult', inputId: message.inputId, ok: !error,
      ...(error ? { error: error.message || '终端输入未发送' } : {}),
    })));
  };
  const drainPending = () => {
    while (pending.length && terminal && !inputOperation && isOpen()) handleMessage(pending.shift());
  };
  const submitInput = (message) => {
    const generation = inputGeneration;
    const targetSession = activeSession;
    const operation = {};
    inputOperation = operation;
    const isCurrent = () => isOpen() && generation === inputGeneration;
    pendingScroll.then(async () => {
      if (!isCurrent()) throw new Error('终端连接或会话已切换，输入未发送');
      if (/[\r\n]/.test(message.data)) awaitingSessionActivity = true;
      await dependencies.submitTerminalInput(targetSession, message.data, { isCurrent });
    }).then(() => sendInputResult(message), (error) => sendInputResult(message, error)).finally(() => {
      if (inputOperation !== operation) return;
      inputOperation = null;
      drainPending();
    });
  };
  const killTerminal = () => {
    const attached = terminal;
    terminal = null;
    terminalOutput?.cancel();
    terminalOutput = null;
    terminalGrid = '';
    attached?.kill();
  };
  const reattachAfterDrain = () => {
    if (!resyncPending || unacknowledgedOutput || !isOpen()) return;
    resyncPending = false;
    attachTerminal(activeSession, activeViewport, true).catch((error) => {
      if (isOpen()) ws.close(1011, error.message || 'tmux resynchronization failed');
    });
  };
  const acknowledgeOutput = (message) => {
    if (!flowControlEnabled || message.flowId !== activeFlowId
      || !Number.isSafeInteger(message.chars) || message.chars <= 0) return;
    unacknowledgedOutput = Math.max(0, unacknowledgedOutput - message.chars);
    reattachAfterDrain();
  };
  const sendOutput = (data, attached) => {
    if (!data || terminal !== attached || !isOpen()) return false;
    ws.send(data);
    if (!flowControlEnabled) return true;
    unacknowledgedOutput += data.length;
    if (unacknowledgedOutput > highWaterMark && !resyncPending) {
      // Do not let an output-heavy TUI build an ever-growing browser queue. Detaching
      // only this tmux client leaves the session and its history alive; once the browser
      // parses what it already received, a fresh attach redraws the current screen.
      resyncPending = true;
      killTerminal();
    }
    return true;
  };

  // Register cancellation before the first await. A closed setup must never reach the
  // side-effectful attach-session, where an exclusive owner attach could evict a newer connection.
  ws.on('close', () => {
    closed = true;
    attachSequence += 1;
    inputGeneration += 1;
    inputOperation = null;
    pending.length = 0;
    killTerminal();
  });

  const handleMessage = (message) => {
    try {
      if (message.type === 'outputAck') {
        acknowledgeOutput(message);
        return;
      }
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
        if (flowControlEnabled && !validOutputFlowId(message.flowId)) {
          ws.close(1008, '无效的终端流控标识');
          return;
        }
        inputGeneration += 1;
        inputOperation = null;
        pendingScroll = Promise.resolve();
        for (const queued of pending) {
          if (queued.type === 'input' && queued.submit === true) {
            sendInputResult(queued, new Error('终端会话已切换，排队输入未发送'));
          }
        }
        pending.length = 0;
        awaitingSessionActivity = false;
        unacknowledgedOutput = 0;
        resyncPending = false;
        if (flowControlEnabled) activeFlowId = message.flowId;
        const [width, height] = dependencies.clampViewport(message.cols, message.rows);
        attachTerminal(message.session, { width, height }, true).catch((error) => {
          if (isOpen()) ws.close(1011, error.message || 'tmux session switch failed');
        });
        return;
      }
      if (message.type === 'input' && message.submit === true) {
        if (message.inputId !== undefined && (typeof message.inputId !== 'string'
          || !message.inputId.length || message.inputId.length > 128)) {
          ws.close(1008, '无效的终端输入标识');
          return;
        }
        if (readOnly || typeof message.data !== 'string' || !message.data.length || message.data.length > 100_001) {
          sendInputResult(message, new Error(readOnly ? '当前终端为只读，输入未发送' : '输入内容为空或过长'));
          return;
        }
      }
      if (!terminal || (inputOperation && (message.type === 'input' || message.type === 'scroll'))) {
        pending.push(message);
        return;
      }
      if (!readOnly && message.type === 'input' && typeof message.data === 'string') {
        if (message.submit === true) submitInput(message);
        else {
          terminal.write(message.data);
          if (/[\r\n]/.test(message.data)) awaitingSessionActivity = true;
        }
      }
      if (message.type === 'resize' && Number.isInteger(message.cols) && Number.isInteger(message.rows)) {
        const [cols, rows] = dependencies.clampViewport(message.cols, message.rows);
        activeViewport = { width: cols, height: rows };
        const nextGrid = `${cols}x${rows}`;
        if (nextGrid !== terminalGrid) {
          terminalGrid = nextGrid;
          terminal.resize(cols, rows);
        }
      }
      if (message.type === 'scroll' && Number.isInteger(message.lines)) {
        pendingScroll = dependencies.scrollSession(activeSession, message.lines).catch(() => {});
      }
    } catch { /* Ignore malformed terminal frames. */ }
  };
  ws.on('message', (raw, binary) => {
    if (binary || closed) return;
    try { handleMessage(JSON.parse(raw.toString())); }
    catch { /* Ignore malformed terminal frames. */ }
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
    activeViewport = attachSize;
    terminalGrid = `${attachSize.width}x${attachSize.height}`;
    terminalOutput = createTerminalOutputBatcher((data) => {
      sendOutput(data, attached);
    });
    if (resetScreen) sendOutput('\x1bc', attached);
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
      terminalOutput?.flush();
      terminalOutput?.cancel();
      terminalOutput = null;
      terminal = null;
      terminalGrid = '';
      if (isOpen()) ws.close(1000, `terminal exited (${exitCode})`);
    });
    // Modern tmux receives the exact pty dimensions at spawn and follows the newest
    // client. Older servers need one explicit SIGWINCH after attaching.
    if (!usesLatestClientSize) attached.resize(attachSize.width, attachSize.height);
    drainPending();
  }

  await attachTerminal(session, viewport);
}
