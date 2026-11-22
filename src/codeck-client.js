import { sessionExecutionState, executionLabel } from '../public/execution-status.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import crypto from 'node:crypto';
import { sessionRpc } from './session-rpc.js';
import { sessionTarget } from './telegram-sessions.js';
import { runBotCommand } from './codeck-bot-client.js';

export const CLI_HELP = `Codeck：复用现有服务、授权和会话
  codeck session list
  codeck session checkpoint NAME --file NOTE.txt | --record NOTE.json
  codeck workfiles list NAME
  codeck workfiles add NAME --record FILE.json
  codeck session read NAME
  codeck session send NAME --file PROMPT.txt
  codeck session create NAME --provider codex --cwd /project [--worktree /path/to/new-worktree]
  codeck telegram list
  codeck bot list
  codeck bot create NAME --session SESSION [--purpose TEXT]
  codeck bot show NAME_OR_ID
  codeck bot bind-telegram NAME_OR_ID --telegram @USERNAME_OR_ID
  codeck bot unbind-telegram NAME_OR_ID --telegram @USERNAME_OR_ID
  codeck history search QUERY [--provider codex]
  codeck history context ID
  codeck history link SESSION --repo /project --commit SHA
  codeck task list
  codeck task put ID --file TASK.json
  codeck task remove ID
  codeck timer list
  codeck timer followup --in 30m --reason TEXT [--session NAME]
  codeck timer pause ID
  codeck timer resume ID
  codeck timer remove ID
  codeck memory list
  codeck memory read PATH
  codeck memory write PATH --file CONTENT.md
  codeck memory dream
  codeck blueprint list
  codeck blueprint get SLUG
  codeck blueprint put SLUG --file BLUEPRINT.json
  codeck blueprint dry-run SLUG
  codeck entity timeline KEY
  codeck proposal list
  codeck proposal accept ID
  codeck proposal reject ID
  codeck page list [--folder NAME|/]
  codeck page publish FILE.html --title TITLE [--folder NAME|/] [--id ID | --source-key KEY] [--session NAME] [--revision VERSION] [--evidence RECORD.json]
  codeck page share ID
  codeck page revoke ID
配置：~/.config/codeck/client.json（url、tokenFile、caFile），或 CODECK_URL / CODECK_TOKEN / CODECK_CA_FILE。
可加 --json。发送不自动重试；返回 accepted 仅代表提交路径完成，不代表 Agent 收到或任务完成。`;

export async function loadClientConnection(env = process.env) {
  const file = env.CODECK_CLIENT_CONFIG || path.join(os.homedir(), '.config/codeck/client.json');
  let config = {};
  try { config = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT' || env.CODECK_CLIENT_CONFIG) throw error; }
  const url = env.CODECK_URL || config.url || 'https://127.0.0.1:4310';
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') throw new Error('CODECK_URL 必须是 HTTPS 服务根地址');
  const token = env.CODECK_TOKEN || (config.tokenFile && (await fs.readFile(config.tokenFile, 'utf8')).trim());
  if (!token) throw new Error('请配置 CODECK_TOKEN 或 client.json 的 tokenFile');
  const caFile = env.CODECK_CA_FILE || config.caFile;
  return { url: parsed.origin, token, ...(caFile ? { ca: await fs.readFile(caFile, 'utf8') } : {}) };
}

export function clientRequest(connection, endpoint, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = https.request(new URL(endpoint, connection.url), { method, ca: connection.ca,
      headers: { Authorization: `Bearer ${connection.token}`, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) },
    }, res => {
      let text = '';
      res.setEncoding('utf8'); res.on('data', part => { text += part; });
      res.on('error', reject);
      res.on('end', () => {
        let value; try { value = text ? JSON.parse(text) : {}; } catch { return reject(new Error(`HTTP ${res.statusCode} 返回非 JSON，结果需核实`)); }
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(value.error || `HTTP ${res.statusCode}`));
        resolve(value);
      });
    });
    req.setTimeout(60_000, () => req.destroy(new Error('请求超时；结果未确认，请查询状态，勿重复发送')));
    req.on('error', error => reject(new Error(`连接失败或结果未确认：${error.message}；请核实状态，勿重复发送`)));
    req.end(data);
  });
}

