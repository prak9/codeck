import crypto from 'node:crypto';
import { classifyActionRisk } from './always-on-permissions.js';

function slugify(text) {
  const ascii = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const latin = ascii.replace(/[^\x00-\x7f]+/g, '').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  return (latin || `goal-${crypto.randomUUID().slice(0, 8)}`).slice(0, 48);
}

/**
 * Analyze a raw voice/text brain dump into a structured Goal vs Process draft,
 * detect process-as-goal confusion, and generate a one-question-at-a-time interview queue
 * plus edge-case walkthrough scenarios (inspired by Dr Eggbot).
 */
export function analyzeBrainDump({ text, title = '', existingSessions = [] }) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('脑暴内容不能为空');

  const sentences = raw.split(/[。！？\n;；]+/).map(s => s.trim()).filter(Boolean);
  const firstSentence = sentences[0] || raw.slice(0, 80);

  // Detect if user described a step/process instead of an end goal.
  const processOnlyPattern = /^(每天|定时|自动)?(填表|发邮件|跑脚本|抓取|复制|整理|发送|点击|打开)/;
  const processConfusionWarning = processOnlyPattern.test(firstSentence)
    ? '提示：你的首句更偏向“执行步骤（Process）”，建议确认背后的终局业务结果（Goal），以便 Agent 反向优化更高效的做法。'
    : null;

  const inferredTitle = title.trim() || firstSentence.slice(0, 36);
  const slug = slugify(inferredTitle);

  const hasSourceHint = /(数据源|以.+为准|权威|数据库|系统|页面|财报|日志|表)/.test(raw);
  const hasDoneHint = /(完成|验收|确认|通过|核验|收到|落地)/.test(raw);
  const hasEscalationHint = /(审批|确认|请示|高危|人工|通知|打扰)/.test(raw);
  const hasScheduleHint = /(每天|每周|每小时|定时|收到|触发|收盘|早报|晚报|分钟)/.test(raw);

  const matchedSession = existingSessions.find(s => raw.includes(s.name))?.name || null;
  const entityKey = `mission:${slug}`;

  const questions = [];
  if (!hasSourceHint) {
    questions.push({
      id: 'q-source',
      field: 'sourceOfTruth',
      question: '当多个来源（如聊天摘要、邮件和原始数据表）信息冲突时，应该以哪个作为唯一权威源（Source of Truth）？',
      placeholder: '例如：以原始 result.py 报表为准，不以聊天摘要为准',
    });
  }
  if (!hasDoneHint) {
    questions.push({
      id: 'q-done',
      field: 'doneCriteria',
      question: '做到什么客观证据出现，才算这项任务“真正完成”（而不是仅仅发出了消息或跑完一轮）？',
      placeholder: '例如：生成发布页链接并通过核验检查，且写入 workfiles',
    });
  }
  if (!hasEscalationHint) {
    questions.push({
      id: 'q-escalation',
      field: 'tacitRulesMd',
      question: '遇到哪类边界或高风险动作时，必须先挂起审批（Deferred Approval）等你拍板，而不是擅自执行？',
      placeholder: '例如：对外发消息、公网分享、修改生产配置前必须挂起审批',
    });
  }
  if (!hasScheduleHint) {
    questions.push({
      id: 'q-cadence',
      field: 'scheduleHint',
      question: '希望它按什么节奏触发（例如每 60 分钟巡检、每天固定时间，还是仅在特定事件到来时触发）？',
      placeholder: '例如：每 60 分钟预检一次，无变化保持静默',
    });
  }

  const edgeCases = [
    {
      id: 'case-conflict',
      title: '异常演练 1：上游数据源缺失或口径冲突',
      scenario: '触发时发现上游数据尚未落盘，或两个来源数值不一致。',
      proposedHandling: '不编造结论，不强行交付；记录静默/警告日志并自动设一个 15 分钟后的 Follow-up 复查。',
    },
    {
      id: 'case-external',
      title: '异常演练 2：需要执行外部不可逆动作',
      scenario: '流程推进到公网分享或对外发送通知步骤。',
      proposedHandling: '触发 Deferred Approval 挂起卡片，立即释放 Worker，待你在普通/Remote/Telegram 点批准后恢复。',
    },
  ];

  const draft = {
    slug,
    title: inferredTitle,
    goal: firstSentence,
    processMd: sentences.length > 1
      ? sentences.slice(1).map((s, i) => `${i + 1}. ${s}`).join('\n')
      : `1. 核对权威数据源与现状\n2. 执行核心分析/处理并保留证据\n3. 按分级策略写入 Outbox 或发布页`,
    tacitRulesMd: hasEscalationHint
      ? `- 遵循脑暴中明确的风险边界\n- 外部不可逆操作前必须挂起审批`
      : `- 遇到口径冲突时优先核对权威源\n- 外部不可逆操作、公网分享或超预算前必须挂起审批`,
    sourceOfTruth: hasSourceHint ? '按脑暴中指定的原始数据源为准' : '待访谈确认（优先原始文件/数据库而非聊天摘要）',
    doneCriteria: hasDoneHint ? '按脑暴中指定的客观验收条件为准' : '产出可核验的成果记录或发布页链接（本轮回复结束不算完成）',
    feedbackSources: ['page_annotation', 'approval_rejection', 'timer_error'],
    entityKey,
    targetSession: matchedSession,
    status: 'paused',
  };

  return {
    restatement: `目标（Goal）：${draft.goal}\n当前流程（Process）：\n${draft.processMd}`,
    processConfusionWarning,
    draft,
    questions,
    edgeCases,
  };
}

