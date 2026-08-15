const SESSION_ACTIVITY_WINDOW_MS = 30_000;

export function isSessionActive(session, now = Date.now(), activityWindowMs = SESSION_ACTIVITY_WINDOW_MS) {
  const hasRecentOutput = Number.isFinite(session?.activityAt) && Number.isFinite(now)
    && (now - session.activityAt) <= activityWindowMs;

  return Boolean(hasRecentOutput || session?.hasRunningProcess);
}

export function resolveSessionStatus(session, now = Date.now()) {
  return isSessionActive(session, now) ? 'working' : 'done';
}

export const SESSION_STATUS_WINDOW_MS = SESSION_ACTIVITY_WINDOW_MS;
