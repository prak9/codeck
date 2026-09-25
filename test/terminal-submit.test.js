import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { AUTONOMY_PROGRESS_PROMPT } from '../public/remote-autonomy.js';
import { terminalDraftForSend, terminalDraftForHandoff } from '../public/terminal-compose.js';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const server = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
function functionSource(text, name) {
  const start = text.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  return start < 0 ? '' : text.slice(start, text.indexOf('\n}', start) + 2);
}

function fixture({ legacy = false, draftValue = 'echo intact', agentKind = 'qodercli' } = {}) {
  const sent = [], feedback = [], timers = new Map();
  const draft = { value: draftValue, hidden: false, classList: { add() {} } };
  const socket = { readyState: 1, send: (data) => sent.push(JSON.parse(data)) };
  const state = {
    socket, active: 'one', connectionId: 1, canWrite: true, terminalInputReady: true,
    terminalSubmitSupported: !legacy, terminalSubmitPending: null, nextTerminalSubmitId: 0,
    sessions: [{ name: 'one', agent: agentKind ? { kind: agentKind } : null }],
  };
  let timerId = 0;
  const context = vm.createContext({
    state, $: () => draft, WebSocket: { OPEN: 1 }, terminalDraftForSend, terminalDraftForHandoff,
    voiceInput: { abort() {} }, terminalVoiceBaseDraft: '', terminalVoiceHadResult: false,
    terminalAutonomy: { sendDirection: () => null },
    resizeTerminalVoiceDraft() {}, syncTerminalVoiceControls() {},
    setTerminalVoiceState: (_active, message) => feedback.push(message),
    setConnectionMessage: (message) => feedback.push(message),
    setTimeout: (callback) => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: (id) => timers.delete(id),
  });
  for (const name of ['captureTerminalTarget', 'isCurrentTerminalTarget', 'rejectTerminalSubmit', 'requestTerminalSubmit', 'submitTerminalVoiceDraft', 'sendTerminalInput', 'handOffTerminalInput']) {
    vm.runInContext(functionSource(source, name), context);
  }
  return { context, state, draft, sent, socket, feedback, timers };
}

function progressFixture({
  agentKind = 'codex', question = null, canManage = true, canWrite = true, sessionFeedReady = true,
} = {}) {
  const requests = [], feedback = [];
  const draft = { value: '尚未发送的草稿' };
  const button = {
    hidden: true, disabled: false, title: '', attributes: {},
    setAttribute(name, value) { this.attributes[name] = String(value); },
  };
  let terminalFocuses = 0;
  let resolveRequest;
  const request = new Promise((resolve) => { resolveRequest = resolve; });
  const state = {
    active: 'one', canManage, canWrite, sessionFeedReady, terminalProgressPending: null,
    sessions: [{
      name: 'one',
      agent: agentKind ? { kind: agentKind, id: 'thread-1', ...(question ? { question } : {}) } : null,
    }],
    terminal: { focus: () => { terminalFocuses += 1; } },
  };
  const context = vm.createContext({
    state,
    $: (selector) => selector === '#terminalProgressButton' ? button : draft,
    crypto: { randomUUID: () => 'progress-command' },
    sessionFeedRequest: (type, payload) => { requests.push({ type, ...payload }); return request; },
    setConnectionMessage: (message, restore) => feedback.push({ message, restore }),
    PROGRESS_PROMPT: AUTONOMY_PROGRESS_PROMPT,
  });
  for (const name of ['activeAgentSessionTarget', 'syncTerminalProgressButton', 'askTerminalProgress']) {
    vm.runInContext(functionSource(source, name), context);
  }
  return {
    context, state, draft, button, requests, feedback,
    resolveRequest, terminalFocuses: () => terminalFocuses,
  };
}

test('whole draft submission waits for server receipt and does not send twice while pending', async () => {
  const f = fixture();
  const pending = f.context.submitTerminalVoiceDraft();
  assert.equal(f.draft.value, 'echo intact');
  assert.equal(f.sent[0].submit, true);
  assert.equal(f.sent[0].replaceDraft, true);
  assert.equal(f.sent[0].separateFinalEnter, undefined, 'ordinary Qoder prompts keep one atomic write');
  assert.equal(typeof f.sent[0].inputId, 'string');
  await f.context.submitTerminalVoiceDraft();
  assert.equal(f.sent.length, 1);
  f.state.terminalSubmitPending.resolve();
  await pending;
  assert.equal(f.draft.value, '');
  assert.equal(f.state.terminalSubmitPending, null);
  assert.equal(f.timers.size, 0);
});

