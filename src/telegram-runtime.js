import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { TelegramSessions } from './telegram-sessions.js';

function safeError(message, code, retryAfter) {
  return Object.assign(new Error(message), { safeMessage: message, code, retryAfter });
}

export async function readTelegramConfig(filename) {
  const config = JSON.parse(await fs.readFile(filename, 'utf8'));
  if (!path.isAbsolute(config.tokenFile || '') || !Number.isSafeInteger(config.ownerId) || config.ownerId <= 0) {
    throw safeError('Telegram 配置需要 tokenFile 绝对路径和 ownerId 正整数', 'CONFIG');
  }
  const stat = await fs.stat(config.tokenFile);
  if (!stat.isFile() || (stat.mode & 0o077)) throw safeError('Telegram Token 文件权限必须为 0600 或 0400', 'CONFIG');
  const token = (await fs.readFile(config.tokenFile, 'utf8')).trim();
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) throw safeError('Telegram Token 格式不正确', 'CONFIG');
  let webUrl;
  if (config.webUrl) {
    const url = new URL(config.webUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw safeError('webUrl 应为不带凭据的 Codeck HTTPS 地址', 'CONFIG');
    webUrl = new URL('/remote.html', url).href;
  }
  if (config.proxy && (typeof config.proxy !== 'string' || !/^https?:\/\//.test(config.proxy))) throw safeError('Telegram proxy 应为 HTTP(S) 代理地址', 'CONFIG');
  return { token, ownerId: config.ownerId, proxy: config.proxy, webUrl, enabled: config.enabled !== false };
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

export function startTelegramService({ configFile, directory, sessions, understand,
  logger = console, apiFactory = createTelegramApi }) {
  const controller = new AbortController();
  let status = 'starting';
  const done = (async () => {
    try {
      const config = await readTelegramConfig(configFile);
      if (!config.enabled) { status = 'disabled'; return; }
      const api = apiFactory(config, { signal: controller.signal });
      let bot;
      let backoff = 1000;
      while (!controller.signal.aborted) {
        try {
          if (!bot) {
            const identity = await api('getMe');
            const webhook = await api('getWebhookInfo');
            if (webhook.url) throw safeError('Telegram Bot 已配置 webhook；未修改其现有接入', 409);
            const candidate = new TelegramSessions({ ...config, botId: identity.id, api, sessions, understand, signal: controller.signal,
              directory: path.join(directory, String(identity.id)) });
            try { await candidate.load(); }
            catch { throw safeError('Telegram 存档读取失败；未启动接入或覆盖旧记录', 'CONFIG'); }
            bot = candidate;
            logger.info('Codeck Telegram 会话服务已启动（仅 owner 私聊）');
          }
          status = 'connected';
          await bot.tick();
          backoff = 1000;
        } catch (error) {
          if (controller.signal.aborted) break;
          status = 'reconnecting';
          if ([401, 409, 'CONFIG'].includes(error.code)) throw error;
          logger.warn(error.safeMessage || 'Telegram 读取或投递失败；保留记录，等待重试');
          const wait = Number.isSafeInteger(error.retryAfter) && error.retryAfter > 0 ? error.retryAfter * 1000 : backoff;
          await delay(wait, undefined, { signal: controller.signal });
          backoff = Math.min(backoff * 2, 60_000);
        }
      }
    } catch (error) {
      status = controller.signal.aborted ? 'disabled' : 'error';
      if (!controller.signal.aborted) logger.warn(error.safeMessage || 'Telegram 配置或存档读取失败；入口未启动');
    }
  })();
  return { done, get status() { return status; }, stop: () => { status = 'disabled'; controller.abort(); } };
}
