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
    provider: input.provider,
    threadId: input.threadId,
    tmuxSession: input.tmuxSession,
    draft: input.draft,
    attachmentIds: [...(input.attachmentIds || [])],
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
      ...(input.baselineLastItemId ? { baselineLastItemId: input.baselineLastItemId } : {}),
      baselineMatchingTextCount: Number.isSafeInteger(input.baselineMatchingTextCount)
        && input.baselineMatchingTextCount >= 0 ? input.baselineMatchingTextCount : 0,
    } : {}),
  };
}

export function shouldKeepDeliveryAttempt(error) {
  return /连接已重置|连接已断开|连接失败|尚未连接|请求超时|network|socket/i
    .test(error?.message || String(error));
}

const DISMISSED_KEY = 'codeck-dismissed-deliveries';
const dismissalTarget = target => JSON.stringify([target.provider, target.threadId || target.id]);
function savedDismissals(storage) {
  try { const saved = JSON.parse(storage.getItem(DISMISSED_KEY) || '[]'); return Array.isArray(saved) ? saved : []; }
  catch { return []; }
}
export function dismissedDeliveryIds(storage, target) {
  return savedDismissals(storage).filter(entry => entry.target === dismissalTarget(target))
    .map(entry => entry.id).filter(id => typeof id === 'string');
}
export function rememberDismissedDeliveries(storage, target, ids) {
  if (!ids.length) return;
  const key = dismissalTarget(target);
  const saved = savedDismissals(storage).filter(entry => entry.target !== key || !ids.includes(entry.id));
  saved.push(...ids.map(id => ({ target: key, id })));
  storage.setItem(DISMISSED_KEY, JSON.stringify(saved.slice(-512)));
}
export function withoutDismissedDeliveries(thread, ids) {
  if (!thread || !ids.length) return thread;
  const dismissed = new Set(ids.map(id => `delivery:${id}`));
  const turns = (thread.turns || []).flatMap(turn => {
    const items = (turn.items || []).filter(item => !item.delivery || !dismissed.has(item.id));
    return !items.length && turn.deliveryOnly ? [] : items.length === (turn.items || []).length ? [turn] : [{ ...turn, items }];
  });
  return { ...thread, turns, dismissedDeliveryIds: [...new Set([...(thread.dismissedDeliveryIds || []), ...ids])] };
}
