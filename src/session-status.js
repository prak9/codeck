const SESSION_ACTIVITY_WINDOW_MS = 5_000;

function hasRecentSessionFileModification(session, now = Date.now(), activityWindowMs = SESSION_ACTIVITY_WINDOW_MS) {
  const currentFileTime = Number(session?.sessionFileMtime);
  if (!Number.isFinite(currentFileTime) || !Number.isFinite(now) || now < currentFileTime) return false;
  return (now - currentFileTime) <= activityWindowMs;
}

export function isSessionActive(session, now = Date.now(), activityWindowMs = SESSION_ACTIVITY_WINDOW_MS) {
  if (session?.hasRunningProcess) return true;
  const hasSessionFileSignal = hasRecentSessionFileModification(session, now, activityWindowMs);
  if (hasSessionFileSignal) return true;
  const fallbackActivityAt = Number(session?.activityAt);
  return Number.isFinite(fallbackActivityAt) && (now - fallbackActivityAt) <= activityWindowMs;
}

export function resolveSessionStatus(session, now = Date.now(), activityWindowMs = SESSION_ACTIVITY_WINDOW_MS) {
  return isSessionActive(session, now, activityWindowMs) ? 'working' : 'done';
}

export { SESSION_ACTIVITY_WINDOW_MS };
