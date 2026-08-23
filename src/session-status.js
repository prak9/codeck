export function isSessionActive(session) {
  return Boolean(session?.hasRunningProcess);
}

export function resolveSessionStatus(session) {
  if (isSessionActive(session)) return 'working';
  return session?.agent?.hasBackgroundProcess ? 'background' : 'done';
}
