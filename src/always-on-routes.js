import { parseDurationMs } from './always-on-runtime.js';
import { analyzeBrainDump, materializeBlueprint, runBlueprintDryRun } from './always-on-architect.js';
import { buildMicroCollectorHtml, generateImprovementProposals, resolveImprovementProposal } from './always-on-feedback.js';

export function mountAlwaysOnRoutes(app, {
  store,
  runtime,
  memory,
  outboxDispatcher,
  butler,
  approvalGate,
  credentialProxy,
  listSessions = async () => [],
  publishCollectorPage = null,
  resolveSessionTarget,
  ownerOnly,
}) {
  app.get('/api/always-on/overview', ownerOnly, (_req, res) => {
    res.json({
      butlerEnabled: butler ? butler.isEnabled() : false,
      stats: store.stats(),
      timers: store.listTimers({ status: 'active' }).slice(0, 20),
      pendingApprovals: store.listApprovals({ status: 'pending', limit: 20 }),
      pendingProposals: store.listProposals({ status: 'pending', limit: 20 }),
      blueprints: store.listBlueprints({ limit: 20 }),
      recentOutbox: store.listOutbox({ limit: 20 }),
      proxyServices: credentialProxy ? credentialProxy.listServices() : [],
    });
  });

  app.get('/api/always-on/events', ownerOnly, (req, res, next) => {
    try {
      const limit = Number(req.query.limit || 50);
      res.json({
        events: store.listEvents({
          scopeKey: req.query.scopeKey || null,
          status: req.query.status || null,
          limit: Number.isFinite(limit) ? limit : 50,
        }),
      });
    } catch (error) { next(error); }
  });

  app.post('/api/always-on/events', ownerOnly, async (req, res, next) => {
    try {
      const body = req.body || {};
      const result = await runtime.enqueueAndWake({
        scopeKey: body.scopeKey || 'butler',
        source: body.source || 'web',
        dedupeKey: body.dedupeKey ?? null,
        payload: body.payload ?? {},
      });
      res.status(result.inserted ? 202 : 200).json(result);
    } catch (error) { next(error); }
  });

  app.get('/api/always-on/timers', ownerOnly, (req, res, next) => {
    try {
      res.json({
        timers: store.listTimers({
          status: req.query.status || null,
          kind: req.query.kind || null,
          scopeKey: req.query.scopeKey || null,
        }),
      });
    } catch (error) { next(error); }
  });

  app.post('/api/always-on/timers/followup', ownerOnly, async (req, res, next) => {
    try {
      const body = req.body || {};
      let dueAt = null;
      if (body.in !== undefined) {
        const ms = parseDurationMs(body.in);
        if (!ms) return res.status(400).json({ error: '无效的延迟时长，请使用如 30s、15m、2h、1d' });
        dueAt = Date.now() + ms;
      } else if (body.at) {
        const parsed = Date.parse(body.at);
        if (!Number.isFinite(parsed)) return res.status(400).json({ error: '无效的绝对时间格式' });
        dueAt = parsed;
      } else {
        return res.status(400).json({ error: '请指定 --in 延迟时长或 --at 绝对时间' });
      }

      let target = null;
      if (body.session && resolveSessionTarget) {
        target = await resolveSessionTarget(body.session);
      }
      const scopeKey = body.scopeKey || (target ? `session:${target.tmuxSession}` : 'butler');
      const timer = store.putTimer({
        id: body.id,
        kind: 'follow_up',
        scopeKey,
        dueAt,
        reason: body.reason,
        sessionName: target?.tmuxSession || body.session || null,
        provider: target?.provider || null,
        threadId: target?.threadId || null,
        payload: body.payload || {},
      });
      res.status(201).json(timer);
    } catch (error) { next(error); }
  });

  app.patch('/api/always-on/timers/:id', ownerOnly, (req, res, next) => {
    try {
      const action = req.body?.action;
      if (!['pause', 'resume'].includes(action)) return res.status(400).json({ error: 'action 仅支持 pause 或 resume' });
      const updated = store.updateTimerState(req.params.id, { status: action === 'pause' ? 'paused' : 'active' });
      if (!updated) return res.status(404).json({ error: '定时器不存在' });
      res.json(updated);
    } catch (error) { next(error); }
  });

  app.delete('/api/always-on/timers/:id', ownerOnly, (req, res, next) => {
    try {
      const removed = store.removeTimer(req.params.id);
      if (!removed) return res.status(404).json({ error: '定时器不存在' });
      res.sendStatus(204);
    } catch (error) { next(error); }
  });

  app.get('/api/always-on/outbox', ownerOnly, (req, res, next) => {
    try {
      const limit = Number(req.query.limit || 50);
      res.json({
        items: store.listOutbox({
          status: req.query.status || null,
          priority: req.query.priority || null,
          limit: Number.isFinite(limit) ? limit : 50,
        }),
      });
    } catch (error) { next(error); }
  });

  if (memory) {
    app.get('/api/always-on/memory', ownerOnly, async (_req, res, next) => {
      try { res.json(await memory.listFiles()); } catch (error) { next(error); }
    });
    app.get('/api/always-on/memory/file', ownerOnly, async (req, res, next) => {
      try { res.json(await memory.readFile(req.query.path)); } catch (error) { next(error); }
    });
    app.put('/api/always-on/memory/file', ownerOnly, async (req, res, next) => {
      try { res.json(await memory.writeFile(req.body?.path, req.body?.content)); } catch (error) { next(error); }
    });
    app.delete('/api/always-on/memory/file', ownerOnly, async (req, res, next) => {
      try {
        const deleted = await memory.deleteFile(req.query.path);
        if (!deleted) return res.status(404).json({ error: '记忆文件不存在' });
        res.sendStatus(204);
      } catch (error) { next(error); }
    });
    app.post('/api/always-on/memory/dream', ownerOnly, async (_req, res, next) => {
      try { res.json(await memory.runDreaming()); } catch (error) { next(error); }
    });
  }

  if (outboxDispatcher) {
    app.post('/api/always-on/outbox/dispatch', ownerOnly, async (_req, res, next) => {
      try { res.json(await outboxDispatcher.tick()); } catch (error) { next(error); }
    });
    app.post('/api/always-on/outbox/digest', ownerOnly, async (req, res, next) => {
      try { res.json(await outboxDispatcher.compileDigest({ title: req.body?.title || '每日简报（Digest）' })); } catch (error) { next(error); }
    });
  }

  if (butler) {
    app.post('/api/always-on/butler/toggle', ownerOnly, (req, res) => {
      if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ error: 'enabled 必须为布尔值' });
      res.json({ enabled: butler.setEnabled(req.body.enabled) });
    });
  }

  if (approvalGate) {
    app.get('/api/always-on/approvals', ownerOnly, (req, res, next) => {
      try {
        res.json({ approvals: store.listApprovals({ status: req.query.status || null, limit: 50 }) });
      } catch (error) { next(error); }
    });
    app.post('/api/always-on/approvals', ownerOnly, (req, res, next) => {
      try {
        const result = approvalGate.requestApproval(req.body || {});
        res.status(201).json(result);
      } catch (error) { next(error); }
    });
    app.post('/api/always-on/approvals/:id/resolve', ownerOnly, async (req, res, next) => {
      try {
        const result = await approvalGate.resolveApproval(req.params.id, {
          decision: req.body?.decision,
          note: req.body?.note || null,
        });
        if (!result) return res.status(404).json({ error: '待审批记录不存在或已处理' });
        res.json(result);
      } catch (error) { next(error); }
    });
  }

  if (credentialProxy) {
    app.get('/api/always-on/proxy/services', ownerOnly, (_req, res) => {
      res.json({ services: credentialProxy.listServices() });
    });
    app.post('/api/always-on/proxy/forward', ownerOnly, async (req, res, next) => {
      try {
        res.json(await credentialProxy.forward(req.body || {}));
      } catch (error) { next(error); }
    });
  }

  // v2: Goal Blueprints
  app.get('/api/always-on/blueprints', ownerOnly, (req, res, next) => {
    try { res.json({ blueprints: store.listBlueprints({ status: req.query.status || null, limit: 100 }) }); }
    catch (error) { next(error); }
  });
  app.get('/api/always-on/blueprints/:slug', ownerOnly, (req, res) => {
    const bp = store.getBlueprintBySlug(req.params.slug);
    if (!bp) return res.status(404).json({ error: '蓝图不存在' });
    res.json(bp);
  });
  app.put('/api/always-on/blueprints/:slug', ownerOnly, async (req, res, next) => {
    try {
      const result = await materializeBlueprint({
        store,
        memory,
        draft: { ...(req.body || {}), slug: req.params.slug },
        recurrenceMs: req.body?.recurrenceMs ?? null,
      });
      res.json(result.blueprint);
    } catch (error) { next(error); }
  });
  app.patch('/api/always-on/blueprints/:slug/status', ownerOnly, (req, res, next) => {
    try {
      const updated = store.updateBlueprintStatus(req.params.slug, req.body?.status);
      if (!updated) return res.status(404).json({ error: '蓝图不存在' });
      res.json(updated);
    } catch (error) { next(error); }
  });
  app.post('/api/always-on/blueprints/:slug/dry-run', ownerOnly, async (req, res, next) => {
    try {
      const bp = store.getBlueprintBySlug(req.params.slug);
      if (!bp) return res.status(404).json({ error: '蓝图不存在' });
      const report = await runBlueprintDryRun({ store, memory, blueprint: bp, listSessions });
      res.json(report);
    } catch (error) { next(error); }
  });

  // v2: Codeck Architect (guided onboarding)
  app.post('/api/always-on/architect/analyze', ownerOnly, async (req, res, next) => {
    try {
      const sessions = await listSessions();
      const analysis = analyzeBrainDump({
        text: req.body?.text,
        title: req.body?.title || '',
        existingSessions: sessions,
      });
      res.json(analysis);
    } catch (error) { next(error); }
  });
  app.post('/api/always-on/architect/materialize', ownerOnly, async (req, res, next) => {
    try {
      const body = req.body || {};
      const recurrenceMs = body.recurrence ? parseDurationMs(body.recurrence) : (body.recurrenceMs ?? null);
      const result = await materializeBlueprint({ store, memory, draft: body.draft || body, recurrenceMs });
      res.status(201).json(result);
    } catch (error) { next(error); }
  });

  // v2: Entity Key cross-source correlation
  app.get('/api/always-on/entities', ownerOnly, (_req, res) => {
    res.json({ entities: store.listEntityKeys(50) });
  });
  app.get('/api/always-on/entities/:key/timeline', ownerOnly, (req, res, next) => {
    try {
      res.json({ entityKey: req.params.key, links: store.listEntityLinks({ entityKey: req.params.key, limit: 100 }) });
    } catch (error) { next(error); }
  });
  app.post('/api/always-on/entities/:key/links', ownerOnly, (req, res, next) => {
    try {
      const link = store.addEntityLink({
        entityKey: req.params.key,
        refType: req.body?.refType || 'note',
        refId: req.body?.refId || `manual-${Date.now()}`,
        summary: req.body?.summary || '',
        meta: req.body?.meta || {},
      });
      res.status(201).json(link);
    } catch (error) { next(error); }
  });

  // v2: Feedback Improvement Proposals
  app.get('/api/always-on/proposals', ownerOnly, (req, res, next) => {
    try { res.json({ proposals: store.listProposals({ status: req.query.status || null, limit: 50 }) }); }
    catch (error) { next(error); }
  });
  app.post('/api/always-on/proposals/generate', ownerOnly, (_req, res, next) => {
    try { res.json(generateImprovementProposals({ store })); }
    catch (error) { next(error); }
  });
  app.post('/api/always-on/proposals/:id/resolve', ownerOnly, async (req, res, next) => {
    try {
      const result = await resolveImprovementProposal({
        store,
        memory,
        id: req.params.id,
        decision: req.body?.decision,
        note: req.body?.note || null,
      });
      if (!result) return res.status(404).json({ error: '待处理提案不存在或已处理' });
      res.json(result);
    } catch (error) { next(error); }
  });

  // v2: Micro-Collector Page generator & submitter
  app.post('/api/always-on/collectors/:slug/publish', ownerOnly, async (req, res, next) => {
    try {
      const bp = store.getBlueprintBySlug(req.params.slug);
      const title = req.body?.title || (bp ? `${bp.title} · 数据采集` : `数据采集：${req.params.slug}`);
      const entityKey = req.body?.entityKey || bp?.entityKey || `mission:${req.params.slug}`;
      const html = buildMicroCollectorHtml({ slug: req.params.slug, title, entityKey, fields: req.body?.fields || [] });
      let published = null;
      if (publishCollectorPage) {
        published = await publishCollectorPage({
          title,
          html,
          sourceKey: `collector:${req.params.slug}`,
          session: bp?.targetSession || undefined,
        });
      }
      store.addEntityLink({
        entityKey,
        refType: 'collector_page',
        refId: published?.id || req.params.slug,
        summary: `生成微型采集页：${title}`,
        meta: { url: published?.url || null },
      });
      res.status(201).json({ slug: req.params.slug, entityKey, url: published?.url || null, html });
    } catch (error) { next(error); }
  });
  app.post('/api/always-on/collectors/:slug/submit', ownerOnly, async (req, res, next) => {
    try {
      const body = req.body || {};
      const entityKey = String(body.entityKey || `mission:${req.params.slug}`).trim();
      const data = body.data && typeof body.data === 'object' ? body.data : {};
      const summary = Object.entries(data).map(([k, v]) => `${k}: ${String(v).slice(0, 80)}`).join('；') || '提交记录';
      const enqueued = await runtime.enqueueAndWake({
        scopeKey: 'butler',
        source: 'web',
        payload: {
          collectorSlug: req.params.slug,
          entityKey,
          data,
          reason: `[采集:${req.params.slug}] ${summary}`,
          priority: 'digest',
        },
      });
      store.addEntityLink({
        entityKey,
        refType: 'collector',
        refId: enqueued.event.id,
        summary,
        meta: { slug: req.params.slug, data },
      });
      res.status(201).json({ ok: true, entityKey, eventId: enqueued.event.id });
    } catch (error) { next(error); }
  });
}
