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

export function acceptStreamFrame(current, incoming, kind = 'snapshot') {
  const cursor = normalizedCursor(incoming);
  if (!cursor) return { accepted: false, gap: true, cursor: current };
  if (kind === 'snapshot') {
    if (!current || current.epoch !== cursor.epoch || cursor.sequence >= current.sequence) {
      return { accepted: true, gap: false, cursor };
    }
    return { accepted: false, gap: false, cursor: current };
  }
  if (!current) return { accepted: false, gap: true, cursor: current };
  // A synchronized frame confirms that the client already holds the server's latest
  // sequence, so equality is its normal input and must be judged before the generic
  // "already seen, drop it" guard below — otherwise it can never be accepted and the
  // resync flag it is meant to clear stays set.
  if (kind === 'synchronized') {
    if (current.epoch !== cursor.epoch) return { accepted: false, gap: true, cursor: current };
    if (cursor.sequence === current.sequence) return { accepted: true, gap: false, cursor: current };
    return { accepted: false, gap: cursor.sequence > current.sequence, cursor: current };
  }
  if (current.epoch === cursor.epoch && cursor.sequence <= current.sequence) {
    return { accepted: false, gap: false, cursor: current };
  }
  const baseSequence = incoming?.baseSequence;
  const accepted = kind === 'delta'
    && current.epoch === cursor.epoch
    && Number.isSafeInteger(baseSequence)
    && baseSequence === current.sequence
    && cursor.sequence === baseSequence + 1;
  return { accepted, gap: !accepted, cursor: accepted ? cursor : current };
}

export function matchesThreadStreamTarget(thread, target) {
  if (!thread || !target) return false;
  return thread.provider === target.provider
    && thread.id === target.threadId
    && (thread.tmux?.name || '') === (target.tmuxSession || '');
}
