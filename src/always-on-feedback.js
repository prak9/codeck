import { renderBlueprintMarkdown } from './always-on-architect.js';

/**
 * Feedback-driven process evolution engine (NODE-003).
 * Correlates entity timelines, timer errors, and rejected approvals to propose
 * human-reviewed Blueprint improvements — NEVER silently mutating active workflows.
 */
export function generateImprovementProposals({ store, now = Date.now() }) {
  const blueprints = store.listBlueprints({ limit: 100 }).filter(bp => bp.status !== 'archived');
  const existingProposals = store.listProposals({ limit: 200 });
  const timers = store.listTimers({});
  const approvals = store.listApprovals({ limit: 100 });
  const created = [];

  function alreadyProposed(blueprintId, title) {
    return existingProposals.some(p => p.blueprintId === blueprintId && p.title === title && p.status !== 'accepted');
  }

  for (const bp of blueprints) {
    // Signal 1: Bound timer has repeated check errors -> suggest hardening check/delay
    const boundTimers = timers.filter(t => t.payload?.blueprintSlug === bp.slug || t.id === `bp-${bp.slug}`);
    for (const timer of boundTimers) {
      if (timer.lastStatus === 'check_error') {
        const title = `加固定时器预检脚本（${timer.id}）`;
        if (!alreadyProposed(bp.id, title)) {
          const proposal = store.createProposal({
            blueprintId: bp.id,
            entityKey: bp.entityKey,
            title,
            rationale: `定时器 ${timer.id} 最近一次预检失败（${timer.lastError || '未知错误'}），建议在隐性规则中补充数据源就绪检查与延迟重试策略。`,
            suggestedPatch: {
              tacitRulesAppend: `- 预检脚本异常时不强行执行，延后重试并核对上游落盘状态（来源：${timer.id}）`,
            },
            now,
          });
          created.push(proposal);
        }
      }
    }

    // Signal 2: Rejected approvals linked to this blueprint's session/scope -> capture tacit rule
    const rejected = approvals.filter(a =>
      a.status === 'rejected'
      && ((bp.targetSession && a.sessionName === bp.targetSession) || a.scopeKey === `session:${bp.targetSession}` || a.action?.blueprintSlug === bp.slug));
    for (const apr of rejected) {
      const title = `沉淀审批拒绝规则：${apr.summary.slice(0, 32)}`;
      if (!alreadyProposed(bp.id, title)) {
        const noteText = apr.decisionNote ? `用户备注：${apr.decisionNote}` : '用户拒绝了该高风险动作';
        const proposal = store.createProposal({
          blueprintId: bp.id,
          entityKey: bp.entityKey,
          title,
          rationale: `历史审批「${apr.summary}」被拒绝（${noteText}），建议将此边界固化到蓝图的隐性规则中，避免重复触发同类越界请求。`,
          suggestedPatch: {
            tacitRulesAppend: `- 禁止未经明确授权执行「${apr.summary}」${apr.decisionNote ? `（${apr.decisionNote}）` : ''}`,
          },
          now,
        });
        created.push(proposal);
      }
    }

    // Signal 3: Recent feedback/collector events under the same entity_key
    const links = store.listEntityLinks({ entityKey: bp.entityKey, limit: 30 });
    const feedbackLinks = links.filter(l => ['feedback', 'annotation', 'collector'].includes(l.refType));
    if (feedbackLinks.length >= 2) {
      const title = `吸收 ${feedbackLinks.length} 条实体反馈优化流程`;
      if (!alreadyProposed(bp.id, title)) {
        const snippets = feedbackLinks.slice(0, 3).map(l => l.summary).join('；');
        const proposal = store.createProposal({
          blueprintId: bp.id,
          entityKey: bp.entityKey,
          title,
          rationale: `实体 ${bp.entityKey} 已累积 ${feedbackLinks.length} 条反馈/采集记录（${snippets}），建议更新蓝图流程或验收清单。`,
          suggestedPatch: {
            processAppend: `- 结合近期反馈复核要点：${snippets}`,
          },
          now,
        });
        created.push(proposal);
      }
    }
  }

  return { generated: created.length, proposals: created };
}

