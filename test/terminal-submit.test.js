import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { terminalDraftForSend, terminalDraftForHandoff } from '../public/terminal-compose.js';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const server = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
function functionSource(text, name) {
  const start = text.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  return start < 0 ? '' : text.slice(start, text.indexOf('\n}', start) + 2);
}

function fixture({ legacy = false } = {}) {
  const sent = [], feedback = [], timers = new Map();
  const draft = { value: 'echo intact', hidden: false, classList: { add() {} } };
  const socket = { readyState: 1, send: (data) => sent.push(JSON.parse(data)) };
  const state = {
    socket, active: 'one', connectionId: 1, canWrite: true, terminalInputReady: true,
    terminalSubmitSupported: !legacy, terminalSubmitPending: null, nextTerminalSubmitId: 0,
  };
  let timerId = 0;
  const context = vm.createContext({
    state, $: () => draft, WebSocket: { OPEN: 1 }, terminalDraftForSend, terminalDraftForHandoff,
    voiceInput: { abort() {} }, terminalVoiceBaseDraft: '', terminalVoiceHadResult: false,
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

test('whole draft submission waits for server receipt and does not send twice while pending', async () => {
  const f = fixture();
  const pending = f.context.submitTerminalVoiceDraft();
  assert.equal(f.draft.value, 'echo intact');
  assert.equal(f.sent[0].submit, true);
  assert.equal(typeof f.sent[0].inputId, 'string');
  await f.context.submitTerminalVoiceDraft();
  assert.equal(f.sent.length, 1);
  f.state.terminalSubmitPending.resolve();
  await pending;
  assert.equal(f.draft.value, '');
  assert.equal(f.state.terminalSubmitPending, null);
  assert.equal(f.timers.size, 0);
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
  assert.deepEqual(f.sent, [{ type: 'input', data: 'echo intact\r', submit: true }]);
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
