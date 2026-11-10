// Session readiness and provider turn endings never assert that the user's goal is complete.
export function sessionExecutionState(session) {
  if (session?.agent?.question) return 'waitingForInput';
  if (session?.hasRunningProcess || ['working', 'running'].includes(session?.status)) return 'working';
  if (session?.agent?.hasBackgroundProcess || session?.status === 'background') return 'background';
  if (['done', 'worked', 'idle'].includes(session?.status) || session?.hasRunningProcess === false) return 'idle';
  return 'unknown';
}

export function executionLabel(state) {
  return { working: '正在干活', background: '后台运行', waitingForInput: '等待你的回答', idle: '已就绪', failed: '运行出错', unknown: '状态未知' }[state] || '状态未知';
}

export function turnOutcome(turn) {
  if (turn?.error || ['failed', 'errored'].includes(turn?.status)) return 'failed';
  if (['inProgress', 'running'].includes(turn?.status)) return 'running';
  if (['interrupted', 'cancelled'].includes(turn?.status)) return 'interrupted';
  if (turn?.status === 'completed') return 'ended';
  if (turn?.status === 'declined') return 'declined';
  return 'unknown';
}

export function turnStatusLabel(status) {
  return { failed: '本轮失败', running: '运行中', interrupted: '本轮中止', ended: '本轮结束', declined: '已拒绝', unknown: '状态未知' }[turnOutcome({ status })];
}

export function checkpointLabel(checkpoint) {
  const label = { failed: '本轮失败', question: '需要回答', ended: '本轮有新结果', review: '待你查看' }[checkpoint?.attention?.kind];
  if (checkpoint?.stale) return checkpoint.text ? '历史进度 · 待确认' : '';
  return [checkpoint?.progress?.needsUser ? '● 需要判断' : label ? `● ${label}` : '', checkpoint?.text || ''].filter(Boolean).join(' · ');
}
