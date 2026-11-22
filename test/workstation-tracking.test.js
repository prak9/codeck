import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { AlwaysOnStore } from '../src/always-on-store.js';
import { createMemoryStore } from '../src/always-on-memory.js';
import { createWorkfiles, mountWorkfiles, workfileIdentity } from '../src/workfiles.js';
import { WorkstationStore } from '../src/workstation-store.js';
import { mountWorkstationRoutes } from '../src/workstation-routes.js';

const original = { name: 'research', createdAt: 1000, agent: { kind: 'codex', id: 'thread-1' } };
const target = { session: 'research', createdAt: 1000, provider: 'codex', threadId: 'thread-1' };

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codeck-workstation-'));
  const existing = new AlwaysOnStore(path.join(root, 'state.db'));
  const session = { ...original, cwd: root };
  const sessions = [session];
  const files = createWorkfiles(path.join(root, 'files'));
  const store = new WorkstationStore(existing.db);
  const app = express();
  app.use(express.json());
  const ownerOnly = (req, res, next) => req.headers.authorization === 'Bearer owner' ? next() : res.sendStatus(403);
  mountWorkstationRoutes(app, { store, workfiles: files, sessions: async () => sessions, ownerOnly,
    telegramChannels: () => ['7', '8'].map(id => ({ id, username: 'bot' + id, status: 'connected' })) });
  mountWorkfiles(app, { store: files, pages: { list: async () => [] }, sessions: async () => sessions, ownerOnly });
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    existing.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  function request(route = '', method = 'GET', body, owner = true) {
    return fetch(base + '/api/workstation' + route, { method, headers: { Authorization: owner ? 'Bearer owner' : 'Bearer share', 'Content-Type': 'application/json' },
      body: JSON.stringify(body) });
  }
  return { root, base, session, sessions, store, files, request };
}

test('two tasks in one conversation keep their own anchors and immutable evidence through restart and session replacement', async t => {
  const f = await fixture(t);
  const first = { title: 'Compare filings', anchor: 'turn:17', target };
  const pair = await Promise.all([f.request('/tasks', 'POST', first), f.request('/tasks', 'POST', first)]);
  const [a, duplicate] = await Promise.all(pair.map(response => response.json()));
  assert.equal(a.id, duplicate.id);
  assert.ok(a.id);
  const b = await (await f.request('/tasks', 'POST', { title: 'Compare guidance', anchor: 'turn:18', target })).json();
  assert.notEqual(a.id, b.id);
  const file = path.join(f.root, 'report.md');
  const result = { key: 'report', kind: 'result', path: file, title: 'Report' };
  await fs.writeFile(file, 'version one');
  const record = await f.files.put(f.session, { ...result, revision: 'v1' });
  const output = { itemId: record.id, versionId: record.versions[0].id };
  for (let i = 0; i < 2; i++) {
    assert.equal((await f.request('/tasks/' + a.id, 'PATCH', { output })).status, 200);
  }
  const invalid = await f.request('/tasks/' + a.id, 'PATCH', { output: { ...output, versionId: 'missing' }, status: 'delivered' });
  assert.equal(invalid.status, 404);
  assert.notEqual(f.store.task(a.id).status, 'delivered');
  await fs.writeFile(file, 'version two');
  const v2 = (await f.files.put(f.session, { ...result, revision: 'v2' })).versions[1];
  await f.request('/tasks/' + b.id, 'PATCH', { output: { ...output, versionId: v2.id }, status: 'delivered', progress: 'Guidance verified.' });
  f.sessions[0] = { ...original, createdAt: 2000 }; // Same provider, thread and display name.
  assert.equal((await f.request('/tasks', 'POST', { ...first, anchor: 'turn:19' })).status, 409);
  const restartedDB = new AlwaysOnStore(path.join(f.root, 'state.db'));
  try {
    const saved = new WorkstationStore(restartedDB.db);
    assert.equal(saved.task(a.id).outputs.length, 1);
    assert.equal(saved.task(b.id).status, 'delivered');
    assert.equal(saved.task(b.id).progress, 'Guidance verified.');
    assert.equal(saved.task(a.id).anchor, 'turn:17');
    const pin = saved.task(a.id).outputs[0];
    assert.equal(pin.revision, 'v1');
    assert.equal(pin.identity, workfileIdentity(f.session));
    const response = await fetch(f.base + '/api/sessions/research/workfiles/' + pin.itemId + '/' + pin.versionId + '?identity=' + pin.identity, { headers: { Authorization: 'Bearer owner' } });
    assert.equal(await response.text(), 'version one');
  } finally { restartedDB.close(); }
});

