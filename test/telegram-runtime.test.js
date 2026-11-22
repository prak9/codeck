import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createTelegramApi, readTelegramConfig, startTelegramService } from '../src/telegram-runtime.js';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codeck-telegram-config-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const tokenFile = path.join(directory, 'token');
  const token = '12345:fixture_secret_123456789012345';
  await fs.writeFile(tokenFile, token, { mode: 0o600 });
  const configFile = path.join(directory, 'config.json');
  await fs.writeFile(configFile, JSON.stringify({ tokenFile, ownerId: 42, proxy: 'http://127.0.0.1:7890', webUrl: 'https://codeck.example' }));
  return { directory, tokenFile, token, configFile };
}

test('credentials stay out of process arguments and message JSON survives curl config quoting', async () => {
  const token = '123:fixture_secret';
  const payload = { text: '中文 "quoted"\nline\\end', chat_id: 42 };
  let input = '';
  const api = createTelegramApi({ token, proxy: 'http://127.0.0.1:7890' }, { spawnProcess: (command, args) => {
    assert.equal(command, 'curl'); assert.ok(!args.join(' ').includes(token)); assert.ok(!args.join(' ').includes('中文'));
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough();
    child.stdin.on('data', chunk => { input += chunk; });
    child.stdin.on('finish', () => { child.stdout.write(JSON.stringify({ ok: true, result: { message_id: 1 } })); child.emit('close', 0); });
    return child;
  } });
  assert.deepEqual(await api('sendMessage', payload), { message_id: 1 });
  const data = input.split('\n').find(line => line.startsWith('data = ')).slice(7);
  assert.deepEqual(JSON.parse(JSON.parse(data)), payload);
  assert.match(input, /proxy = "http:\/\/127.0.0.1:7890"/);
});

test('config validates private credentials, owner ID, and credential-free web links', async t => {
  const f = await fixture(t);
  const config = await readTelegramConfig(f.configFile);
  assert.equal(config.webUrl, 'https://codeck.example/remote.html');
  await fs.chmod(f.tokenFile, 0o644);
  await assert.rejects(readTelegramConfig(f.configFile), /权限/);
  await fs.chmod(f.tokenFile, 0o600);
  await fs.writeFile(f.configFile, JSON.stringify({ tokenFile: f.tokenFile, ownerId: 42, webUrl: 'https://user:secret@example.com' }));
  await assert.rejects(readTelegramConfig(f.configFile), /不带凭据/);
});

test('an existing webhook is not removed and no updates or messages are consumed', async t => {
  const f = await fixture(t); const calls = [], logs = [];
  const client = startTelegramService({ ...f, logger: { info: value => logs.push(value), warn: value => logs.push(value) },
    apiFactory: () => async method => { calls.push(method); return method === 'getMe' ? { id: 7 } : { url: 'https://existing.example' }; } });
  await client.done;
  assert.deepEqual(calls, ['getMe', 'getWebhookInfo']);
  assert.match(logs.join('\n'), /webhook/);
  assert.ok(!logs.join('\n').includes(f.token));
});

test('wrong-owner persisted state stops initialization instead of falling back to a fresh inbox', async t => {
  const f = await fixture(t); const calls = [], logs = [];
  await fs.mkdir(path.join(f.directory, '7'));
  const saved = JSON.stringify({ ownerId: 99, botId: 7, offset: 123, inbox: [], outbox: [] });
  await fs.writeFile(path.join(f.directory, '7/state.json'), saved);
  const client = startTelegramService({ ...f, logger: { info() {}, warn: value => logs.push(value) },
    apiFactory: () => async method => { calls.push(method); return method === 'getMe' ? { id: 7 } : {}; } });
  await client.done;
  assert.deepEqual(calls, ['getMe', 'getWebhookInfo']);
  assert.equal(await fs.readFile(path.join(f.directory, '7/state.json'), 'utf8'), saved);
  assert.match(logs.join('\n'), /存档读取失败/);
});

