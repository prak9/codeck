export function isSessionActive(session) {
  return Boolean(session?.hasRunningProcess);
}

export function resolveSessionStatus(session) {
  if (isSessionActive(session)) return 'working';
  return session?.agent?.hasBackgroundProcess ? 'background' : 'done';
}

export function sessionSnapshotRefreshInterval(snapshot) {
  const statuses = snapshot?.sessions?.map((session) => session.status) || [];
  if (statuses.includes('working')) return 750;
  return statuses.includes('background') ? 2_000 : 5_000;
}

function timestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 10_000_000_000 ? value : value * 1000;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function threadSnapshotRefreshInterval(snapshot, tmuxStatus, now = Date.now()) {
  const structuredActive = snapshot?.thread?.status?.type === 'active';
  if (tmuxStatus === 'working' || structuredActive) return 1_000;
  if (tmuxStatus === 'background') return 2_000;
  const latestTurn = snapshot?.thread?.turns?.at(-1);
  const updatedAt = timestampMs(snapshot?.thread?.updatedAt);
  const updateAge = now - updatedAt;
  const externalTurnMayStillFlush = (
    latestTurn?.status === 'inProgress' || latestTurn?.status === 'interrupted'
  ) && updateAge >= 0 && updateAge <= 15_000;
  return externalTurnMayStillFlush ? 1_000 : 10_000;
}