test('explicit composer handoff preserves bytes and asks the server to leave copy mode', () => {
  const f = fixture({ draftValue: '看下 ' });
  f.context.handOffTerminalInput('@');
  assert.deepEqual(f.sent, [{ type: 'input', data: '看下 @', resume: true }]);
  assert.equal(f.draft.value, ''); assert.equal(f.state.handoffTerminalInput, true);
});

test('autonomous direction uses the shared control path, not raw terminal input', async () => {
  const f = fixture({ draftValue: '只修改后端，继续' });
  const routed = []; let finish;
  f.context.terminalAutonomy.sendDirection = text => { routed.push(text); return new Promise(resolve => { finish = resolve; }); };
  const pending = f.context.submitTerminalVoiceDraft();
  await f.context.submitTerminalVoiceDraft();
  assert.deepEqual(routed, ['只修改后端，继续']); assert.deepEqual(f.sent, []);
  assert.equal(f.draft.value, '只修改后端，继续');
  finish(); await pending; assert.equal(f.draft.value, '');
  assert.equal(f.state.terminalSubmitPending, null);
});

test('failed or stale autonomy direction never clears the current draft or falls back to raw input', async () => {
  for (const outcome of ['error', 'switch', 'edit']) {
    const f = fixture(); let finish, fail;
    f.context.terminalAutonomy.sendDirection = () => new Promise((resolve, reject) => { finish = resolve; fail = reject; });
    const pending = f.context.submitTerminalVoiceDraft();
    if (outcome === 'error') fail(new Error('Agent 连接已断开'));
    else {
      if (outcome === 'switch') { f.state.active = 'two'; f.state.connectionId++; }
      f.draft.value = '新草稿'; finish();
    }
    await pending; assert.deepEqual(f.sent, []);
    assert.equal(f.draft.value, outcome === 'error' ? 'echo intact' : '新草稿');
  }
});

test('switching cancels the local wait for a direction without blocking the new terminal', async () => {
  const f = fixture(); let finish;
  f.context.terminalAutonomy.sendDirection = () => new Promise(resolve => { finish = resolve; });
  const pending = f.context.submitTerminalVoiceDraft();
  f.context.rejectTerminalSubmit('会话已切换');
  f.state.active = 'two'; f.state.connectionId++;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.state.terminalSubmitPending, null);
  assert.equal(f.draft.value, 'echo intact'); assert.deepEqual(f.sent, []);
  finish(); await pending;
});

test('slash commands request a separate final Enter even before Agent identity resolves', async () => {
  for (const agentKind of ['qodercli', 'codex', 'claude', null]) {
    const f = fixture({ draftValue: '/model', agentKind });
    const pending = f.context.submitTerminalVoiceDraft();
    assert.equal(f.sent[0].separateFinalEnter, true, agentKind || 'pending identity');
    f.state.terminalSubmitPending.resolve();
    await pending;
  }
});

test('edits made while waiting for the receipt are never cleared', async () => {
  const f = fixture();
  const pending = f.context.submitTerminalVoiceDraft();
  f.draft.value = 'next draft';
  f.state.terminalSubmitPending.resolve();
  await pending;
  assert.equal(f.draft.value, 'next draft');
});

for (const suffix of ['\x12', '@', '\t']) {
  test(`handoff ${JSON.stringify(suffix)} cannot replay or clear a draft awaiting confirmation`, async () => {
    const f = fixture();
    const pending = f.context.submitTerminalVoiceDraft();
    f.context.handOffTerminalInput(suffix);
    const valueAfterHandoff = f.draft.value;
    f.state.terminalSubmitPending.reject(new Error('fixture failure'));
    await pending;
    assert.equal(f.sent.length, 1);
    assert.equal(valueAfterHandoff, 'echo intact');
    assert.equal(f.draft.value, 'echo intact');
    assert.notEqual(f.state.handoffTerminalInput, true);
  });
}

for (const cause of ['server failure', 'timeout', 'disconnect', 'switch']) {
  test(`submission retains the draft without replay after ${cause}`, async () => {
    const f = fixture();
    const pending = f.context.submitTerminalVoiceDraft();
    assert.equal(f.draft.value, 'echo intact');
    if (cause === 'timeout') [...f.timers.values()][0]();
    else if (cause === 'server failure') f.state.terminalSubmitPending.reject(new Error('fixture failure'));
    else {
      f.context.rejectTerminalSubmit('发送结果未确认');
      if (cause === 'disconnect') f.socket.readyState = 3;
      else { f.state.active = 'two'; f.state.connectionId += 1; }
    }
    await pending;
    assert.equal(f.draft.value, 'echo intact');
    assert.equal(f.sent.length, 1);
    assert.equal(f.state.terminalSubmitPending, null);
    assert.equal(f.timers.size, 0);
    if (cause !== 'switch') assert.match(f.feedback.at(-1), /草稿.*保留/);
  });
}

