import test from 'node:test';
import assert from 'node:assert/strict';
import { composerControlState, createComposerRequestGate, draftAfterSuccessfulSend } from '../public/remote-composer.js';

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