export async function runCodeck(argv, connection, { request = clientRequest, rpc = sessionRpc } = {}) {
  const [area, action, ...args] = argv.filter(a => a !== '--json');
  const positional = [], options = {};
  const allowed = new Set(['folder', 'file', 'record', 'repo', 'commit', 'evidence', 'provider', 'worktree', 'cwd', 'title', 'id', 'source-key', 'session', 'purpose', 'telegram', 'revision', 'in', 'at', 'reason']);
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) { positional.push(args[i]); continue; }
    const key = args[i].slice(2), value = args[++i];
    if (!allowed.has(key) || !value || value.startsWith('--') || Object.hasOwn(options, key)) throw new Error('无效或重复的命令参数');
    options[key] = value;
  }
  const commandOptions = {
    'telegram:list': [], 'bot:list': [], 'bot:create': ['session', 'purpose'], 'bot:show': [],
    'bot:bind-telegram': ['telegram'], 'bot:unbind-telegram': ['telegram'],
    'session:checkpoint': ['file', 'record'], 'session:list': [], 'session:read': [], 'session:send': ['file'], 'session:create': ['provider', 'cwd', 'worktree'],
    'workfiles:list': [], 'workfiles:add': ['record'],
    'history:search': ['provider'], 'history:context': [], 'history:link': ['repo', 'commit', 'provider'],
    'task:list': [], 'task:put': ['file'], 'task:remove': [],
    'timer:list': [], 'timer:followup': ['in', 'at', 'reason', 'session', 'id'], 'timer:pause': [], 'timer:resume': [], 'timer:remove': [],
    'memory:list': [], 'memory:read': [], 'memory:write': ['file'], 'memory:dream': [],
    'blueprint:list': [], 'blueprint:get': [], 'blueprint:put': ['file'], 'blueprint:dry-run': [],
    'entity:timeline': [],
    'proposal:list': [], 'proposal:accept': [], 'proposal:reject': [],
    'page:list': ['folder'], 'page:publish': ['folder', 'title', 'id', 'source-key', 'session', 'revision', 'evidence'], 'page:share': [], 'page:revoke': [],
  }[area + ':' + action];
  if (!commandOptions || Object.keys(options).some(key => !commandOptions.includes(key))) throw new Error('未知命令或该命令不支持此参数');
  const name = positional[0];
  if (positional.length > 1) throw new Error('参数过多；正文请使用 --file');
  const call = (endpoint, method, body) => request(connection, endpoint, method, body);
  if (area === 'bot' || area === 'telegram') return runBotCommand(call, area, action, name, options);
  if (area === 'workfiles') {
    if (!name) throw new Error('请指定会话名');
    const endpoint = `/api/sessions/${encodeURIComponent(name)}/workfiles`;
    const current = await call(endpoint);
    if (action === 'list') return current;
    if (!options.record) throw new Error('请用 --record 指定资料或成果记录');
    return call(endpoint, 'POST', { ...JSON.parse(await fs.readFile(options.record, 'utf8')), identity: current.identity });
  }
  if (area === 'session') {
    if (action === 'list') return call('/api/sessions');
    if (!name) throw new Error('请指定会话名');
    if (action === 'create') {
      if (!['codex', 'claude', 'qodercli', 'agy'].includes(options.provider || 'codex')) throw new Error('未知 provider');
      return call('/api/sessions', 'POST', { name, client: options.provider || 'codex', cwd: options.cwd || process.cwd(), ...(options.worktree ? { worktree: options.worktree } : {}) });
    }
    if (!['read', 'send', 'checkpoint'].includes(action)) throw new Error('未知 session 命令');
    const target = sessionTarget((await call('/api/sessions')).sessions, name);
    if (action === 'checkpoint') {
      if (Boolean(options.file) === Boolean(options.record)) throw new Error('进度需指定 --file NOTE.txt 或 --record NOTE.json');
      const value = options.record ? JSON.parse(await fs.readFile(options.record, 'utf8')) : { text: await fs.readFile(options.file, 'utf8') };
      return call(`/api/sessions/${encodeURIComponent(name)}/checkpoint`, 'PUT', { ...value, threadId: target.threadId });
    }
    if (action === 'read') return rpc(connection, { type: 'openThread', ...target, readOnly: true });
    if (!options.file) throw new Error('发送需 --file 指定正文文件');
    const text = await fs.readFile(options.file, 'utf8');
    if (!text.trim()) throw new Error('消息不能为空');
    const commandId = `cli-${crypto.randomUUID()}`;
    try { return await rpc(connection, { type: 'sendSessionMessage', ...target, text, commandId }); }
    catch (error) { throw new Error(`${error.message}（commandId: ${commandId}）；未自动重发`); }
  }
  if (area === 'history') {
    if (!name) throw new Error('请提供搜索词、记录 ID 或会话名');
    if (action === 'search') return call('/api/history/search?' + new URLSearchParams({ q: name, ...(options.provider ? { provider: options.provider } : {}) }));
    if (action === 'context') return call('/api/history/context/' + encodeURIComponent(name));
    const target = options.provider ? { provider: options.provider, threadId: name } : sessionTarget((await call('/api/sessions')).sessions, name);
    return call('/api/history/commits', 'POST', { provider: target.provider, threadId: target.threadId, repo: options.repo, commit: options.commit });
  }
  if (area === 'task') {
    if (action === 'list') return call('/api/tasks');
    if (!name) throw new Error('请指定任务 ID');
    if (action === 'remove') { await call(`/api/tasks/${encodeURIComponent(name)}`, 'DELETE'); return { removed: name }; }
    if (!options.file) throw new Error('任务配置需 --file');
    return call(`/api/tasks/${encodeURIComponent(name)}`, 'PUT', JSON.parse(await fs.readFile(options.file, 'utf8')));
  }
  if (area === 'timer') {
    if (action === 'list') return call('/api/always-on/timers');
    if (action === 'followup') {
      if (!options.reason || (!options.in && !options.at)) throw new Error('followup 需要 --reason，以及 --in 或 --at');
      return call('/api/always-on/timers/followup', 'POST', {
        ...(options.id ? { id: options.id } : {}),
        ...(options.in ? { in: options.in } : {}),
        ...(options.at ? { at: options.at } : {}),
        reason: options.reason,
        ...(options.session ? { session: options.session } : {}),
      });
    }
    if (!name) throw new Error('请指定定时器 ID');
    if (action === 'remove') { await call(`/api/always-on/timers/${encodeURIComponent(name)}`, 'DELETE'); return { removed: name }; }
    if (action === 'pause' || action === 'resume') return call(`/api/always-on/timers/${encodeURIComponent(name)}`, 'PATCH', { action });
    throw new Error('未知 timer 命令');
  }
  if (area === 'memory') {
    if (action === 'list') return call('/api/always-on/memory');
    if (action === 'dream') return call('/api/always-on/memory/dream', 'POST');
    if (!name) throw new Error('请指定记忆路径（如 instructions.md 或 notes/prefs.md）');
    if (action === 'read') return call('/api/always-on/memory/file?' + new URLSearchParams({ path: name }));
    if (action === 'write') {
      if (!options.file) throw new Error('写入记忆需 --file');
      return call('/api/always-on/memory/file', 'PUT', { path: name, content: await fs.readFile(options.file, 'utf8') });
    }
    throw new Error('未知 memory 命令');
  }
  if (area === 'blueprint') {
    if (action === 'list') return call('/api/always-on/blueprints');
    if (!name) throw new Error('请指定蓝图 slug');
    if (action === 'get') return call(`/api/always-on/blueprints/${encodeURIComponent(name)}`);
    if (action === 'dry-run') return call(`/api/always-on/blueprints/${encodeURIComponent(name)}/dry-run`, 'POST');
    if (action === 'put') {
      if (!options.file) throw new Error('更新蓝图需 --file');
      return call(`/api/always-on/blueprints/${encodeURIComponent(name)}`, 'PUT', JSON.parse(await fs.readFile(options.file, 'utf8')));
    }
    throw new Error('未知 blueprint 命令');
  }
  if (area === 'entity') {
    if (action === 'timeline') {
      if (!name) throw new Error('请指定 entityKey');
      return call(`/api/always-on/entities/${encodeURIComponent(name)}/timeline`);
    }
    throw new Error('未知 entity 命令');
  }
  if (area === 'proposal') {
    if (action === 'list') return call('/api/always-on/proposals');
    if (!name) throw new Error('请指定提案 ID');
    if (action === 'accept' || action === 'reject') {
      return call(`/api/always-on/proposals/${encodeURIComponent(name)}/resolve`, 'POST', { decision: action === 'accept' ? 'accepted' : 'rejected' });
    }
    throw new Error('未知 proposal 命令');
  }
  if (area === 'page') {
    if (action === 'list') {
      const result = await call('/api/pages');
      return options.folder ? { pages: result.pages.filter(page => (page.folder || '/') === options.folder) } : result;
    }
    if (action === 'publish') {
      if (!name || !options.title || (!options.id && !options['source-key'])) throw new Error('发布需文件、--title，以及 --id 或 --source-key');
      if (options.id && options['source-key']) throw new Error('--id 与 --source-key 请选择一个');
      if (!options['source-key'] && (options.session || options.revision)) throw new Error('来源信息需要 --source-key');
      const body = { title: options.title, ...(options.folder ? { folder: options.folder === '/' ? null : options.folder } : {}), html: await fs.readFile(name, 'utf8'),
        ...(options.evidence ? { evidence: JSON.parse(await fs.readFile(options.evidence, 'utf8')) } : {}),
        ...(options['source-key'] ? { source: { key: options['source-key'], session: options.session, revision: options.revision } } : {}) };
      const result = options.id ? await call(`/api/pages/${encodeURIComponent(options.id)}`, 'PUT', body)
        : await call('/api/pages/publish', 'POST', body);
      return { ...result, url: new URL(result.url, connection.url).href };
    }
    if (!name || !['share', 'revoke'].includes(action)) throw new Error('未知 page 命令或缺少页面 ID');
    const result = await call(`/api/pages/${encodeURIComponent(name)}/share`, action === 'share' ? 'POST' : 'DELETE');
    return result.url ? { ...result, url: new URL(result.url, connection.url).href } : { revoked: true, id: name };
  }
  throw new Error(CLI_HELP);
}

