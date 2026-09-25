export const AUTONOMY_PROGRESS_PROMPT = '现在进展怎么样？请简要说明你理解的目标、当前进展、剩余事项和阻塞。不打断当前节奏，不续跑、不改方向、模式或预算。';

// An already-open page can still submit the previous prompt after deployment.
const PREVIOUS_PROGRESS_PROMPT = '请在方便时简报：你理解的目标及具体子目标、逐项完成标准、进展/证据、剩余gap、下一步和阻塞。不确定处标出；不打断、不续跑、不改方向、模式或预算。';
const LEGACY_PROGRESS_PROMPT = '现在进展怎么样？这是一次进度问询，请在不打断当前工作的自然汇报节点简要回答，不改变当前节奏，不催促续跑，也不进入自主模式。请复述你理解的当前目标，必须是具体、拆解过的子目标，不能只给笼统概括。沿用已确认的任务拆解，逐项简要列出：子目标、完成标准、当前状态及证据、距完成的差距（gap）；再说明下一步优先推进哪项、有什么阻塞或需要我决策。目标或边界不明确时标出待确认部分，不把推测当成已确认要求，不扩大范围或重置已有预算。若处于 Codeck 自主轮次中，保持原有轮次和结果协议；本次问询不构成新一轮执行授权。';
export function isProgressPrompt(text) {
  return text === AUTONOMY_PROGRESS_PROMPT || text === PREVIOUS_PROGRESS_PROMPT || text === LEGACY_PROGRESS_PROMPT;
}
export function isAutonomyObservation(text) {
  return isProgressPrompt(text) || /^\/(?:status|usage)$/u.test(text.trim());
}
export const AUTONOMY_DECISIONS = ['按此目标开始', '调整目标或预算', '暂不开始'];

export function autonomyKey({ provider, threadId, tmuxSession }) {
  return JSON.stringify([provider, threadId, tmuxSession]);
}

export function autonomyPresentation(run, session) {
  const needsAnswer = Boolean(run?.requestId && run?.questions?.length);
  const labels = { configuring: needsAnswer ? '待回答' : '配置中',
    confirming: '待确认', switching: '切换中', stopping: '停止中', queued: '待执行', waiting: '等待中',
    blocked: '待处理', paused: '已暂停', completed: '已完成', limit: '已达上限' };
  const active = ['configuring', 'confirming', 'switching', 'queued', 'running', 'waiting', 'blocked'].includes(run?.status);
  const budget = run?.plan || run?.proposal;
  const count = budget ? `${run.round}/${budget.maxRounds}` : '';
  const activity = session?.agent?.question ? '待处理' : session?.hasRunningProcess ? '执行中'
    : session?.agent?.hasBackgroundProcess ? '后台执行中' : '';
  const phase = run && activity && !['configuring', 'confirming', 'switching', 'stopping'].includes(run.status)
    ? [activity, !active && '续跑关闭'].filter(Boolean).join(' · ') : labels[run?.status];
  return {
    text: ['Ⓐ', count, phase].filter(Boolean).join(' '),
    detail: [count, phase].filter(Boolean).join(' '),
    active,
    label: run?.status === 'configuring'
      ? needsAnswer ? '回答自主配置问题' : '暂停自主配置'
      : active ? '暂停自主迭代' : run?.status === 'paused' ? '继续自主迭代' : '配置自主迭代',
  };
}

// Protocol remains in the actual transcript for auditing; Remote shows the prose.
export function autonomyDisplayText(text) {
  return String(text || '')
    .replace(/\n\n<codeck-autonomy-context>\n[\s\S]*$/u, '')
    .replace(/(?:\n|^)```codeck-autonomy\s*\n[\s\S]*$/u, '').trimEnd();
}