export async function resolveImprovementProposal({ store, memory = null, id, decision, note = null, now = Date.now() }) {
  if (!['accepted', 'rejected'].includes(decision)) throw new Error('提案结论仅支持 accepted 或 rejected');
  const resolved = store.resolveProposal(id, { status: decision, decisionNote: note, now });
  if (!resolved) return null;

  let updatedBlueprint = null;
  if (decision === 'accepted' && resolved.blueprintId) {
    const bp = store.getBlueprintById(resolved.blueprintId);
    if (bp) {
      const patch = resolved.suggestedPatch || {};
      const nextProcess = patch.processAppend
        ? `${bp.processMd ? `${bp.processMd}\n` : ''}${patch.processAppend}`
        : bp.processMd;
      const nextRules = patch.tacitRulesAppend
        ? `${bp.tacitRulesMd ? `${bp.tacitRulesMd}\n` : ''}${patch.tacitRulesAppend}`
        : bp.tacitRulesMd;
      updatedBlueprint = store.putBlueprint({
        ...bp,
        processMd: nextProcess,
        tacitRulesMd: nextRules,
        now,
      });
      if (memory) {
        await memory.writeFile(`blueprints/${updatedBlueprint.slug}.md`, renderBlueprintMarkdown(updatedBlueprint));
      }
      store.addEntityLink({
        entityKey: updatedBlueprint.entityKey,
        refType: 'proposal',
        refId: resolved.id,
        summary: `采纳改进提案：${resolved.title} → 蓝图升级至 v${updatedBlueprint.version}`,
        meta: { proposalId: resolved.id, version: updatedBlueprint.version },
        now,
      });
    }
  } else if (decision === 'rejected' && memory) {
    // Record rejected proposal in notes so future reviews respect the decision.
    let prev = '# 已忽略的改进提案\n\n';
    try { prev = (await memory.readFile('notes/rejected-proposals.md')).content; } catch { /* first write */ }
    const line = `- [${new Date(now).toISOString()}] ${resolved.title}${note ? `（原因：${note}）` : ''}`;
    if (!prev.includes(resolved.title)) {
      await memory.writeFile('notes/rejected-proposals.md', `${prev.trimEnd()}\n${line}\n`);
    }
  }

  return { proposal: resolved, blueprint: updatedBlueprint };
}

function escapeHtml(text) {
  return String(text ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Generates a self-contained, zero-external-script HTML Micro-Collector page
 * compatible with Codeck Published Pages. Submissions POST directly to
 * /api/always-on/collectors/:slug/submit (owner auth) and correlate via entityKey.
 */
export function buildMicroCollectorHtml({ slug, title, entityKey, fields = [] }) {
  const safeFields = (Array.isArray(fields) && fields.length ? fields : [
    { name: 'observation', label: '观察 / 进展记录', type: 'textarea', required: true },
    { name: 'outcome', label: '结果评价（好 / 一般 / 需改进）', type: 'text', required: false },
  ]).slice(0, 12);

  const inputsHtml = safeFields.map(f => {
    const name = escapeHtml(f.name || 'field');
    const label = escapeHtml(f.label || name);
    const req = f.required ? ' required' : '';
    if (f.type === 'textarea') {
      return `<label><span>${label}</span><textarea name="${name}" rows="4"${req}></textarea></label>`;
    }
    const type = ['text', 'number', 'date', 'time'].includes(f.type) ? f.type : 'text';
    return `<label><span>${label}</span><input type="${type}" name="${name}"${req}></label>`;
  }).join('\n');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} — 数据采集页</title>
<style>
  body{margin:0;padding:20px;background:#0f172a;color:#e2e8f0;font-family:system-ui,-apple-system,sans-serif;}
  main{max-width:560px;margin:0 auto;background:#1e293b;border:1px solid #334155;border-radius:14px;padding:18px;}
  h1{margin:0 0 6px;font-size:18px;}
  .meta{color:#94a3b8;font-size:12px;margin:0 0 16px;}
  form{display:flex;flex-direction:column;gap:12px;}
  label{display:flex;flex-direction:column;gap:6px;font-size:13px;}
  input,textarea{background:#020617;color:#f8fafc;border:1px solid #475569;border-radius:8px;padding:8px 10px;font:inherit;}
  button{background:#2563eb;color:#fff;border:0;border-radius:8px;padding:10px 14px;font:inherit;font-weight:600;cursor:pointer;}
  #status{font-size:13px;color:#93c5fd;min-height:18px;margin:4px 0 0;}
</style>
</head>
<body>
<main>
  <h1>${escapeHtml(title)}</h1>
  <p class="meta">实体标识：<code>${escapeHtml(entityKey)}</code> · 提交后直接写入 Codeck Event Inbox</p>
  <form id="collectorForm">
    ${inputsHtml}
    <button type="submit">提交记录</button>
    <p id="status" role="status"></p>
  </form>
</main>
<script>
const form = document.getElementById('collectorForm');
const statusEl = document.getElementById('status');
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const token = localStorage.getItem('codeck-token') || sessionStorage.getItem('codeck-token') || '';
  const data = Object.fromEntries(new FormData(form).entries());
  statusEl.textContent = '正在提交…';
  try {
    const res = await fetch('/api/always-on/collectors/${encodeURIComponent(slug)}/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: JSON.stringify({ entityKey: ${JSON.stringify(entityKey)}, data }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || '提交失败');
    statusEl.textContent = '已记录并关联至实体 ' + body.entityKey;
    form.reset();
  } catch (err) {
    statusEl.textContent = err.message;
  }
});
</script>
</body>
</html>`;
}