export function renderBlueprintMarkdown(bp) {
  return [
    `# 目标蓝图：${bp.title}`,
    '',
    `- slug: \`${bp.slug}\``,
    `- entity_key: \`${bp.entityKey}\``,
    `- status: ${bp.status}`,
    `- version: v${bp.version}`,
    ...(bp.targetSession ? [`- target_session: \`${bp.targetSession}\``] : []),
    '',
    '## Goal（终局目标）',
    bp.goal,
    '',
    '## Process（当前流程）',
    bp.processMd || '（待补充）',
    '',
    '## Tacit Rules & Source of Truth（隐性判断与权威源）',
    `- 权威数据源：${bp.sourceOfTruth || '未指定'}`,
    bp.tacitRulesMd || '',
    '',
    '## Done Criteria（真正完成标准）',
    bp.doneCriteria || '需提供可核验的成果证据',
    '',
    '## Feedback Sources（反馈来源）',
    ...(bp.feedbackSources?.length ? bp.feedbackSources.map(s => `- ${s}`) : ['- 暂无']),
    '',
  ].join('\n');
}

export async function materializeBlueprint({ store, memory = null, draft, recurrenceMs = null, now = Date.now() }) {
  const bp = store.putBlueprint({ ...draft, now });
  if (memory) {
    await memory.writeFile(`blueprints/${bp.slug}.md`, renderBlueprintMarkdown(bp));
  }
  store.addEntityLink({
    entityKey: bp.entityKey,
    refType: 'blueprint',
    refId: bp.id,
    summary: `实例化蓝图 ${bp.title} (v${bp.version}, ${bp.status})`,
    meta: { slug: bp.slug, status: bp.status, version: bp.version },
    now,
  });

  let timer = null;
  if (Number.isFinite(recurrenceMs) && recurrenceMs >= 10_000) {
    timer = store.putTimer({
      id: `bp-${bp.slug}`,
      kind: 'schedule',
      scopeKey: bp.targetSession ? `session:${bp.targetSession}` : 'butler',
      dueAt: now + recurrenceMs,
      recurrenceMs,
      reason: `[Blueprint:${bp.slug}] ${bp.goal}`,
      sessionName: bp.targetSession || null,
      payload: { blueprintSlug: bp.slug, entityKey: bp.entityKey, priority: 'digest' },
      status: bp.status === 'active' ? 'active' : 'paused',
      now,
    });
    store.addEntityLink({
      entityKey: bp.entityKey,
      refType: 'timer',
      refId: timer.id,
      summary: `绑定周期定时器（每 ${Math.round(recurrenceMs / 60_000)} 分钟，初始 ${timer.status}）`,
      meta: { timerId: timer.id, recurrenceMs },
      now,
    });
  }
  return { blueprint: bp, timer };
}

/**
 * Read-only Dry-Run simulation: evaluates baseline memory, entity history,
 * session readiness, and risk gate WITHOUT mutating external state or sending Outbox.
 */
export async function runBlueprintDryRun({ store, memory = null, blueprint, listSessions = async () => [], now = Date.now() }) {
  const baseline = memory ? await memory.readBaseline() : { withinBudget: true, bytes: 0, reported: '' };
  const timeline = store.listEntityLinks({ entityKey: blueprint.entityKey, limit: 10 });
  const sessions = await listSessions();
  const target = blueprint.targetSession ? sessions.find(s => s.name === blueprint.targetSession) : null;

  const warnings = [];
  if (!blueprint.sourceOfTruth || blueprint.sourceOfTruth.includes('待访谈')) {
    warnings.push('权威数据源（Source of Truth）尚未明确指定');
  }
  if (!blueprint.doneCriteria || blueprint.doneCriteria.includes('未指定')) {
    warnings.push('真正完成标准（Done Criteria）仍较宽泛');
  }
  if (blueprint.targetSession && !target) {
    warnings.push(`绑定的目标会话 "${blueprint.targetSession}" 当前不在运行中`);
  }
  if (!baseline.withinBudget) {
    warnings.push(`个人记忆基线体积超预算（${baseline.bytes} B），建议先运行 Dreaming 整理`);
  }

  const predictedRisk = /(分享|外发|删除|强推|重启|生产)/.test(`${blueprint.goal}\n${blueprint.processMd}`)
    ? classifyActionRisk({ kind: 'external_send' })
    : 'allow';

  const predictedActions = [
    `1. 加载个人基线记忆（${baseline.bytes} B，预算内：${baseline.withinBudget ? '是' : '否'}）`,
    `2. 核对权威源：${blueprint.sourceOfTruth || '未指定'}（关联实体 ${blueprint.entityKey} 已有 ${timeline.length} 条历史记录）`,
    target
      ? `3. 派发至会话 ${target.name}（${target.agent?.kind || 'shell'}，当前状态 ${target.executionState || 'unknown'}）`
      : `3. 由按需 Butler 编排层直接执行并校验完成标准`,
    predictedRisk === 'defer'
      ? `4. 检测到高风险外部动作关键词 → 预计触发 Deferred Approval 挂起审批（不会擅自执行）`
      : `4. 预计按 digest 优先级写入 Outbox（无变化时保持 silent）`,
  ];

  return {
    dryRun: true,
    sideEffectsExecuted: false,
    blueprintSlug: blueprint.slug,
    blueprintVersion: blueprint.version,
    entityKey: blueprint.entityKey,
    predictedRisk,
    warnings,
    predictedActions,
    timelineSampleCount: timeline.length,
    simulatedAt: now,
  };
}
