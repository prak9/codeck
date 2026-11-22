import { workfileIdentity } from './workfiles.js';
import { workstationError, workstationTargetMatches } from './workstation-store.js';

export function mountWorkstationRoutes(app, { store, workfiles, sessions, ownerOnly, telegramChannels = () => [], base = '/api/workstation' }) {
  function route(method, path, action) {
    app[method](base + path || '/', ownerOnly, async (req, res, next) => {
      res.set('Cache-Control', 'private, no-store');
      try { await action(req, res); }
      catch (error) {
        if (error.status >= 400 && error.status < 500) return res.status(error.status).json({ error: error.message });
        next(error);
      }
    });
  }

  async function requireLive(target) {
    if (!(await sessions()).some(session => workstationTargetMatches(session, target))) {
      throw workstationError(409, '来源会话身份已变化，请重新选择');
    }
  }

  async function pinOutput(task, ref) {
    if (typeof ref?.itemId !== 'string' || typeof ref.versionId !== 'string') throw workstationError(400, '请选择明确的成果版本');
    const target = ref.runId ? task.runs.find(run => run.id === ref.runId)?.target : task.target;
    if (!target) throw workstationError(404, '任务中没有这次执行');
    const source = { name: target.session, createdAt: target.createdAt, agent: { kind: target.provider, id: target.threadId } };
    const item = (await workfiles.list(source)).find(entry => entry.id === ref.itemId && entry.kind === 'result');
    const version = item?.versions.find(entry => entry.id === ref.versionId);
    if (!version) throw workstationError(404, '在该会话的成果中找不到此版本');
    return { itemId: item.id, versionId: version.id, session: source.name, identity: workfileIdentity(source),
      title: item.title, revision: version.revision, at: version.at,
      ...(ref.runId ? { runId: ref.runId } : {}),
      ...(version.fileName ? { fileName: version.fileName, contentHash: version.contentHash } : { url: version.url }),
      ...(version.evidence ? { evidence: version.evidence } : {}) };
  }

  function channelInventory() {
    const byId = new Map(store.telegramChannels().map(row => [row.id, { ...row, status: 'disabled' }]));
    for (const { id, username, status } of telegramChannels()) {
      byId.set(id, { id, username, status, botId: byId.get(id)?.botId ?? null });
    }
    return [...byId.values()];
  }

  route('get', '', (_req, res) => res.json(store.overview()));
  route('get', '/bots', (_req, res) => res.json({ bots: store.listBots() }));
  route('get', '/telegram', (_req, res) => res.json({ channels: channelInventory() }));
  route('post', '/tasks', async (req, res) => {
    const body = req.body || {};
    await requireLive(body.target);
    res.status(201).json(store.trackTask(body));
  });
  route('patch', '/tasks/:id', async (req, res) => {
    const { status, progress, output } = req.body || {};
    if (status === undefined && progress === undefined && output === undefined) throw workstationError(400, '请选择要更新的状态、进展或成果版本');
    const task = store.task(req.params.id);
    if (!task) throw workstationError(404, '任务不存在');
    const pin = output === undefined ? undefined : await pinOutput(task, output);
    res.json(store.updateTask(task.id, { status, progress, output: pin }));
  });
  route('post', '/bots', async (req, res) => {
    const body = req.body || {};
    await requireLive(body.target);
    res.status(201).json(store.createBot(body));
  });
  route('patch', '/bots/:id', (req, res) => res.json(store.updateBot(req.params.id, req.body || {})));
  route('get', '/bots/:id/telegram', (req, res) => {
    if (!store.bot(req.params.id)) throw workstationError(404, '工作台 Bot 不存在');
    const channels = channelInventory();
    const saved = channels.find(b => b.botId === req.params.id);
    res.json({ bound: saved ? { id: saved.id, username: saved.username, key: store.telegramBinding(saved.id).key,
      status: saved.status } : null,
      available: channels.filter(c => c.status === 'connected' && !c.botId).map(({ id, username }) => ({ id, username })) });
  });
  route('put', '/bots/:id/telegram', async (req, res) => {
    const bot = store.bot(req.params.id);
    if (!bot) throw workstationError(404, '工作台 Bot 不存在');
    if (!['codex', 'qodercli', 'claude'].includes(bot.target.provider)) throw workstationError(409, '当前 Agent 暂不支持 Telegram 收发');
    await requireLive(bot.target);
    const channel = telegramChannels().find(c => c.id === req.body?.channelId && c.status === 'connected');
    if (!channel) throw workstationError(409, 'Telegram 机器人尚未连接，请检查后台服务');
    store.bindTelegram(bot.id, channel);
    res.sendStatus(204);
  });
  route('delete', '/bots/:id/telegram', (req, res) => {
    const { channelId, key } = req.body || {};
    if (typeof channelId !== 'string' || typeof key !== 'string') throw workstationError(400, '请提供要解除的 Telegram 绑定');
    store.unbindTelegram(req.params.id, channelId, key);
    res.sendStatus(204);
  });
  route('delete', '/bots/:id', (req, res) => {
    store.removeBot(req.params.id);
    res.sendStatus(204);
  });
}