test('legacy server receives a backwards-compatible input without waiting for an unsupported receipt', async () => {
  const f = fixture({ legacy: true });
  await f.context.submitTerminalVoiceDraft();
  assert.deepEqual(f.sent, [{ type: 'input', data: 'echo intact\r', submit: true, replaceDraft: true }]);
  assert.equal(f.draft.value, '');
  assert.equal(f.state.terminalSubmitPending, null);
  assert.equal(f.timers.size, 0);
});

test('connecting and readonly terminals cannot submit or clear a draft', async () => {
  for (const property of ['canWrite', 'terminalInputReady']) {
    const f = fixture();
    f.state[property] = false;
    await f.context.submitTerminalVoiceDraft();
    assert.deepEqual(f.sent, []);
    assert.equal(f.draft.value, 'echo intact');
  }
});

test('server advertises receipt support without broadening owner or share permissions', async () => {
  const context = vm.createContext({
    sessionSnapshots: { get: async () => [] }, flexibleSizeSupport: async () => true,
    resolveSessionStatus: () => 'done',
  });
  vm.runInContext(functionSource(server, 'sessionSnapshotForAuth'), context);
  for (const auth of [{ owner: true, canWrite: true }, { owner: false, canWrite: true }, { owner: false, canWrite: false }]) {
    const snapshot = await context.sessionSnapshotForAuth(auth);
    assert.equal(snapshot.capabilities.terminalSubmit, true);
    assert.equal(snapshot.capabilities.canManage, auth.owner);
    assert.equal(snapshot.capabilities.canWrite, auth.canWrite);
  }
});

test('normal terminal progress button sends one verified Agent message without touching the draft', async () => {
  const f = progressFixture();
  f.context.syncTerminalProgressButton();
  assert.equal(f.button.hidden, false);
  assert.equal(f.button.disabled, false);
  assert.equal(f.button.attributes['aria-label'], '询问 Agent 进度');

  const pending = f.context.askTerminalProgress();
  assert.deepEqual(f.requests, [{
    type: 'sendSessionMessage',
    provider: 'codex',
    threadId: 'thread-1',
    tmuxSession: 'one',
    text: AUTONOMY_PROGRESS_PROMPT,
    commandId: 'progress-command',
  }]);
  assert.equal(f.state.terminalProgressPending.commandId, 'progress-command');
  assert.equal(f.button.disabled, true, 'a second click must be blocked while delivery is pending');
  assert.equal(f.draft.value, '尚未发送的草稿');

  f.resolveRequest({ submissionStatus: 'submitted' });
  await pending;
  assert.equal(f.state.terminalProgressPending, null);
  assert.equal(f.button.disabled, false);
  assert.deepEqual(f.feedback.at(-1), { message: '已询问 Agent 进度', restore: undefined });
  assert.equal(f.draft.value, '尚未发送的草稿');
});

test('normal terminal progress button focuses a known waiting question instead of sending over it', async () => {
  const f = progressFixture({ question: { prompt: '请选择部署环境' } });
  f.context.syncTerminalProgressButton();
  assert.equal(f.button.hidden, false);
  assert.equal(f.button.disabled, false);
  assert.equal(f.button.attributes['aria-label'], '处理 Agent 等待的问题');
  await f.context.askTerminalProgress();
  assert.deepEqual(f.requests, []);
  assert.equal(f.terminalFocuses(), 1);
  assert.match(f.feedback.at(-1).message, /正在等待回答/);
});

test('normal terminal progress button stays hidden outside an owned Agent session', () => {
  for (const options of [{ agentKind: 'shell' }, { agentKind: null }, { canManage: false }, { canWrite: false }]) {
    const f = progressFixture(options);
    f.context.syncTerminalProgressButton();
    assert.equal(f.button.hidden, true);
  }
  const connecting = progressFixture({ sessionFeedReady: false });
  connecting.context.syncTerminalProgressButton();
  assert.equal(connecting.button.hidden, false);
  assert.equal(connecting.button.disabled, true);
});
