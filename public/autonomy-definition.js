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
