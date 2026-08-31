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

// 感知延迟的下限就是这个间隔。原来是 1s: 那时每次轮询要 ~65ms (整份重读
// transcript + 序列化 + diff), 已占单核 6.5%, 不敢再快。增量读取与尾部窗口把它
// 压到 ~6.3ms 之后, 350ms 一档也才 ~18ms/秒 —— 仍比原来的 1s 一档便宜三倍多。
const ACTIVE_THREAD_INTERVAL_MS = 350;

export function threadSnapshotRefreshInterval(snapshot, tmuxStatus, now = Date.now()) {
  const structuredActive = snapshot?.thread?.status?.type === 'active';
  if (tmuxStatus === 'working' || structuredActive) return ACTIVE_THREAD_INTERVAL_MS;
  if (tmuxStatus === 'background') return 2_000;
  const latestTurn = snapshot?.thread?.turns?.at(-1);
  const updatedAt = timestampMs(snapshot?.thread?.updatedAt);
  const updateAge = now - updatedAt;
  const externalTurnMayStillFlush = (
    latestTurn?.status === 'inProgress' || latestTurn?.status === 'interrupted'
  ) && updateAge >= 0 && updateAge <= 15_000;
  return externalTurnMayStillFlush ? ACTIVE_THREAD_INTERVAL_MS : 10_000;
}
