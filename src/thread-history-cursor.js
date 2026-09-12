export function encodeHistoryCursor(provider, threadId, beforeTurnId) {
  return Buffer.from(JSON.stringify([1, provider, threadId, beforeTurnId])).toString('base64url');
}

export function decodeHistoryCursor(cursor, provider, threadId) {
  try {
    if (typeof cursor !== 'string' || cursor.length > 2048) throw new Error();
    const [version, owner, thread, anchor] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (version !== 1 || owner !== provider || thread !== threadId || typeof anchor !== 'string' || !anchor) throw new Error();
    return anchor;
  } catch { throw new Error('Invalid thread history cursor'); }
}
