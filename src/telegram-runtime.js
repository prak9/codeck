import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { TelegramSessions } from './telegram-sessions.js';

function safeError(message, code, retryAfter) {
  return Object.assign(new Error(message), { safeMessage: message, code, retryAfter });
}

async function readSettings(filename) {
  const config = JSON.parse(await fs.readFile(filename, 'utf8'));
  if (!path.isAbsolute(config.tokenFile || '') || !Number.isSafeInteger(config.ownerId) || config.ownerId <= 0) {
    throw safeError('Telegram 配置需要 tokenFile 绝对路径和 ownerId 正整数', 'CONFIG');
  }
  const additionalTokenFiles = config.additionalTokenFiles ?? [];
  if (!Array.isArray(additionalTokenFiles) || additionalTokenFiles.some(file => typeof file !== 'string' || !path.isAbsolute(file))) {
    throw safeError('additionalTokenFiles 需要 Token 文件绝对路径数组', 'CONFIG');
  }
  const localInboxBotIds = config.localInboxBotIds ?? [];
  if (!Array.isArray(localInboxBotIds) || localInboxBotIds.some(id => typeof id !== 'string' || !/^[1-9]\d*$/.test(id))) {
    throw safeError('localInboxBotIds 需要 Telegram 机器人数字 ID 字符串数组', 'CONFIG');
  }
  let webUrl;
  if (config.webUrl) {
    const url = new URL(config.webUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw safeError('webUrl 应为不带凭据的 Codeck HTTPS 地址', 'CONFIG');
    webUrl = new URL('/remote.html', url).href;
  }
  if (config.proxy && (typeof config.proxy !== 'string' || !/^https?:\/\//.test(config.proxy))) throw safeError('Telegram proxy 应为 HTTP(S) 代理地址', 'CONFIG');
  return { tokenFile: config.tokenFile, ownerId: config.ownerId, proxy: config.proxy, webUrl, additionalTokenFiles, localInboxBotIds, enabled: config.enabled !== false };
}

async function readTelegramToken(tokenFile) {
  const stat = await fs.stat(tokenFile);
  if (!stat.isFile() || (stat.mode & 0o077)) throw safeError('Telegram Token 文件权限必须为 0600 或 0400', 'CONFIG');
  const token = (await fs.readFile(tokenFile, 'utf8')).trim();
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) throw safeError('Telegram Token 格式不正确', 'CONFIG');
  return token;
}

export async function readTelegramConfig(filename) {
  const { tokenFile, ...settings } = await readSettings(filename);
  return { ...settings, token: await readTelegramToken(tokenFile) };
}

export function telegramCurlConfig({ token, proxy }, method, payload) {
  if (!/^[A-Za-z]+$/.test(method) || !/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new Error('Invalid Telegram API request');
  const quote = value => `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n').replaceAll('\r', '\\r')}"`;
  return [
    `url = ${quote(`https://api.telegram.org/bot${token}/${method}`)}`,
    'request = "POST"', 'header = "Content-Type: application/json"',
    `data = ${quote(JSON.stringify(payload))}`,
    ...(proxy ? [`proxy = ${quote(proxy)}`] : []),
  ].join('\n');
}

// curl is already available on the host and respects its proxy environment. The
// token and message body go through stdin, never argv, logs, or a shell command.
export function createTelegramApi(config, { signal, spawnProcess = spawn } = {}) {
  return (method, payload = {}) => new Promise((resolve, reject) => {
    const child = spawnProcess('curl', ['--silent', '--show-error', '--max-time', '40', '--config', '-'],
      { stdio: ['pipe', 'pipe', 'ignore'], signal });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; });
    child.stdin.on('error', () => {});
    child.on('error', () => reject(safeError('Telegram 网络客户端不可用', 'NETWORK')));
    child.on('close', code => {
      if (code !== 0) { reject(safeError('Telegram 网络请求失败', 'NETWORK')); return; }
      try {
        const response = JSON.parse(output);
        if (!response.ok) {
          const messages = { 401: 'Telegram Bot Token 无效', 409: 'Telegram Bot 已被其他客户端或 webhook 占用', 429: 'Telegram 请求过于频繁' };
          reject(safeError(messages[response.error_code] || 'Telegram API 请求失败', response.error_code, response.parameters?.retry_after));
        } else resolve(response.result);
      } catch { reject(safeError('Telegram 响应无法解析', 'NETWORK')); }
    });
    child.stdin.end(telegramCurlConfig(config, method, payload));
  });
}

async function readLocalUpdates(directory, { offset, limit }, signal) {
  const files = (await fs.readdir(directory)).filter(name => /^[1-9]\d*\.json$/.test(name)).sort((a, b) => parseInt(a) - parseInt(b));
  const batch = [];
  for (const name of files) {
    const file = path.join(directory, name), id = parseInt(name);
    if (id < offset) { await fs.unlink(file); continue; }
    const update = JSON.parse(await fs.readFile(file, 'utf8'));
    if (update.update_id !== id || !Number.isSafeInteger(id)) throw safeError('本地 Telegram 消息文件与更新编号不符', 'CONFIG');
    batch.push(update);
    if (batch.length === limit) break;
  }
  if (!batch.length) await delay(1500, undefined, { signal });
  return batch;
}

export function startTelegramService({ configFile, directory, sessions, understand, binding,
  logger = console, apiFactory = createTelegramApi }) {
  const controller = new AbortController();
  const primary = { status: 'starting' }, channels = new Map(), claimed = new Set();
  async function connect(config, channel) {
    try {
      const credentialId = config.token.split(':', 1)[0];
      if (claimed.has(credentialId)) throw safeError('同一个 Telegram 机器人被重复配置', 'CONFIG');
      claimed.add(credentialId);
      const api = apiFactory(config, { signal: controller.signal });
      let bot;
      let backoff = 1000;
      while (!controller.signal.aborted) {
        try {
          if (!bot) {
            const identity = await api('getMe');
            if (!Number.isSafeInteger(identity.id) || identity.id <= 0) throw safeError('Telegram 返回的机器人身份无效', 'CONFIG');
            if (channels.has(String(identity.id)) && channels.get(String(identity.id)) !== channel) throw safeError('同一个 Telegram 机器人被重复配置', 'CONFIG');
            Object.assign(channel, { id: String(identity.id), username: identity.username || String(identity.id) });
            channels.set(channel.id, channel);
            const local = config.localInboxBotIds.includes(channel.id);
            const incoming = path.join(directory, channel.id, 'incoming');
            if (local) await fs.mkdir(incoming, { recursive: true, mode: 0o700 });
            else {
              const webhook = await api('getWebhookInfo');
              if (webhook.url) throw safeError('Telegram Bot 已配置 webhook；未修改其现有接入', 409);
            }
            const candidate = new TelegramSessions({ ...config, botId: identity.id,
              api: local ? (method, args) => method === 'getUpdates' ? readLocalUpdates(incoming, args, controller.signal) : api(method, args) : api, sessions, understand, signal: controller.signal,
              binding: () => binding?.(identity.id) || (channel === primary ? null : { key: 'detached', target: null }),
              directory: path.join(directory, String(identity.id)) });
            try { await candidate.load(); }
            catch { throw safeError('Telegram 存档读取失败；未启动接入或覆盖旧记录', 'CONFIG'); }
            bot = candidate;
            logger.info('Codeck Telegram 会话服务已启动（仅 owner 私聊）');
          }
          channel.status = 'connected';
          await bot.tick();
          backoff = 1000;
        } catch (error) {
          if (controller.signal.aborted) break;
          channel.status = 'reconnecting';
          if ([401, 409, 'CONFIG'].includes(error.code)) throw error;
          logger.warn(error.safeMessage || 'Telegram 读取或投递失败；保留记录，等待重试');
          const wait = Number.isSafeInteger(error.retryAfter) && error.retryAfter > 0 ? error.retryAfter * 1000 : backoff;
          await delay(wait, undefined, { signal: controller.signal });
          backoff = Math.min(backoff * 2, 60_000);
        }
      }
    } catch (error) {
      channel.status = controller.signal.aborted ? 'disabled' : 'error';
      if (!controller.signal.aborted) logger.warn(error.safeMessage || 'Telegram 配置或存档读取失败；入口未启动');
    }
  }
  const done = (async () => {
    try {
      const { tokenFile, additionalTokenFiles, ...settings } = await readSettings(configFile);
      if (!settings.enabled) { primary.status = 'disabled'; return; }
      const connections = [];
      // Register the primary credential first so a repeated file cannot start a second poller or change its role.
      for (const file of new Set([tokenFile, ...additionalTokenFiles])) {
        if (controller.signal.aborted) break;
        const channel = file === tokenFile ? primary : { status: 'starting' };
        try {
          const token = await readTelegramToken(file);
          connections.push(connect({ ...settings, token }, channel));
        } catch (error) {
          channel.status = 'error';
          logger.warn(error.safeMessage || 'Telegram Token 文件读取失败，请检查路径和权限');
        }
      }
      await Promise.all(connections);
    } catch (error) {
      primary.status = 'error';
      if (!controller.signal.aborted) logger.warn(error.safeMessage || 'Telegram 配置读取失败');
    }
  })();
  return { done,
    get status() {
      if (controller.signal.aborted) return 'disabled';
      return [...channels.values()].some(c => c.status === 'connected') ? 'connected' : primary.status;
    },
    get channels() { return controller.signal.aborted ? [] : [...channels.values()].map(c => ({ ...c })); },
    stop() { controller.abort(); },
  };
}
