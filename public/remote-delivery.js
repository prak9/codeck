export function deliveryAttemptKey(input) {
  return JSON.stringify([
    input.provider || '',
    input.threadId || '',
    input.tmuxSession || '',
    input.draft || '',
    input.attachmentIds || [],
  ]);
}

export function prepareDeliveryAttempt(current, input, {
  serverEpoch = '', receiptTtlMs = 10 * 60_000, now = Date.now,
  createId = () => crypto.randomUUID(),
} = {}) {
  const key = deliveryAttemptKey(input);
  if (current?.key === key) {
    if (current.serverEpoch !== serverEpoch) {
      return current.blocked ? current : { ...current, blocked: true, blockReason: 'serverRestart' };
    }
    if (current.expiresAt <= now()) {
      return current.blocked ? current : { ...current, blocked: true, blockReason: 'receiptExpired' };
    }
    return current;
  }
  return {
    key,
    commandId: createId(),
    serverEpoch,
    blocked: false,
    blockReason: '',
    expiresAt: now() + receiptTtlMs,
    mode: input.mode === 'steer' ? 'steer' : 'followUp',
    turnId: input.turnId || null,
    ...(input.baselineVersion === 2 ? {
      baselineVersion: 2,
      baselineUserMessageId: input.baselineUserMessageId || null,
      baselineTurnId: input.baselineTurnId || null,
      baselineMatchingTextCount: Number.isSafeInteger(input.baselineMatchingTextCount)
        && input.baselineMatchingTextCount >= 0 ? input.baselineMatchingTextCount : 0,
    } : {}),
  };
}

export function shouldKeepDeliveryAttempt(error) {
  return /连接已重置|连接已断开|连接失败|尚未连接|请求超时|network|socket/i
    .test(error?.message || String(error));
}
