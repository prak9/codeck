import test from 'node:test';
import assert from 'node:assert/strict';
import { composerControlState, composerSubmitAction, createComposerRequestGate, draftAfterSuccessfulSend, sessionStatusAfterSend, sessionWorkingAfterSend } from '../public/remote-composer.js';

test('a pending composer request cannot be reinterpreted as an interrupt', async () => {
  const pendingChanges = [];
  const actions = [];
  const gate = createComposerRequestGate((pending) => pendingChanges.push(pending));
  let releaseSend;
  const sendFinished = new Promise((resolve) => { releaseSend = resolve; });

  const first = gate.run(async () => {
    actions.push('send');
    await sendFinished;
  });
  const secondStarted = await gate.run(async () => { actions.push('interrupt'); });

  assert.equal(gate.pending, true);
  assert.equal(secondStarted, false);
  assert.deepEqual(actions, ['send']);
  releaseSend();
  assert.equal(await first, true);
  assert.equal(gate.pending, false);
  assert.deepEqual(pendingChanges, [true, false]);
});

test('a successful send clears only the draft that was submitted', () => {
  assert.equal(draftAfterSuccessfulSend('first message', 'first message'), '');
  assert.equal(draftAfterSuccessfulSend('next message', 'first message'), 'next message');
});

test('opening a thread blocks send and stop actions until the target is ready', () => {
  assert.deepEqual(composerControlState({
    active: true,
    connected: true,
    hasText: true,
    opening: true,
    pending: false,
    readOnly: false,
  }), {
    ariaLabel: '正在读取会话',
    disabled: true,
    stopMode: false,
  });
});

test('a completed local slash command does not leave an idle session busy', () => {
  assert.equal(sessionWorkingAfterSend({ wasWorking: false, result: undefined }), true);
  assert.equal(sessionWorkingAfterSend({
    wasWorking: false, result: { terminalOutput: 'Model: gpt-5' },
  }), false);
  assert.equal(sessionWorkingAfterSend({
    wasWorking: false, result: { terminalOutput: 'Reviewing', terminalWorking: true },
  }), true);
  assert.equal(sessionWorkingAfterSend({
    wasWorking: true, result: { terminalOutput: 'Model: gpt-5' },
  }), true);
});

test('a local command cannot make a background session look ready', () => {
  assert.equal(sessionStatusAfterSend({
    previousStatus: 'background', result: { terminalOutput: 'Model: gpt-5' },
  }), 'background');
  assert.equal(sessionStatusAfterSend({
    previousStatus: 'done', result: { terminalOutput: 'Model: gpt-5' },
  }), 'done');
  assert.equal(sessionStatusAfterSend({
    previousStatus: 'background', result: undefined,
  }), 'working');
});

test('an attachment-only Agent follow-up cannot be mistaken for stop', () => {
  assert.equal(composerSubmitAction({ active: true, attachmentCount: 1, provider: 'codex', text: '' }), 'send');
  assert.equal(composerSubmitAction({ active: false, attachmentCount: 1, provider: 'claude', text: '' }), 'send');
});

test('only an explicit stop-button submission can interrupt an active turn', () => {
  assert.equal(composerSubmitAction({
    active: true, attachmentCount: 0, provider: 'codex', text: '', explicitInterrupt: false,
  }), 'none');
  assert.equal(composerSubmitAction({
    active: true, attachmentCount: 0, provider: 'codex', text: '', explicitInterrupt: true,
  }), 'interrupt');
});

test('Shell attachments require a command and preserve the normal stop action', () => {
  assert.equal(composerSubmitAction({ active: false, attachmentCount: 1, provider: 'shell', text: '' }), 'needsShellCommand');
  assert.equal(composerSubmitAction({ active: true, attachmentCount: 1, provider: 'shell', text: '' }), 'needsShellCommand');
  assert.equal(composerSubmitAction({ active: true, attachmentCount: 1, provider: 'shell', text: 'python inspect.py' }), 'send');
  assert.equal(composerSubmitAction({
    active: true, attachmentCount: 0, provider: 'shell', text: '', explicitInterrupt: true,
  }), 'interrupt');
});

test('unconfirmed submission does not invent a working session', () => {
  for (const previousStatus of ['done', 'background', 'working']) {
    assert.equal(sessionStatusAfterSend({ previousStatus, result: { submissionStatus: 'unconfirmed' } }), previousStatus);
  }
});
