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

export function threadSnapshotRefreshInterval(snapshot, tmuxStatus) {
  const structuredActive = snapshot?.thread?.status?.type === 'active';
  return tmuxStatus === 'working' || structuredActive ? 1_000 : 10_000;
}
