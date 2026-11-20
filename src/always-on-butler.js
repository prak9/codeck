import crypto from 'node:crypto';

/**
 * Ephemeral, toggleable Butler orchestrator (Scheme A: no fixed resident control session).
 * Wakes briefly on `butler` scope events, loads lean baseline memory, decides whether to
 * stay silent, emit digest/notify, schedule a follow-up, or delegate to an idle specialist session.
 */
export function createButlerOrchestrator({
  store,
  memory,
  outboxDispatcher = null,
  listSessions = async () => [],
  dispatchSession = null,
  planner = null,
  enabled = true,
  now = Date.now,
}) {
  let active = Boolean(enabled);

  function isEnabled() {
    return active;
  }

  function setEnabled(next) {
    active = Boolean(next);
    return active;
  }

  async function defaultPlan({ batch, baseline, sessions }) {
    const actions = [];
    for (const event of batch) {
      const payload = event.payload || {};
      if (payload.action === 'dream') {
        actions.push({ type: 'dream' });
        continue;
      }
      if (payload.action === 'digest') {
        actions.push({ type: 'digest', title: payload.title || '个人每日简报' });
        continue;
      }
      if (payload.delegateSession && payload.prompt) {
        actions.push({
          type: 'delegate',
          eventId: event.id,
          sessionName: payload.delegateSession,
          prompt: payload.prompt,
          followUpMs: payload.followUpMs || null,
          followUpReason: payload.followUpReason || null,
        });
        continue;
      }
      const summary = payload.reason || payload.text || `收到 ${event.source} 事件`;
      // Avoid duplicate notification if already in reported.md
      if (baseline.reported.includes(summary)) {
        actions.push({ type: 'outbox', priority: 'silent', title: '重复事件已静默', contentMd: summary, dedupeKey: `butler:silent:${event.id}` });
      } else {
        const priority = payload.priority || (event.source === 'approval_resolved' ? 'notify' : 'digest');
        actions.push({
          type: 'outbox',
          priority,
          channel: payload.channel || 'web',
          title: payload.title || `Butler 摘要（${event.source}）`,
          contentMd: summary,
          dedupeKey: `butler:${event.id}`,
          meta: { eventId: event.id, activeSessions: sessions.length },
        });
      }
    }
    return actions;
  }

  async function handleBatch(batch, helpers) {
    if (!active) {
      return { status: 'done', skipped: true, reason: 'Butler 已停用' };
    }
    const baseline = await memory.readBaseline();
    const sessions = await listSessions();
    const planFn = planner || defaultPlan;
    const actions = await planFn({ batch, baseline, sessions, now: now() });
    const results = [];

    for (const action of actions) {
      if (action.type === 'dream') {
        const report = await memory.runDreaming({ now: now() });
        store.enqueueOutbox({
          scopeKey: 'butler',
          priority: 'silent',
          channel: 'web',
          dedupeKey: `dream:${now()}`,
          title: '夜间 Dreaming 整理完成',
          contentMd: `归档 ${report.archived.length} 份进度，去重 ${report.dedupedNotes.length} 份笔记。`,
          meta: report,
          now: now(),
        });
        results.push({ type: 'dream', report });
      } else if (action.type === 'digest' && outboxDispatcher) {
        const digest = await outboxDispatcher.compileDigest({ title: action.title });
        results.push({ type: 'digest', digest });
      } else if (action.type === 'delegate' && dispatchSession) {
        const session = sessions.find(s => s.name === action.sessionName);
        if (!session) {
          store.enqueueOutbox({
            scopeKey: 'butler',
            priority: 'notify',
            channel: 'web',
            dedupeKey: `delegate-missing:${action.eventId || crypto.randomUUID()}`,
            title: `无法派发至会话 ${action.sessionName}`,
            contentMd: '目标会话不存在，未执行派发。',
            now: now(),
          });
          results.push({ type: 'delegate', status: 'missing' });
          continue;
        }
        const commandId = `butler-${crypto.randomUUID()}`;
        if (action.eventId) helpers?.markSubmitting?.(commandId, [action.eventId]);
        await dispatchSession({ session, prompt: action.prompt, commandId });
        if (action.followUpMs && action.followUpMs > 0) {
          store.putTimer({
            kind: 'follow_up',
            scopeKey: `session:${session.name}`,
            dueAt: now() + action.followUpMs,
            reason: action.followUpReason || `跟进派发任务（${commandId}）`,
            sessionName: session.name,
            provider: session.agent?.kind || null,
            threadId: session.agent?.id || null,
            now: now(),
          });
        }
        results.push({ type: 'delegate', status: 'dispatched', commandId });
      } else if (action.type === 'outbox') {
        const enq = store.enqueueOutbox({
          scopeKey: 'butler',
          priority: action.priority || 'digest',
          channel: action.channel || 'web',
          dedupeKey: action.dedupeKey || null,
          title: action.title || 'Butler 通知',
          contentMd: action.contentMd || '',
          meta: action.meta || {},
          deliverAfter: now(),
          now: now(),
        });
        results.push({ type: 'outbox', inserted: enq.inserted, id: enq.item?.id });
      }
    }

    return { status: 'done', actions: results };
  }

  return {
    isEnabled,
    setEnabled,
    handleBatch,
  };
}
