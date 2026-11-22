// These owner routes delegate writes to the same decision and scheduling paths used by other clients.
export function mountWorkstationActions(app, { ownerOnly, interactions, automations, conditionalTasks }) {
  const route = (method, path, handle) => app[method](path, ownerOnly, async (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    try { await handle(req, res); } catch (error) {
      if (error.status >= 400 && error.status < 500) return res.status(error.status).json({ error: error.message });
      next(error);
    }
  });
  route('get', '/pending', async (_req, res) => {
    const items = await interactions.pending();
    res.json({ items: items.map(({ text, ...item }) => ({ ...item, text: item.label, label: item.kind === 'approval' ? '权限审批' : '待回答' })) });
  });
  route('post', '/pending/answer', async (req, res) => {
    const { key, target, decision, answer } = req.body || {};
    const item = (await interactions.pending()).find(i => i.key === key);
    if (!item || !target || ['session', 'provider', 'threadId', 'createdAt'].some(k => item.target[k] !== target[k])) {
      return res.status(409).json({ error: '会话或问题已变化，请刷新待办' });
    }
    if (!item.actionable) return res.status(409).json({ error: '请在原会话中回答完整问题' });
    const approve = item.kind === 'approval';
    if (approve ? !['accept', 'decline'].includes(decision) : typeof answer !== 'string' || !answer.trim() || answer.length > 4000 || (item.native && !item.options.includes(answer))) {
      return res.status(400).json({ error: '请选择当前问题的有效答案' });
    }
    await interactions.act(approve ? 'approve' : 'answer',
      { tmuxSession: target.session, provider: target.provider, threadId: target.threadId }, { ...item, decision, answer });
    res.sendStatus(204);
  });
  route('get', '/automations', async (_req, res) => {
    res.json({ rules: automations.list(), conditional: (await conditionalTasks.list()).map(({ events, history, ...rule }) => rule) });
  });
  route('patch', '/conditions/:id', async (req, res) => {
    const rule = await conditionalTasks.setEnabled(req.params.id, req.body?.enabled);
    res.json({ id: rule.id, enabled: rule.enabled });
  });
  route('get', '/automations/scripts', async (_req, res) => res.json({ scripts: await automations.scriptOptions() }));
  const writeCondition = async (req, res) => {
    const createOnly = req.method === 'POST';
    const body = req.body || {};
    if (!createOnly && !Number.isSafeInteger(body.version)) return res.status(400).json({ error: '缺少规则版本' });
    const session = (await interactions.list()).find(s => s.name === body.session);
    if (!session || session.agent?.kind !== body.provider || !session.agent.id || session.agent.id !== body.threadId) {
      return res.status(409).json({ error: '会话身份已变化，请重新选择' });
    }
    res.status(createOnly ? 201 : 200).json(await conditionalTasks.put(req.params.id, body, createOnly ? { createOnly } : { version: body.version }));
  };
  route('post', '/conditions/:id', writeCondition);
  route('put', '/conditions/:id', writeCondition);
  route('get', '/conditions/:id/runs', async (req, res) => {
    const rule = (await conditionalTasks.list()).find(row => row.id === req.params.id);
    if (!rule) return res.status(404).json({ error: '条件规则不存在' });
    res.json({ runs: (rule.history?.length ? rule.history : rule.last ? [rule.last] : []).slice().reverse() });
  });
  route('post', '/conditions/:id/run', async (req, res) => res.json(await conditionalTasks.runNow(req.params.id, req.body?.requestId)));
  route('delete', '/conditions/:id', async (req, res) => {
    if (!Number.isSafeInteger(req.body?.version)) return res.status(400).json({ error: '缺少规则版本' });
    await conditionalTasks.remove(req.params.id, req.body.version);
    res.json({ removed: true });
  });
  route('put', '/automations/:id', async (req, res) => res.json(await automations.update(req.params.id, req.body)));
  route('post', '/automations/:id/preview', async (req, res) => res.json(await automations.previewUpdate(req.params.id, req.body)));
  route('delete', '/automations/:id', async (req, res) => res.json({ removed: automations.remove(req.params.id, req.body?.version) }));
  route('post', '/automations', async (req, res) => res.status(201).json(await automations.create(req.body)));
  route('post', '/automations/preview', async (req, res) => res.json(await automations.preview(req.body)));
  route('get', '/automations/:id/preview', async (req, res) => res.json(await automations.preview(req.params.id)));
  route('get', '/automations/:id/runs', async (req, res) => res.json({ runs: await automations.runs(req.params.id) }));
  route('patch', '/automations/:id', async (req, res) => {
    if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ error: '启停参数无效' });
    res.json(await automations.setEnabled(req.params.id, req.body.enabled));
  });
  route('post', '/automations/:id/run', async (req, res) => {
    res.status(202).json(await automations.runNow(req.params.id, req.body?.requestId));
  });
}
