// Shared, local suggestions: no model request or terminal input is needed to open setup.
export function taskPreview(goal) {
  const subject = String(goal || '').trim();
  if (!subject) return { acceptance: '', deliverable: '' };
  if (/性能|吞吐|延迟|performance|latency/i.test(subject)) return {
    acceptance: `对“${subject}”建立同条件基线并比较结果；若指标不明确，先确认吞吐或延迟等关键指标。`,
    deliverable: '最佳已验证候选、前后对比数据及剩余限制。',
  };
  if (/研究|调查|对比|分析|research|compare/i.test(subject)) return {
    acceptance: `围绕“${subject}”比较证据、反例和不确定性，结论可追溯到来源。`,
    deliverable: '研究结论、支持与反对证据、建议及未解决问题。',
  };
  return { acceptance: `验证“${subject}”：先记录起点，再检查改动效果和相关回归，区分原有失败与新问题。`,
    deliverable: '可用改动、对应版本的验证结果及剩余事项。' };
}

export function contextGoals(thread) {
  const goals = [];
  for (const turn of [...(thread?.turns || [])].reverse()) {
    for (const item of [...(turn.items || [])].reverse()) {
      if (item.type !== 'userMessage' || item.delivery) continue;
      const text = typeof item.content === 'string' ? item.content
        : (item.content || []).filter(part => part.type === 'text').map(part => part.text).join('\n');
      if (text.includes('codeck-autonomy') || text.includes('<environment_context>') || text.includes('AGENTS.md')) continue;
      const value = text.trim();
      if (value.length < 8 || value.length > 240 || /^(现在进展怎么样|提交|推送|部署|继续|好的|好，)/u.test(value)) continue;
      if (!goals.includes(value)) goals.push(value);
      if (goals.length === 3) return goals;
    }
  }
  return goals;
}

const plain = value => String(value || '').replace(/\*\*|__/gu, '').replace(/`([^`]+)`/gu, '$1')
  .replace(/^\s*(?:#{1,6}\s+|[-*]\s+)/gmu, '').trim();
const compact = (value, limit = 700) => {
  const text = plain(value).replace(/\s+/gu, ' ');
  if (text.length <= limit) return text;
  const end = text.slice(0, limit).search(/[。；.!?][^。；.!?]*$/u);
  return end > limit / 2 ? text.slice(0, end + 1) : `${text.slice(0, limit - 1)}…`;
};

// Extract the recent task definition, not merely the last user utterance. In
// particular "制定下一阶段目标" is resolved by the plan that follows it. No CLI
// input or new conversation is created, so preparation cannot alter Agent mode.
export function contextDefinition(thread) {
  const entries = (thread?.turns || []).slice(-20).flatMap(turn => turn.items || [])
    .filter(item => !item.delivery && ['userMessage', 'agentMessage'].includes(item.type))
    .map(item => ({ role: item.type, text: item.type === 'agentMessage' ? item.text || ''
      : typeof item.content === 'string' ? item.content : (item.content || []).filter(p => p.type === 'text').map(p => p.text).join('\n') }))
    .filter(item => item.text && !/codeck-autonomy|<environment_context>|AGENTS\.md/u.test(item.text));
  const user = entries.findLastIndex(item => item.role === 'userMessage'
    && !/^(?:现在进展怎么样|提交(?:推送|部署|并|，|$)|推送|部署|继续[。！!\s]*$|好的?[。！!\s]*$)/u.test(item.text.trim()));
  const answer = entries.slice(user + 1).findLast(item => item.role === 'agentMessage');
  const source = answer?.text || '';
  const lines = source.split('\n');
  const label = /^(?:问题定义|当前问题|问题背景|目标|策略|实施策略|执行策略|验证方法|验收方法|预算轮次|预算|轮次|其他|约束|边界)\s*[:：]/u;
  const section = pattern => {
    const start = lines.findIndex(line => pattern.test(plain(line)));
    if (start < 0) return '';
    const inline = plain(lines[start]).replace(pattern, '').replace(/^\s*[:：]\s*/u, '').trim();
    const following = lines.slice(start + 1);
    const stop = following.findIndex(line => /^\s*#{1,6}\s/u.test(line) || label.test(plain(line)));
    return compact([inline, ...(stop < 0 ? following : following.slice(0, stop))].join('\n'));
  };
  const problem = section(/^(?:\d+[.、]\s*)?(?:问题定义|当前问题|问题背景)/u);
  const strategy = section(/^(?:\d+[.、]\s*)?(?:策略|实施策略|执行策略)/u)
    || compact(lines.filter(line => /^\s*#{1,6}\s+\d+[.、]/u.test(line)).map(plain).join(' → '));
  const budget = section(/^(?:\d+[.、]\s*)?(?:预算轮次|预算|轮次)/u);
  const other = section(/^(?:\d+[.、]\s*)?(?:其他|约束|边界)/u);
  const goalHeading = lines.findIndex(line => /^\s*#{1,6}\s+.*(?:目标|计划|方案|[Gg]oal|[Pp]lan)/u.test(line));
  const inlineGoal = section(/^目标\s*[:：]/u);
  if (goalHeading >= 0 || inlineGoal) {
    const after = lines.slice(goalHeading + 1);
    const first = after.findIndex(line => plain(line) && !/^\s*#/u.test(line));
    const body = first < 0 ? [] : after.slice(first);
    const end = body.findIndex((line, index) => index > 0 && (!line.trim() || /^\s*#/u.test(line)));
    const goal = compact(inlineGoal || (end < 0 ? body : body.slice(0, end)).join(' '), 320);
    if (goal.length >= 8) {
      const defaults = taskPreview(goal);
      return { fieldsVersion: 3, goal, problem, strategy, budget, acceptance: section(/^(?:\d+[.、]\s*)?(?:验收方法|验收|完成标准|评价方法|验证方法)/u),
        deliverable: section(/^(?:\d+[.、]\s*)?(?:最终交付|交付|产出|结束后得到)/u) || defaults.deliverable,
        constraints: other || compact(lines.filter(line => /暂不|不得|不要|必须|保持|冻结|不改变|不能|不扩大|不额外/u.test(line)).join('\n'), 1200),
        suggestions: [goal] };
    }
  }
  const goals = contextGoals(thread);
  const text = user >= 0 ? entries[user].text : goals[0] || '';
  // Do not offer a meta request as if it were an actionable goal.
  const goal = /^(?:请|帮我|帮忙)?(?:制定|整理|总结|明确).{0,12}(?:目标|计划|方案)[。？?！!]*$/u.test(text.trim()) ? '' : compact(text, 320);
  return { fieldsVersion: 3, goal, problem, strategy, budget, acceptance: '', constraints: other, suggestions: goal ? [...new Set([goal, ...goals])].slice(0, 3) : [] };
}
