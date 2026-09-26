export const AUTONOMY_PROGRESS_PROMPT = '现在进展怎么样？请简要说明你理解的目标、当前进展、剩余事项和阻塞。不打断当前节奏，不续跑、不改方向、模式或预算。';

export const AUTONOMY_PLANNING_PROMPT = `请基于最近的讨论，为我规划一个自主迭代任务。

先基于最近的讨论，简要整理任务参数：目标（希望得到的结果）、预算（时间、费用或其他资源上限）、评价标准（如何判断有效或完成）、范围与约束（允许修改的范围、必须保持的条件），以及第一步。区分已完成事项和待推进工作；预算未指定就不设默认值，评价标准未指定时根据目标建立，范围与权限沿用当前项目要求，不自行扩大。

规划保持简短，不输出 JSON，不要求我逐项填写。完成规划后，询问我“按此计划开始、调整计划，还是取消？”有原生提问工具就使用，否则直接在对话中询问。确认前不执行任务。

我确认后，请进入自主迭代模式。在目标、预算和授权范围内，自主探索方向、提出假设、设计实验、实施改动并验证结果，持续推进任务。先简要说明对目标、评价方式和第一步的理解，然后直接执行：

1. 先理解问题，建立起点。检查项目指令、可用的相关 Skill、已有代码、资料和历史尝试，明确当前状态、关键不确定性及验证方法。必要时复现问题或测量基线。规划保持简短，尽快获得真实反馈，并据新证据调整计划。
2. 主动探索有潜力的方向。寻找替代解释和不同解法，审视隐含假设。优化和探索任务既考虑局部改进，也考虑机制不同的方案；允许在隔离、可回退且成本可控的条件下大胆尝试，所有探索都应服务于目标。
3. 每轮回答一个有价值的问题。行动前简要明确为什么值得尝试、预期观察、验证方法，以及什么结果会否定这个想法。先用低成本实验筛选方向，再投入有希望的候选。实验可以是代码改动，也可以是测量、诊断、资料检索、对照或消融。
4. 根据证据学习并改变路线。目标改善和关键不确定性减少都算进展。失败实验留下结论，避免重复踩坑。连续无收益时重新检查问题定义、瓶颈和假设，换方法或方向；不要仅因一次失败就结束，也不要在缺乏新理由时重复微调。
5. 严格验证，保留可靠成果。用实际执行结果评价改动，区分事实、推断和未验证设想。证据对应具体代码版本，必要时复测并检查其他约束。不能降低验收标准、削弱测试或改变评价口径制造成功。分别保存最佳已验证结果与当前尝试，失败探索不得覆盖已有成果。
6. 自主推进，合理分配预算。范围内常规、可逆工作自行决策，不反复询问是否继续。信息不足时先查资料或做小实验；只有无法自行解决且会实质改变目标、授权边界或验收判断时才提问。关注剩余预算，为最终验证和交接留出余量。正常回应我的提问和方向调整；进度问询不代表停止，也不重置预算。
7. 准确判断何时结束。明确验收目标达成后即可结束；未指定改善阈值的优化任务，在预算内寻找并交付最佳已验证结果，不自行编造达标阈值。预算到限、用户要求停止，或经过诊断与替代尝试仍因必要条件缺失而无法推进时，停止自主工作。区分目标完成、预算耗尽、用户中止和受阻，不把运行结束表述为任务成功。
8. 持续记录，随时可交接。每轮简要记录尝试、证据、学到的结论和下一步，避免重复叙述。收到停止指令后不再启动新实验，保存当前状态并生成交接说明。

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
