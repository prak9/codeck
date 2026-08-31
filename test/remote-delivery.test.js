import test from 'node:test';
import assert from 'node:assert/strict';
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

test('an uncertain retry reuses its command id while the server epoch is unchanged', () => {
  const first = prepareDeliveryAttempt(null, { ...input, mode: 'followUp', baselineUserCount: 7 }, {
    serverEpoch: 'epoch-1',
    createId: () => 'command-12345678',
  });
  const retry = prepareDeliveryAttempt(first, {
    ...input, mode: 'steer', turnId: 'turn-2', baselineUserCount: 8,
  }, {
    serverEpoch: 'epoch-1',
    createId: () => 'should-not-run',
  });

  assert.equal(retry, first);
  assert.equal(retry.blocked, false);
  assert.equal(retry.commandId, 'command-12345678');
  assert.equal(retry.mode, 'followUp');
  assert.equal(retry.turnId, null);
  assert.equal(retry.baselineUserCount, 7);
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
