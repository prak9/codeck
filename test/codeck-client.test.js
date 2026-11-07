import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import express from 'express';
import { WebSocketServer } from 'ws';
import { loadTlsOptions } from '../src/tls.js';
import { AgentHub, AgentRegistry } from '../src/agent-connection.js';
import { createPageStore, mountPublishedPages } from '../src/published-pages.js';
import { createConditionalTasks } from '../src/conditional-tasks.js';
import { createCheckpoints } from '../src/session-checkpoints.js';
import { runCodeck, loadClientConnection } from '../src/codeck-client.js';
const exec = promisify(execFile);

test('documented CLI journey uses authenticated HTTPS/AgentHub and publishes a stable source through subprocesses', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codeck-cli-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const tls = loadTlsOptions({ CODECK_DATA_DIR: directory });
  const sessions = [{ name: 'fixture', status: 'done', agent: { id: 'thread', kind: 'qodercli' } }];
  const sends = [], creates = [];
  const backend = new EventEmitter();
  backend.openThread = async () => ({ thread: { id: 'thread', turns: [{ id: 't1', status: 'completed', items: [{ type: 'agentMessage', text: '已验证结果' }] }] } });
  const hub = new AgentHub(new AgentRegistry({ qodercli: backend }, {
    sendTmuxMessage: async payload => { sends.push(payload); return { submissionStatus: 'submitted' }; },
  }));
  const app = express(); app.use(express.json({ limit: '20mb' }));
  const auth = (req, res, next) => { if (req.get('Authorization') !== 'Bearer fixture-secret') return res.sendStatus(401); req.auth = { owner: true }; next(); };
  app.get('/api/sessions', auth, (_req, res) => res.json({ sessions }));
  app.post('/api/sessions', auth, (req, res) => { creates.push(req.body); res.status(201).json({ ok: true }); });
  const checkpoints = await createCheckpoints(path.join(directory, 'checkpoints.json'));
  app.put('/api/sessions/:name/checkpoint', auth, async (req, res) => { await checkpoints.set(sessions[0], req.body); res.json(checkpoints.get(sessions[0])); });
  const tasks = await createConditionalTasks({ directory: path.join(directory, 'tasks'), idle: async () => true, send: async () => {} });
  app.put('/api/tasks/:id', auth, async (req, res) => res.json(await tasks.put(req.params.id, { ...req.body, provider: 'qodercli', threadId: 'thread' })));
  app.get('/api/tasks', auth, async (_req, res) => res.json({ tasks: await tasks.list() }));
  app.delete('/api/tasks/:id', auth, async (req, res) => { await tasks.remove(req.params.id); res.sendStatus(204); });
  mountPublishedPages(app, { store: createPageStore(path.join(directory, 'pages')), apiAuth: auth, pageAuth: auth });
  const server = https.createServer(tls, app), wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (req.headers['sec-websocket-protocol'] !== `codeck.${Buffer.from('fixture-secret').toString('base64url')}`) return socket.destroy();
    wss.handleUpgrade(req, socket, head, ws => hub.handleConnection(ws));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const socket of wss.clients) socket.terminate(); wss.close(); await new Promise(resolve => server.close(resolve)); });
  const tokenFile = path.join(directory, 'token'); await fs.writeFile(tokenFile, 'fixture-secret', { mode: 0o600 });
  const configFile = path.join(directory, 'client.json');
  await fs.writeFile(configFile, JSON.stringify({ url: `https://127.0.0.1:${server.address().port}`, tokenFile, caFile: path.join(directory, 'cert.pem') }));
  const env = { ...process.env, CODECK_CLIENT_CONFIG: configFile, CODECK_TOKEN: '', CODECK_URL: '', CODECK_CA_FILE: '' };
  const cli = async (...args) => JSON.parse((await exec(process.execPath, ['scripts/codeck.mjs', ...args, '--json'], { env })).stdout);
  assert.equal((await cli('session', 'list')).sessions[0].name, 'fixture');
  assert.equal((await cli('session', 'read', 'fixture')).thread.turns[0].items[0].text, '已验证结果');
  const prompt = path.join(directory, 'prompt.txt'); await fs.writeFile(prompt, 'only this task\n$() is text');
  await cli('session', 'send', 'fixture', '--file', prompt);
  assert.equal(sends.length, 1); assert.equal(sends[0].text, 'only this task\n$() is text');
  await cli('session', 'create', 'new-task', '--provider', 'codex', '--cwd', directory);
  assert.equal(creates.length, 1); assert.equal(creates[0].cwd, directory);
  const note = path.join(directory, 'note.txt'); await fs.writeFile(note, '验证进行中');
  assert.equal((await cli('session', 'checkpoint', 'fixture', '--file', note)).text, '验证进行中');
  const taskFile = path.join(directory, 'task.json');
  await fs.writeFile(taskFile, JSON.stringify({ session: 'fixture', everyMinutes: 30, cwd: directory, check: ['/bin/true'], prompt: 'analyze' }));
  await cli('task', 'put', 'watch', '--file', taskFile);
  assert.equal((await cli('task', 'list')).tasks[0].session, 'fixture');
  await cli('task', 'remove', 'watch'); assert.equal((await cli('task', 'list')).tasks.length, 0);
  const file = path.join(directory, 'report.html'); await fs.writeFile(file, '<h1>report</h1>');
  const a = await cli('page', 'publish', file, '--title', '报告', '--source-key', '/project:report', '--session', 'fixture', '--revision', 'v1');
  await fs.writeFile(file, '<h1>updated</h1>');
  const b = await cli('page', 'publish', file, '--title', '报告', '--source-key', '/project:report', '--revision', 'v2');
  assert.equal(a.id, b.id); assert.notEqual(a.contentHash, b.contentHash);
  assert.equal((await cli('page', 'list')).pages.length, 1);
  const shared = await cli('page', 'share', a.id); assert.match(shared.url, /\?share=/);
  assert.equal((await cli('page', 'revoke', a.id)).revoked, true);
});

test('CLI refuses ignored options, unavailable agents, and never resends after a lost acknowledgement', async t => {
  await assert.rejects(loadClientConnection({ CODECK_URL: 'http://example.com', CODECK_TOKEN: 'secret' }), /HTTPS/);
  await assert.rejects(runCodeck(['session', 'create', 'x', '--file', 'ignored'], {}), /不支持/);
  await assert.rejects(runCodeck(['session', 'send', 'shell', '--file', 'anything'], {}, { request: async () => ({ sessions: [{ name: 'shell' }] }) }), /Shell/);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codeck-cli-loss-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'prompt'); await fs.writeFile(file, 'task');
  let effects = 0;
  await assert.rejects(runCodeck(['session', 'send', 'work', '--file', file], {}, {
    request: async () => ({ sessions: [{ name: 'work', agent: { kind: 'codex', id: 'thread' } }] }),
    rpc: async () => { effects++; throw new Error('连接断开，操作结果待核实'); },
  }), /commandId: cli-.*未自动重发/);
  assert.equal(effects, 1);
});
