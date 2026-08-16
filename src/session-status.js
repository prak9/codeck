export function isSessionActive(session) {
  return Boolean(session?.hasRunningProcess);
}

export function resolveSessionStatus(session) {
  return isSessionActive(session) ? 'working' : 'done';
}
