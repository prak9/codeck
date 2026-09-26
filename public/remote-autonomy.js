export const AUTONOMY_PROGRESS_PROMPT = '现在进展怎么样？请简要说明你理解的目标、当前进展、剩余事项和阻塞。不打断当前节奏，不续跑、不改方向、模式或预算。';

export const AUTONOMY_PLANNING_PROMPT = `请基于最近的讨论，使用 iterate skill，为我规划一个自主迭代任务。先读取该 Skill，并结合项目指令及相关领域 Skill。

简要整理目标、预算、评价标准、范围与约束，以及第一步。区分已完成事项和待推进工作；预算未指定就不设默认值，评价标准未指定时根据目标建立，范围与权限沿用当前项目要求，不自行扩大。

规划保持简短，用自然语言表达，不输出 JSON，不要求我逐项填写。完成后询问我：“按此计划开始、调整计划，还是取消？”有原生提问工具就使用，否则直接在对话中询问。确认前不执行任务。

我确认后，按照 iterate skill，在约定的目标、预算和授权范围内自主推进，并执行其探索、验证、成果保留、预算管理和交接要求。

正常回应我的提问和方向调整；进度问询不代表停止，也不重置预算。收到停止要求后，按 Skill 保存状态并交接。无论自主结束还是用户中止，都在对话中输出简洁清晰的进展、结果和下一步，不只更新状态。

现在只给出简短计划，并等待我确认。`;

export function isProgressPrompt(text) {
  return text === AUTONOMY_PROGRESS_PROMPT;
}
export function isAutonomyObservation(text) {
  return isProgressPrompt(text) || /^\/(?:status|usage)$/u.test(text.trim());
}

export function autonomyKey({ provider, threadId, tmuxSession }) {
  return JSON.stringify([provider, threadId, tmuxSession]);
}

// A tracks the task lifecycle, not whether the CLI is currently busy. Keep this
// presentation separate from execution/stop controls and the latched A colors.
export function autonomyExecutionLabel(run, execution, waitingForInput = false) {
  if (waitingForInput || execution === 'waitingForInput') return '等待你的回答';
  if (!['running', 'exiting'].includes(run?.status)) return null;
  return ({ working: '自主执行中', background: '自主后台运行',
    done: '自主模式·当前空闲', idle: '自主模式·当前空闲' })[execution] || null;
}

export function autonomyPresentation(run) {
  const active = ['running', 'exiting'].includes(run?.status);
  const resettable = active || ['ended', 'completed', 'error'].includes(run?.status);
  const phase = ({ running: '执行中', exiting: '总结退出中',
    planning: '等待确认', ended: '执行已结束，未报告完成', completed: '目标完成', error: '执行出错', off: '已退出' })[run?.status] || '';
  return {
    text: ['Ⓐ', phase].filter(Boolean).join(' '),
    detail: phase,
    progress: '',
    active, resettable,
    tone: run?.status === 'completed' ? 'completed' : run?.status === 'error' ? 'error' : active || run?.status === 'ended' ? 'running' : 'idle',
    label: active ? '中断并恢复默认状态' : resettable ? '恢复默认状态' : '请 Agent 规划自主任务',
  };
}

// Protocol remains in the actual transcript for auditing; Remote shows the prose.
export function autonomyDisplayText(text) {
  return String(text || '')
    .replace(/\n\n<codeck-autonomy-context>\n[\s\S]*$/u, '')
    .replace(/(?:\n|^)```codeck-autonomy[^\S\n]*\n[\s\S]*?(?:\n```(?=\n|$)|$)/gu, '\n')
    .replace(/(?:\n|^)```codeck-autonomy[^\S\n]*$/u, '').trimEnd();
}
