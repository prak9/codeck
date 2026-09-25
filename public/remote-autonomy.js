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

export function autonomyKey({ provider, threadId, tmuxSession }) {
  return JSON.stringify([provider, threadId, tmuxSession]);
}

export function autonomyPresentation(run) {
  const active = ['running', 'exiting'].includes(run?.status);
  const budget = run?.plan;
  const count = budget ? `${run.round}/${budget.maxRounds ?? '∞'}` : '';
  const phase = ({ configuring: '设置目标', running: '执行中', exiting: '总结退出中',
    completed: '目标完成', error: '执行出错', off: '已退出' })[run?.status] || '';
  return {
    text: ['Ⓐ', count, phase].filter(Boolean).join(' '),
    detail: [count, phase].filter(Boolean).join(' '),
    progress: budget ? budget.maxRounds == null ? String(run.round) : count : '',
    active,
    tone: run?.status === 'completed' ? 'completed' : run?.status === 'error' ? 'error' : active ? 'running' : 'idle',
    label: active ? '中断并退出自主模式' : '设置自主目标',
  };
}

// Protocol remains in the actual transcript for auditing; Remote shows the prose.
export function autonomyDisplayText(text) {
  return String(text || '')
    .replace(/\n\n<codeck-autonomy-context>\n[\s\S]*$/u, '')
    .replace(/(?:\n|^)```codeck-autonomy[^\S\n]*\n[\s\S]*?(?:\n```(?=\n|$)|$)/gu, '\n')
    .replace(/(?:\n|^)```codeck-autonomy[^\S\n]*$/u, '').trimEnd();
}
