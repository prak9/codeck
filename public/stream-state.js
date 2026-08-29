function normalizedCursor(stream) {
  if (!stream || typeof stream.epoch !== 'string' || !stream.epoch) return null;
  if (!Number.isSafeInteger(stream.sequence) || stream.sequence < 0) return null;
  return { epoch: stream.epoch, sequence: stream.sequence };
}

export function acceptStreamCursor(current, incoming) {
  const cursor = normalizedCursor(incoming);
  if (!cursor) return { accepted: false, cursor: current };
  if (!current || current.epoch !== cursor.epoch || cursor.sequence > current.sequence) {
    return { accepted: true, cursor };
  }
  return { accepted: false, cursor: current };
}

export function matchesThreadStreamTarget(thread, target) {
  if (!thread || !target) return false;
  return thread.provider === target.provider
    && thread.id === target.threadId
    && (thread.tmux?.name || '') === (target.tmuxSession || '');
}