export function formatClientResult(value) {
  if (value.channels) return value.channels.map(c => `@${c.username}\t${c.id}\t${c.status}\t${c.botId || '未绑定'}`).join('\n') || '暂无已接入的 Telegram 机器人';
  if (value.bots) return value.bots.map(b => `${b.name}\t${b.target.session}\t${b.id}`).join('\n') || '暂无工作台 Bot';
  if (value.bot) {
    const lines = [`Bot ${value.bot.name}（${value.bot.id}）`, `主会话 ${value.bot.target.session} · ${value.bot.target.provider}`];
    if (Object.hasOwn(value, 'telegram')) lines.push(value.telegram ? `Telegram @${value.telegram.username} · ${value.telegram.status}` : 'Telegram 未绑定');
    if (value.bot.purpose) lines.push(value.bot.purpose);
    return lines.join('\n');
  }
  if (value.results) return [value.status?.indexing ? '索引中，结果尚不完整' : value.status?.error || '', ...value.results.map(r => `${r.id}\t${r.provider}/${r.threadId}\n${r.excerpt}`)].filter(Boolean).join('\n\n');
  if (value.url) return value.url;
  if (value.sessions) return value.sessions.map(s => `${s.name}\t${s.agent?.kind || 'shell'}\t${executionLabel(sessionExecutionState(s))}`).join('\n') || '暂无会话';
  if (value.pages) return value.pages.map(p => `${p.id}\t${p.title}\t${p.url}`).join('\n') || '暂无页面';
  if (value.timers) return value.timers.map(t => `${t.id}\t${t.kind}\t${t.status}\t${new Date(t.dueAt).toISOString()}\t${t.scopeKey}\t${t.reason}`).join('\n') || '暂无定时器';
  if (value.thread) {
    if (value.thread.historyError) return `历史读取失败：${value.thread.historyError}`;
    if (value.thread.historyLoading) return '历史正在读取，请稍后查询；未发送任何输入';
    return (value.thread.turns || []).map(t => (t.items || []).filter(i => i.type === 'agentMessage').map(i => i.text).join('\n')).filter(Boolean).join('\n\n') || '暂无模型回复';
  }
  if (value.command) return `提交路径已返回；请读取会话核实接收和结果。commandId: ${value.command.id}`;
  if (value.revoked) return '已取消分享';
  return JSON.stringify(value, null, 2);
}