test('disabled service makes no network requests and has an explicit status', async t => {
  const f = await fixture(t);
  const config = JSON.parse(await fs.readFile(f.configFile, 'utf8')); config.enabled = false;
  await fs.writeFile(f.configFile, JSON.stringify(config));
  const service = startTelegramService({ ...f, apiFactory: () => { throw new Error('must not connect'); } });
  await service.done; assert.equal(service.status, 'disabled');
});

test('two configured Telegram accounts deliver owner messages to separate fixed sessions with independent offsets', { timeout: 6000 }, async t => {
  const f = await fixture(t);
  const extra = path.join(f.directory, 'second');
  await fs.writeFile(extra, '8:extra_fixture_secret_0123456789', { mode: 0o600 });
  const settings = JSON.parse(await fs.readFile(f.configFile, 'utf8'));
  await fs.writeFile(f.configFile, JSON.stringify({ ...settings, additionalTokenFiles: [path.join(f.directory, 'missing'), extra, extra], localInboxBotIds: ['8'] }));
  const inbox = path.join(f.directory, '8', 'incoming');
  await fs.mkdir(inbox, { recursive: true });
  await fs.writeFile(path.join(inbox, '11.json'), JSON.stringify({ update_id: 11, message: { date: 5, message_id: 11,
    text: '任务 8', from: { id: 42 }, chat: { type: 'private', id: 42 } } }));
  const names = { 12345: 'research', 8: 'report' };
  const actions = [], replies = [];
  const ready = Promise.withResolvers();
  const service = startTelegramService({ ...f, logger: { info() {}, warn() {} },
    sessions: { list: async () => Object.values(names).map(name => ({ name, createdAt: 22, agent: { kind: 'codex', id: name + '-thread' } })),
      read: async () => ({ thread: { turns: [] } }), act: async (kind, target, args) => {
        actions.push([target.tmuxSession, args.text, args.commandId]); return { submissionStatus: 'submitted' };
      } },
    binding: id => ({ key: 'bound-' + id, name: names[id], since: 0,
      target: { session: names[id], provider: 'codex', threadId: names[id] + '-thread', createdAt: 22 } }),
    apiFactory: ({ token }, { signal }) => async (method, payload) => {
      const id = Number(token.split(':')[0]);
      if (method === 'getMe') return { id, username: names[id] + '_bot' };
      if (method === 'getWebhookInfo') return {};
      if (method === 'sendChatAction') return true;
      if (method === 'sendMessage') { replies.push([id, payload.text]); return { message_id: 20 }; }
      assert.equal(method, 'getUpdates');
      assert.notEqual(id, 8, 'the existing poller owns Telegram getUpdates');
      if (!payload.offset) return [{ update_id: 11, message: { date: 5, message_id: 11, text: '任务 ' + id, from: { id: 42 }, chat: { type: 'private', id: 42 } } }];
      ready.resolve();
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(Error('stopped')), { once: true }));
    } });
  t.after(async () => { service.stop(); await service.done; });
  await ready.promise;
  for (let i = 0; i < 60; i++) {
    if (!(await fs.readdir(inbox)).includes('11.json')) break;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  assert.deepEqual(await fs.readdir(inbox), []);
  assert.deepEqual(service.channels.map(c => c.username).sort(), ['report_bot', 'research_bot']);
  assert.deepEqual(actions.map(([session, body, cmd]) => [session, body.split('\n').at(-1), cmd]).sort(),
    [['report', '任务 8', 'telegram-8-11'], ['research', '任务 12345', 'telegram-12345-11']]);
  assert.deepEqual(replies, []);
  for (const id of Object.keys(names)) {
    const saved = JSON.parse(await fs.readFile(path.join(f.directory, id, 'sessions.json'), 'utf8'));
    assert.equal(saved.offset, 12); assert.equal(saved.selected.tmuxSession, names[id]);
  }
});
