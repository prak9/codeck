import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { AlwaysOnStore } from '../src/always-on-store.js';
import { createButlerOrchestrator } from '../src/always-on-butler.js';
import { mountAlwaysOnRoutes } from '../src/always-on-routes.js';
import { mountWorkstationRoutes } from '../src/workstation-routes.js';
import { WorkstationStore } from '../src/workstation-store.js';

test('existing Bot bindings acquire empty private preferences on upgrade', t => {
  const db = new AlwaysOnStore(':memory:');
  t.after(() => db.close());
  db.db.exec(`CREATE TABLE workstation_bots (
    id TEXT PRIMARY KEY, target TEXT NOT NULL UNIQUE, name TEXT NOT NULL, purpose TEXT NOT NULL, created_at INTEGER NOT NULL
  )`);
  const target = { session: 'research', createdAt: 123, provider: 'codex', threadId: 't' };
  db.db.prepare("INSERT INTO workstation_bots VALUES('existing',?,'Scout','Filings',123)").run(JSON.stringify(target));
  const before = new WorkstationStore(db.db).bot('existing');
  assert.deepEqual(before, { id: 'existing', target, name: 'Scout', purpose: 'Filings', instructions: '', createdAt: 123 });
  new WorkstationStore(db.db).updateBot('existing', { instructions: 'Cite sources.' });
  assert.deepEqual(new WorkstationStore(db.db).bot('existing'), { ...before, instructions: 'Cite sources.' });
});

test('old database copy survives switching between the legacy owner API and two workstation initializations', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codeck-workstation-migration-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const original = path.join(dir, 'legacy.db'), copy = path.join(dir, 'copy.db');
  const previous = new AlwaysOnStore(original);
  const common = { id: 'existing-weekly', kind: 'schedule', scopeKey: 'session:research', reason: 'Weekly research',
    sessionName: 'research', provider: 'qodercli', threadId: 'old-thread', dueAt: 10000, recurrenceMs: 60000 };
  const active = previous.putTimer(common);
  const paused = previous.putTimer({ ...common, id: 'existing-paused', status: 'paused' });
  const approval = previous.createApproval({ scopeKey: common.scopeKey, summary: 'Allow publication?', action: { kind: 'publish' } });
  const blueprint = previous.putBlueprint({ slug: 'weekly', title: 'Weekly', goal: 'Publish notes', targetSession: 'research' });
  const proposal = previous.createProposal({ blueprintId: blueprint.id, entityKey: blueprint.entityKey, title: 'Compare quarters', rationale: 'annual changes' });
  const outbox = previous.enqueueOutbox({ scopeKey: 'butler', priority: 'digest', title: 'New filings', contentMd: 'Compare Q3', channel: 'web' }).item;
  // The pre-workstation schema stored timers but had no per-occurrence log.
  previous.db.exec('DROP TABLE IF EXISTS timer_checks');
  assert.equal(previous.db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name GLOB 'workstation_*'").get().n, 0);
  previous.close();
  await fs.copyFile(original, copy);
  const baseBytes = await fs.readFile(original);
  const store = new AlwaysOnStore(copy);
  t.after(() => store.close());
  const butler = createButlerOrchestrator({ store, enabled: false });
  const sessions = [{ name: 'research', createdAt: 1234, agent: { kind: 'qodercli', id: 'old-thread' } }];
  const app = express();
  app.use(express.json());
  const ownerOnly = (req, res, next) => req.headers.authorization === 'Bearer owner' ? next() : res.sendStatus(403);
  mountAlwaysOnRoutes(app, { store, butler, ownerOnly });
  const router = express.Router();
  const tracking = new WorkstationStore(store.db);
  mountWorkstationRoutes(router, { store: tracking, sessions: async () => sessions, ownerOnly, base: '' });
  app.use('/api/workstation', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const get = async route => {
    const response = await fetch(base + route, { headers: { Authorization: 'Bearer owner' } });
    assert.equal(response.status, 200);
    return response.json();
  };
  async function readLegacy() {
    const overview = await get('/api/always-on/overview');
    assert.deepEqual(overview.pendingApprovals, [approval]);
    assert.deepEqual(overview.pendingProposals, [proposal]);
    assert.deepEqual(overview.blueprints, [blueprint]);
    assert.deepEqual(overview.recentOutbox, [outbox]);
    assert.equal(overview.butlerEnabled, false);
    const timers = (await get('/api/always-on/timers')).timers;
    assert.deepEqual(timers.find(item => item.id === paused.id), paused);
    assert.deepEqual(timers.find(item => item.id === active.id), active);
    assert.deepEqual((await get('/api/always-on/events')).events, []);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM timer_checks').get().n, 0);
  }

  await readLegacy();
  assert.deepEqual(await get('/api/workstation'), { tasks: [], bots: [] });
  const tracked = tracking.trackTask({ title: 'Check Q3', target: { session: 'research', createdAt: 1234, provider: 'qodercli', threadId: 'old-thread' }, anchor: 'turn:1' });
  await readLegacy(); // Reading the original navigation API leaves the new task and original schedule intact.
  assert.deepEqual((await get('/api/workstation')).tasks, [tracked]);
  const reopened = new AlwaysOnStore(copy);
  try {
    assert.deepEqual(new WorkstationStore(reopened.db).overview().tasks, [tracked]);
    assert.equal(reopened.getApproval(approval.id).status, 'pending');
  } finally { reopened.close(); }
  assert.deepEqual(await fs.readFile(original), baseBytes);
});
