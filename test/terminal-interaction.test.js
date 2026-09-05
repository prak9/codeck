import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as terminalUtils from '../public/terminal-utils.js';
import { latestAgentOutputText } from '../public/remote-copy.js';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

function functionSource(name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  return start < 0 ? '' : source.slice(start, source.indexOf('\n}', start) + 2);
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const messages = [];
  const sent = [];
  const nodes = new Map();
  const $ = (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, {
      hidden: true, textContent: '', style: {}, value: 'unsent draft',
      classList: { add() {}, remove() {}, toggle() {} },
      setAttribute() {}, closest() { return this; }, addEventListener() {},
    });
    return nodes.get(selector);
  };
  const socket = { readyState: 1, send: (raw) => sent.push(JSON.parse(raw)), close() { this.readyState = 3; } };
  const state = {
    active: 'a', connectionId: 1, socket, canManage: true, canWrite: true,
    terminalInputReady: true, sessions: [], canSwitchSession: true,
    terminal: { focus() {}, cols: 80, rows: 24, write(_data, done) { done(); } },
  };
  const listeners = new Map();
  $('.mobile-keybar').addEventListener = (type, handler) => listeners.set(type, handler);
  const context = vm.createContext({
    state, $, WebSocket: { OPEN: 1 }, URLSearchParams, setTimeout, clearTimeout,
    location: { protocol: 'http:', host: 'localhost' },
    ...terminalUtils,
    ensureTerminal: () => state.terminal,
    resetTerminalInput: async () => {},
    closeTerminalVoiceComposer() {}, markActiveSession() {}, refreshActiveAgentOutput() {},
    stopKeyRepeat() {}, fitTerminalView() {}, focusTerminalInput() {}, syncTerminalAccess() {},
    connectedStateLabel: () => '已连接', terminalOutputForSession: (output) => output,
    setConnectionMessage: (message) => messages.push(message),
    shellQuotePath: (path) => `'${path}'`, hasFileDrag: () => true,
    navigator: { clipboard: {} },
  });
  for (const name of ['captureTerminalTarget', 'isCurrentTerminalTarget', 'showTerminalDisconnect', 'pasteImages', 'handleTerminalDrop', 'connect']) {
    vm.runInContext(functionSource(name), context);
  }
  const clickStart = source.indexOf("$('.mobile-keybar').addEventListener('click', async");
  vm.runInContext(source.slice(clickStart, source.indexOf("\n$('#shareButton')", clickStart)), context);
  return { context, state, socket, sent, messages, $, listeners };
}

const imageEvent = () => ({
  clipboardData: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => ({ type: 'image/png' }) }] },
  preventDefault() {}, stopImmediatePropagation() {},
});

function mobileKeyFixture() {
  const f = fixture();
  const timers = [];
  Object.assign(f.context, {
    setTimeout: (callback) => { timers.push(callback); return timers.length; },
    setInterval: (callback) => { timers.push(callback); return timers.length; },
    clearInterval() {},
  });
  const start = source.indexOf('const TERMINAL_KEYS =');
  const end = source.indexOf("$('#terminalVoiceCaptureButton').addEventListener", start);
  vm.runInContext(source.slice(start, end), f.context);
  const press = () => f.listeners.get('pointerdown')({
    target: { closest: () => ({ dataset: { terminalKey: 'enter' } }) },
  });
  return { ...f, timers, press };
}

test('mobile Enter confirms in the terminal without sending or clearing a local draft or repeating', () => {
  assert.match(html, /<button[^>]*data-terminal-key="enter"[^>]*>Enter<\/button>/);
  const f = mobileKeyFixture();
  f.$('#terminalVoiceComposer').hidden = false;
  f.press();
  f.listeners.get('pointerup')();
  assert.deepEqual(f.sent, [{ type: 'input', data: '\r' }]);
  assert.equal(f.$('#terminalVoiceDraft').value, 'unsent draft');
  assert.deepEqual(f.timers, [], 'holding Enter must not confirm subsequent prompts');
});

for (const blocked of ['readonly', 'connecting', 'disconnected']) {
  test(`mobile Enter cannot send while ${blocked}`, () => {
    const f = mobileKeyFixture();
    if (blocked === 'readonly') f.state.canWrite = false;
    if (blocked === 'connecting') f.state.terminalInputReady = false;
    if (blocked === 'disconnected') f.socket.readyState = 3;
    f.press();
    assert.deepEqual(f.sent, []);
    assert.deepEqual(f.timers, []);
  });
}

