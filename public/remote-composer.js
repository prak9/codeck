export function createComposerRequestGate(onPendingChange = () => {}) {
  let pending = false;
  return {
    get pending() { return pending; },
    async run(operation) {
      if (pending) return false;
      pending = true;
      try {
        onPendingChange(true);
        await operation();
        return true;
      } finally {
        pending = false;
        onPendingChange(false);
      }
    },
  };
}

export function draftAfterSuccessfulSend(currentDraft, submittedDraft) {
  return currentDraft === submittedDraft ? '' : currentDraft;
}

export function composerControlState({ active, connected, hasText, opening, pending, readOnly }) {
  const blocked = opening || pending;
  return {
    stopMode: Boolean(!blocked && active && !hasText),
    disabled: Boolean(blocked || readOnly || !connected || (!hasText && !active)),
    ariaLabel: opening
      ? '正在读取会话'
      : pending ? '正在发送消息' : active && !hasText ? '停止当前任务' : '发送消息',
  };
}