test('bot binding is unique; detaching keeps task and run history while repeat deliveries preserve run identity', async t => {
  const f = await fixture(t);
  const memory = createMemoryStore({ directory: path.join(f.root, 'memory') });
  await memory.writeFile('instructions.md', 'Follow project permissions.');
  const live = structuredClone(f.sessions);
  const bot = await (await f.request('/bots', 'POST', { name: 'Scout', purpose: 'Check filings', target })).json();
  assert.ok(bot.id);
  assert.equal(bot.instructions, '');
  assert.equal((await f.request('/bots', 'POST', { name: 'Other', target })).status, 409);
  const edits = await Promise.all([f.request('/bots/' + bot.id, 'PATCH', { instructions: 'Include the filing date.' }),
    f.request('/bots/' + bot.id, 'PATCH', { purpose: 'Company research' })]);
  assert.deepEqual(edits.map(res => res.status), [200, 200]);
  assert.deepEqual(f.store.bot(bot.id), { ...bot, instructions: 'Include the filing date.', purpose: 'Company research' });
  assert.equal((await f.request('/bots/' + bot.id, 'PATCH', { instructions: [] })).status, 400);
  const task = f.store.trackTask({ title: 'Filings', target, anchor: 'rule:2026-01', botId: bot.id, status: 'active' });
  const another = f.store.trackTask({ title: 'Forecast', target, anchor: 'turn:23' });
  const run = { id: 'event:1', status: 'unknown', target: { ...target, session: 'worker', threadId: 'other-id' }, summary: 'Awaiting receipt' };
  f.store.recordRun(task.id, run);
  f.store.recordRun(task.id, { ...run, status: 'done' });
  assert.throws(() => f.store.recordRun(another.id, run));
  assert.throws(() => f.store.recordRun(task.id, { ...run, target }));
  assert.equal((await f.request('/bots/' + bot.id, 'DELETE')).status, 204);
  const overview = await (await f.request()).json();
  assert.deepEqual(overview.bots, []);
  const saved = overview.tasks.find(item => item.id === task.id);
  assert.equal(saved.botId, null);
  assert.equal(saved.runs.length, 1);
  assert.deepEqual(saved.runs[0].target, run.target);
  assert.equal(saved.runs[0].status, 'done');
  assert.equal(saved.status, 'active');
  assert.deepEqual(saved.target, target);
  assert.deepEqual(f.sessions, live);
  assert.equal((await memory.readFile('instructions.md')).content, 'Follow project permissions.');
});

test('share and stale targets cannot access owner operations, including names reused on a different provider or thread', async t => {
  const f = await fixture(t);
  for (const [route, method] of [['', 'GET'], ['/tasks', 'POST'], ['/tasks/test', 'PATCH'], ['/bots', 'POST'], ['/bots/test', 'PATCH'], ['/bots/test', 'DELETE']]) {
    assert.equal((await f.request(route, method, undefined, false)).status, 403);
  }
  for (const bad of [{ ...target, provider: 'qodercli' }, { ...target, threadId: 'thread-2' }, { ...target, createdAt: null }]) {
    const response = await f.request('/bots', 'POST', { name: 'Scout', target: bad });
    assert.ok([400, 409].includes(response.status));
  }
  assert.deepEqual((await (await f.request()).json()).tasks, []);
});

test('one-to-one Telegram bindings are owner-only and survive restart, retries and stale detach', async t => {
  const f = await fixture(t);
  for (const path of ['/bots', '/telegram']) assert.equal((await f.request(path, 'GET', undefined, false)).status, 403);
  const a = f.store.createBot({ name: '投研', target });
  const b = f.store.createBot({ name: '日报', target: { ...target, session: 'report' } });
  f.sessions.push({ ...original, name: 'report' });
  const route = id => '/bots/' + id + '/telegram';
  const assign = (id, channelId, owner = true) => f.request(route(id), 'PUT', { channelId }, owner);
  assert.equal((await assign(a.id, '7', false)).status, 403);
  assert.equal((await assign(a.id, '17')).status, 409);
  const attempts = await Promise.all([assign(a.id, '7'), assign(a.id, '7')]);
  assert.ok(attempts.every(r => r.status === 204));
  assert.equal((await assign(b.id, '7')).status, 409);
  assert.equal((await assign(a.id, '8')).status, 409);
  assert.equal((await assign(b.id, '8')).status, 204);
  const { bound, available } = await (await f.request(route(a.id))).json();
  assert.equal(bound.username, 'bot7'); assert.deepEqual(available, []);
  const reopened = new WorkstationStore(f.store.db);
  assert.equal(reopened.telegramBinding(7).name, '投研');
  const detach = () => f.request(route(a.id), 'DELETE', { channelId: bound.id, key: bound.key });
  assert.equal((await detach()).status, 204);
  assert.equal((await assign(a.id, '7')).status, 204);
  assert.equal((await detach()).status, 409);
  f.store.removeBot(a.id);
  assert.equal(reopened.telegramBinding(7).target, null);
  assert.equal(reopened.telegramBinding(8).target.session, 'report');
});
