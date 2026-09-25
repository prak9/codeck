import test from 'node:test';
import assert from 'node:assert/strict';
import * as deliveryModule from '../public/remote-delivery.js';
import {
  deliveryAttemptKey,
  prepareDeliveryAttempt,
  shouldKeepDeliveryAttempt,
} from '../public/remote-delivery.js';

const input = {
  provider: 'qodercli',
  threadId: 'thread-1',
  tmuxSession: 'research',
  draft: '继续检查',
  attachmentIds: ['attachment-1'],
};

test('dismissed receipt hints survive reload, stay target-scoped, and never claim confirmation', () => {
  const values = new Map(); const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  deliveryModule.rememberDismissedDeliveries(storage, input, ['command-removed']);
  assert.deepEqual(deliveryModule.dismissedDeliveryIds(storage, input), ['command-removed']);
  assert.deepEqual(deliveryModule.dismissedDeliveryIds(storage, { ...input, threadId: 'other' }), []);
  const thread = { turns: [{ id: 'old', deliveryOnly: true, items: [{ id: 'delivery:command-removed', delivery: { status: 'unknown' } }] },
    { id: 'real', items: [{ id: 'actual', type: 'userMessage', content: 'A longer accepted message' }] }] };
  const clean = deliveryModule.withoutDismissedDeliveries(thread, ['command-removed']);
  assert.deepEqual(clean.turns.map(turn => turn.id), ['real']);
  assert.equal(clean.deliveryConfirmations, undefined);
  assert.equal(thread.turns.length, 2);
});

test('an uncertain retry reuses its command id while the server epoch is unchanged', () => {
  const first = prepareDeliveryAttempt(null, {
    ...input,
    mode: 'followUp',
    baselineVersion: 2,
    baselineUserMessageId: 'user-7',
    baselineTurnId: 'turn-7',
    baselineLastItemId: 'tool-7',
    baselineMatchingTextCount: 0,
  }, {
    serverEpoch: 'epoch-1',
    createId: () => 'command-12345678',
  });
  const retry = prepareDeliveryAttempt(first, {
    ...input,
    mode: 'steer',
    turnId: 'turn-2',
    baselineVersion: 2,
    baselineUserMessageId: 'user-8',
    baselineTurnId: 'turn-8',
    baselineLastItemId: 'tool-8',
    baselineMatchingTextCount: 1,
  }, {
    serverEpoch: 'epoch-1',
    createId: () => 'should-not-run',
  });

  assert.equal(retry, first);
  assert.equal(retry.blocked, false);
  assert.equal(retry.commandId, 'command-12345678');
  assert.equal(retry.mode, 'followUp');
  assert.equal(retry.turnId, null);
  assert.equal(retry.baselineUserMessageId, 'user-7');
  assert.equal(retry.baselineTurnId, 'turn-7');
  assert.equal(retry.baselineLastItemId, 'tool-7');
  assert.equal(retry.baselineMatchingTextCount, 0);
});

test('an uncertain delivery is blocked after a server restart', () => {
  const first = prepareDeliveryAttempt(null, input, {
    serverEpoch: 'epoch-1', createId: () => 'command-12345678',
  });
  const retry = prepareDeliveryAttempt(first, input, {
    serverEpoch: 'epoch-2', createId: () => 'should-not-run',
  });

  assert.equal(retry.commandId, first.commandId);
  assert.equal(retry.blocked, true);
  assert.equal(retry.blockReason, 'serverRestart');
});

test('a legacy attempt is not replayed after reconnecting to a sequenced server', () => {
  const first = prepareDeliveryAttempt(null, input, {
    serverEpoch: '', createId: () => 'command-12345678',
  });
  const retry = prepareDeliveryAttempt(first, input, {
    serverEpoch: 'epoch-1', createId: () => 'should-not-run',
  });

  assert.equal(retry.commandId, first.commandId);
  assert.equal(retry.blocked, true);
});

test('only transport failures preserve an uncertain delivery attempt', () => {
  assert.equal(shouldKeepDeliveryAttempt(new Error('Agent 连接已断开')), true);
  assert.equal(shouldKeepDeliveryAttempt(new Error('Agent 请求超时')), true);
  assert.equal(shouldKeepDeliveryAttempt(new Error('会话信息无效，请刷新后重试')), false);
});

test('uncertain attempts remain isolated by tmux session', () => {
  assert.notEqual(
    deliveryAttemptKey(input),
    deliveryAttemptKey({ ...input, tmuxSession: 'skills' }),
  );
});

test('an uncertain attempt is blocked after the server receipt window expires', () => {
  const first = prepareDeliveryAttempt(null, input, {
    serverEpoch: 'epoch-1', receiptTtlMs: 1_000, now: () => 5_000,
    createId: () => 'command-12345678',
  });
  const retry = prepareDeliveryAttempt(first, input, {
    serverEpoch: 'epoch-1', receiptTtlMs: 1_000, now: () => 6_000,
    createId: () => 'should-not-run',
  });

  assert.equal(retry.commandId, first.commandId);
  assert.equal(retry.blocked, true);
  assert.equal(retry.blockReason, 'receiptExpired');
});