for (const backToOriginal of [false, true]) {
  test(`image upload never inserts into a reused socket after switching${backToOriginal ? ' away and back' : ''}`, async () => {
    const f = fixture();
    const upload = deferred();
    f.context.api = () => upload.promise;
    const pending = f.context.pasteImages(imageEvent());
    f.state.active = backToOriginal ? 'a' : 'b';
    f.state.connectionId += backToOriginal ? 2 : 1;
    upload.resolve({ path: '/tmp/image.png' });
    await pending;
    assert.deepEqual(f.sent, []);
    assert.match(f.messages.at(-1), /会话已切换/);
  });
}

test('an unchanged live image upload inserts the path exactly once', async () => {
  const f = fixture();
  f.context.api = async () => ({ path: '/tmp/image.png' });
  await f.context.pasteImages(imageEvent());
  assert.deepEqual(f.sent, [{ type: 'input', data: "'/tmp/image.png'" }]);
});

test('a dropped directory switched during enumeration does not upload or insert', async () => {
  const f = fixture();
  const files = deferred();
  let uploads = 0;
  f.context.collectDroppedFilesFromDataTransfer = () => files.promise;
  f.context.uploadFileBlob = async () => { uploads += 1; return { path: '/tmp/file' }; };
  const pending = f.context.handleTerminalDrop({ preventDefault() {}, stopPropagation() {}, dataTransfer: {} });
  f.state.active = 'b';
  f.state.connectionId += 1;
  files.resolve([{ file: {}, relativePath: '' }]);
  await pending;
  assert.equal(uploads, 0);
  assert.deepEqual(f.sent, []);
});

test('file upload checks session generation after the upload finishes', async () => {
  const f = fixture();
  const upload = deferred();
  f.context.collectDroppedFilesFromDataTransfer = async () => [{ file: {}, relativePath: '' }];
  f.context.uploadFileBlob = () => upload.promise;
  const pending = f.context.handleTerminalDrop({ preventDefault() {}, stopPropagation() {}, dataTransfer: {} });
  await Promise.resolve();
  f.state.connectionId += 1;
  upload.resolve({ path: '/tmp/file' });
  await pending;
  assert.deepEqual(f.sent, []);
});

for (const change of ['switch', 'disconnect', 'readonly']) {
  test(`clipboard confirmation cannot send after ${change}`, async () => {
    const f = fixture();
    const clipboard = deferred();
    f.context.navigator.clipboard.readText = () => clipboard.promise;
    const pending = f.listeners.get('click')({ target: { closest: () => ({ dataset: { terminalAction: 'paste' } }) } });
    if (change === 'switch') f.state.connectionId += 1;
    if (change === 'disconnect') f.socket.readyState = 3;
    if (change === 'readonly') f.state.canWrite = false;
    clipboard.resolve('do not send');
    await pending;
    assert.deepEqual(f.sent, []);
  });
}

test('clipboard paste and file upload still send once to an unchanged writable session', async () => {
  const f = fixture();
  f.context.navigator.clipboard.readText = async () => 'paste text';
  await f.listeners.get('click')({ target: { closest: () => ({ dataset: { terminalAction: 'paste' } }) } });
  f.context.collectDroppedFilesFromDataTransfer = async () => [{ file: {}, relativePath: 'directory' }];
  f.context.uploadFileBlob = async () => ({ path: '/tmp/directory/file' });
  await f.context.handleTerminalDrop({ preventDefault() {}, stopPropagation() {}, dataTransfer: {} });
  assert.deepEqual(f.sent, [
    { type: 'input', data: 'paste text' },
    { type: 'input', data: "'/tmp/directory/file'" },
  ]);
});

test('disconnection exposes a manual recovery control outside the narrow-screen header', async () => {
  const f = fixture();
  f.state.active = 'a';
  await f.context.connect('b');
  f.socket.readyState = 3;
  f.socket.onclose({ reason: 'detached by another client' });
  assert.equal(f.$('#terminalDisconnect').hidden, false);
  assert.match(f.$('#terminalDisconnectMessage').textContent, /detached by another client/);
  assert.equal(f.$('#reconnectTerminalButton').disabled, false);
  assert.match(html, /id="terminalDisconnect"[^>]*hidden/);
  assert.match(html, /id="reconnectTerminalButton"[^>]*type="button"/);
  assert.equal(f.$('#terminalVoiceDraft').value, 'unsent draft');
  f.state.cancelTerminalReveal?.();
});

test('queued final output remains visible after exit without re-enabling input', async () => {
  const f = fixture();
  const callbacks = [];
  f.state.terminal.write = (_data, done) => callbacks.push(done);
  await f.context.connect('b');
  f.socket.onmessage({ data: '\x1bc' });
  f.socket.onmessage({ data: 'FINAL-OUTPUT' });
  f.socket.readyState = 3;
  f.socket.onclose({ reason: '会话已结束' });
  while (callbacks.length) callbacks.shift()();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(f.state.terminalInputReady, false, 'a late reset callback cannot revive a closed connection');
  assert.equal(f.$('#terminal').style.visibility, '', 'the final screen must not stay hidden after exit');
  assert.equal(f.$('#connectionState').textContent, '会话已结束');
  assert.equal(f.$('#terminalDisconnect').hidden, false);
});

