export const AUTONOMY_PROGRESS_PROMPT = '现在进展怎么样？请简要说明你理解的目标、当前进展、剩余事项和阻塞。不打断当前节奏，不续跑、不改方向、模式或预算。';

export const AUTONOMY_PLANNING_PROMPT = `请基于最近的讨论，为我规划一个自主迭代任务。

先简要说明：要达到什么目标、如何推进和验证、有哪些预算与边界，以及第一步做什么。区分已完成事项和待推进工作；预算未指定就不设默认值，范围与权限沿用当前项目要求，不自行扩大。

规划保持简短，不输出 JSON，不要求我逐项填写。完成规划后，询问我“按此计划开始、调整计划，还是取消？”有原生提问工具就使用，否则直接在对话中询问。确认前不执行任务。

我确认后，请进入自主迭代模式：

1. 检查项目指令和可用的相关 Skill，了解已有代码、资料及历史尝试，必要时复现问题或建立基线。
2. 自主探索解法、提出假设、设计实验、实施改动并验证。每轮围绕一个有价值的问题，明确预期观察和验证方式，优先低成本试验。
3. 根据证据调整方向。改善结果和减少关键不确定性都算进展；记录失败结论，避免重复尝试。一次失败不应直接结束，连续无收益时应重新检查假设、换方法。
4. 严格验证，区分事实、推断和未验证设想。证据对应具体版本；不能降低验收标准、削弱测试或改变评价口径制造成功。保留最佳已验证成果，隔离未完成尝试。
5. 在目标、预算和授权范围内自行推进，不反复询问是否继续。缺少信息先自行查证；只有无法自行解决且会实质改变目标、权限或验收的问题才询问我。
6. 正常回应我的提问和方向调整；进度问询不代表停止，也不重置预算。收到停止要求后，不再启动新实验。
7. 达标即可结束；未指定改善阈值的优化任务，在预算内交付最佳已验证结果，不自行编造达标阈值。预算耗尽、用户中止，或经过诊断与替代尝试仍受阻时，停止并明确结束原因。
8. 每轮简要记录尝试、证据、结论和下一步，为最终验证与交接留出预算。

无论如何结束，都输出简洁交接：目标、结束原因和预算使用；已验证成果及版本、证据位置；未完成或未验证的尝试；主要探索方向与结论；下一步、恢复方式及遗留运行任务。不要把运行结束等同于任务成功。

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
