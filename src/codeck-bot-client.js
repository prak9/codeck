const base = '/api/workstation';

function matchesChannel(channel, reference) {
  return channel.id === reference || channel.username.toLowerCase() === reference.replace(/^@/, '').toLowerCase();
}

export async function runBotCommand(call, area, action, name, options) {
  if (action === 'list') {
    if (name) throw new Error('list 无需名称参数');
    return call(base + (area === 'telegram' ? '/telegram' : '/bots'));
  }
  if (!name?.trim()) throw new Error('请指定工作台 Bot 名称或 ID');
  if (action === 'create') {
    if (!options.session) throw new Error('创建 Bot 需 --session 指定已有主会话');
    const { sessions } = await call('/api/sessions');
    const home = sessions.find(s => s.name === options.session);
    if (!home?.agent?.id || !home.agent.kind || !Number.isSafeInteger(home.createdAt)) throw new Error('主会话不存在或 Agent 身份尚未就绪');
    const target = { session: home.name, createdAt: home.createdAt, provider: home.agent.kind, threadId: home.agent.id };
    return { bot: await call(base + '/bots', 'POST', { name, target, ...(options.purpose ? { purpose: options.purpose } : {}) }) };
  }
  if (action !== 'show' && !options.telegram) throw new Error('请用 --telegram 指定 Telegram 用户名或数字 ID');
  const { bots } = await call(base + '/bots');
  const byId = bots.find(b => b.id === name);
  const matches = byId ? [byId] : bots.filter(b => b.name === name);
  if (!matches.length) throw new Error('找不到这个 Bot，请用 codeck bot list 核对名称');
  if (matches.length > 1) throw new Error('存在同名 Bot，请使用 codeck bot list 中的 ID');
  const bot = matches[0];
  const endpoint = base + '/bots/' + encodeURIComponent(bot.id) + '/telegram';
  const { bound, available } = await call(endpoint);
  let current = bound;
  if (action === 'bind-telegram' && !bound) {
    const channel = available.find(c => matchesChannel(c, options.telegram));
    if (!channel) throw new Error('此 Telegram 机器人不可绑定，请用 codeck telegram list 检查连接和归属');
    await call(endpoint, 'PUT', { channelId: channel.id });
    current = (await call(endpoint)).bound;
    if (current?.id !== channel.id) throw new Error('绑定状态已变化，请用 codeck bot show 核实');
  } else if (action !== 'show') {
    if (!bound || !matchesChannel(bound, options.telegram)) throw new Error('当前绑定与指定的 Telegram 机器人不匹配，请先用 codeck bot show 核实');
    if (action === 'unbind-telegram') {
      await call(endpoint, 'DELETE', { channelId: bound.id, key: bound.key });
      current = (await call(endpoint)).bound;
      if (current) throw new Error('绑定状态已变化，请用 codeck bot show 核实');
    }
  }
  return { bot, telegram: current ? { id: current.id, username: current.username, status: current.status } : null };
}