test('stale close and parse callbacks cannot modify a replacement session', async () => {
  const f = fixture();
  const callbacks = [];
  f.state.terminal.write = (_data, done) => callbacks.push(done);
  await f.context.connect('b');
  const staleClose = f.socket.onclose;
  f.socket.onmessage({ data: '\x1bc' });
  f.socket.onmessage({ data: 'old frame' });
  await f.context.connect('c');
  staleClose({ reason: 'old close' });
  while (callbacks.length) callbacks.shift()();
  assert.equal(f.$('#terminalDisconnect').hidden, true);
  assert.equal(f.state.terminalInputReady, false);
  assert.equal(f.$('#terminal').style.visibility, 'hidden');
});

for (const backend of ['current', 'legacy', 'error']) {
  test(`latest-output prefetch uses the lightweight RPC with ${backend} backend`, async () => {
    const calls = [];
    const state = { sessionFeedReady: true, agentOutputCache: new Map(), agentOutputRequestSeq: 0 };
    const context = vm.createContext({
      state, latestAgentOutputText, syncAgentOutputCopyButtons() {},
      activeAgentOutputTarget: () => ({ key: 'codex:id', provider: 'codex', threadId: 'id', status: 'done', refreshKey: 'done:1' }),
      sessionFeedRequest: async (type) => {
        calls.push(type);
        if (backend === 'error') throw new Error('read failed');
        if (type === 'readLatestAgentOutput') {
          if (backend === 'legacy') throw new Error('Unknown agent message type: readLatestAgentOutput');
          return { text: 'complete reply' };
        }
        return { turns: [{ status: 'completed', items: [{ type: 'agentMessage', text: 'complete reply' }] }] };
      },
    });
    vm.runInContext(functionSource('refreshActiveAgentOutput'), context);
    await context.refreshActiveAgentOutput();
    assert.deepEqual(calls, backend === 'legacy' ? ['readLatestAgentOutput', 'loadThreadHistory'] : ['readLatestAgentOutput']);
    const entry = state.agentOutputCache.get('codex:id');
    assert.equal(entry.state, backend === 'error' ? 'error' : 'ready');
    if (backend !== 'error') assert.equal(entry.text, 'complete reply');
  });
}

test('wheel wiring captures before xterm, keeps readonly scroll, and cancels across switch', async () => {
  const f = fixture();
  const frames = new Map();
  let frameId = 0;
  let listener;
  let options;
  f.$('#terminal').addEventListener = (type, handler, config) => {
    if (type === 'wheel') { listener = handler; options = config; }
  };
  Object.assign(f.context, {
    Terminal: class {
      constructor() { this.rows = 24; this.cols = 80; }
      loadAddon() {} open() {} attachCustomKeyEventHandler() {}
      onData() {} onSelectionChange() {} onResize() {}
    },
    FitAddon: class {}, ResizeObserver: class { observe() {} },
    activateTerminalWebgl() {}, bindTerminalRenderWatchdog() {}, bindMobileScroll() {},
    handleTerminalDragEnter() {}, handleTerminalDragOver() {}, handleTerminalDragLeave() {}, handleTerminalDragStart() {},
    touchLog() {},
    createTerminalWheelScroller: (send) => terminalUtils.createTerminalWheelScroller(send, {
      schedule: (callback) => { frames.set(++frameId, callback); return frameId; },
      cancel: (id) => frames.delete(id),
    }),
  });
  f.state.terminal = null;
  vm.runInContext(functionSource('ensureTerminal'), f.context);
  f.context.ensureTerminal();
  assert.equal(options.capture, true);
  assert.equal(options.passive, false);
  const wheel = (extra = {}) => {
    let stopped = false, prevented = false;
    listener({ deltaY: -4, ...extra, stopPropagation() { stopped = true; }, preventDefault() { prevented = true; } });
    return { stopped, prevented };
  };
  assert.deepEqual(wheel({ ctrlKey: true }), { stopped: true, prevented: false });
  f.state.canWrite = false;
  for (let i = 0; i < 5; i++) assert.deepEqual(wheel(), { stopped: true, prevented: true });
  const flush = () => { for (const callback of [...frames.values()]) callback(); frames.clear(); };
  flush();
  assert.deepEqual(f.sent, [{ type: 'scroll', lines: 1 }]);
  wheel({ deltaY: -100 });
  f.state.cancelTerminalWheel();
  flush();
  assert.equal(f.sent.length, 1);
});
