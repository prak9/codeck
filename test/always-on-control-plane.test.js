import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import http from 'node:http';
import { AlwaysOnStore } from '../src/always-on-store.js';
import { createAlwaysOnRuntime, parseDurationMs } from '../src/always-on-runtime.js';
import { mountAlwaysOnRoutes } from '../src/always-on-routes.js';
import { runCodeck } from '../src/codeck-client.js';

function startTestServer(app) {
  return new Promise(resolve => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

test('AlwaysOnStore deduplicates events by dedupeKey and enforces single-active-worker per scope', () => {
  const store = new AlwaysOnStore(':memory:');
  try {
    const first = store.enqueueEvent({ scopeKey: 'butler', source: 'telegram', dedupeKey: 'tg:100', payload: { text: 'hi' }, now: 1000 });
    const dup = store.enqueueEvent({ scopeKey: 'butler', source: 'telegram', dedupeKey: 'tg:100', payload: { text: 'hi again' }, now: 1005 });
    assert.equal(first.inserted, true);
    assert.equal(dup.inserted, false);
    assert.equal(dup.event.id, first.event.id);

    store.enqueueEvent({ scopeKey: 'butler', source: 'telegram', dedupeKey: 'tg:101', payload: { text: 'second' }, now: 1010 });
    store.enqueueEvent({ scopeKey: 'session:research', source: 'annotation', dedupeKey: 'ann:1', payload: { text: 'fix' }, now: 1012 });

    const batch1 = store.claimBatch({ scopeKey: 'butler', workerId: 'w1', leaseMs: 10_000, limit: 10, now: 2000 });
    assert.equal(batch1.length, 2);
    assert.deepEqual(batch1.map(e => e.dedupeKey), ['tg:100', 'tg:101']);

    // Another event arrives while butler is processing — must NOT be claimed by a second worker.
    store.enqueueEvent({ scopeKey: 'butler', source: 'telegram', dedupeKey: 'tg:102', payload: { text: 'third' }, now: 2500 });
    const competing = store.claimBatch({ scopeKey: 'butler', workerId: 'w2', leaseMs: 10_000, limit: 10, now: 3000 });
    assert.equal(competing.length, 0);

    // Independent scope CAN be claimed concurrently.
    const otherScope = store.claimBatch({ scopeKey: 'session:research', workerId: 'w2', leaseMs: 10_000, limit: 10, now: 3000 });
    assert.equal(otherScope.length, 1);

    // Completing batch1 allows next claim for butler.
    store.completeEvents(batch1.map(e => e.id), { status: 'done', now: 3500 });
    const batch2 = store.claimBatch({ scopeKey: 'butler', workerId: 'w2', leaseMs: 10_000, limit: 10, now: 3600 });
    assert.equal(batch2.length, 1);
    assert.equal(batch2[0].dedupeKey, 'tg:102');
  } finally {
    store.close();
  }
});

test('Crash recovery requeues pre-submit leases but marks post-submit leases unknown without replay', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codeck-always-on-crash-'));
  const dbFile = path.join(dir, 'super-agent.db');
  try {
    const store1 = new AlwaysOnStore(dbFile);
    const e1 = store1.enqueueEvent({ scopeKey: 'session:a', source: 'timer', payload: { step: 'before-submit' }, now: 1000 }).event;
    const e2 = store1.enqueueEvent({ scopeKey: 'session:b', source: 'timer', payload: { step: 'after-submit' }, now: 1000 }).event;
    store1.claimBatch({ scopeKey: 'session:a', workerId: 'crashed-1', leaseMs: 5000, now: 1000 });
    store1.claimBatch({ scopeKey: 'session:b', workerId: 'crashed-1', leaseMs: 5000, now: 1000 });
    // e2 crossed the external-effect boundary before crash.
    store1.markEventsSubmitting([e2.id], 'cmd-external-1', 1500);
    store1.close();

    // Simulate process restart after lease expiry.
    const store2 = new AlwaysOnStore(dbFile);
    const recovered = store2.recoverExpiredLeases({ now: 10_000 });
    assert.deepEqual(recovered, { requeued: 1, markedUnknown: 1 });

    const [stateA] = store2.listEvents({ scopeKey: 'session:a' });
    const [stateB] = store2.listEvents({ scopeKey: 'session:b' });
    assert.equal(stateA.status, 'pending');
    assert.equal(stateB.status, 'unknown');
    assert.equal(stateB.commandId, 'cmd-external-1');
    assert.match(stateB.error, /未自动重放/);
    assert.deepEqual(store2.pendingScopes(), ['session:a']);
    store2.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('AlwaysOnRuntime batches events, serializes per scope, and fires follow_up + schedule timers with precheck', async () => {
  const store = new AlwaysOnStore(':memory:');
  let clock = 10_000;
  const handled = [];
  let precheckValue = null;

  const runtime = createAlwaysOnRuntime({
    store,
    now: () => clock,
    precheck: async () => precheckValue,
    handleScope: async (scopeKey, batch) => {
      handled.push({ scopeKey, count: batch.length, reasons: batch.map(e => e.payload.reason || e.payload.text) });
    },
  });

  try {
    // 1. Follow-up timer fires once and marks done.
    const fu = store.putTimer({
      id: 'fu-1',
      kind: 'follow_up',
      scopeKey: 'session:research',
      dueAt: 15_000,
      reason: '检查回测结果',
      sessionName: 'research',
      now: clock,
    });
    // 2. Schedule timer with precheck skips when precheck returns null (zero events).
    store.putTimer({
      id: 'sch-1',
      kind: 'schedule',
      scopeKey: 'butler',
      dueAt: 15_000,
      recurrenceMs: 60_000,
      reason: '巡检新财报',
      cwd: '/tmp',
      check: ['/bin/true'],
      now: clock,
    });

    clock = 16_000;
    const tick1 = await runtime.tickTimers();
    assert.equal(tick1.fired, 1);
    assert.equal(tick1.skipped, 1);
    assert.equal(store.getTimer(fu.id).status, 'done');
    assert.equal(store.getTimer('sch-1').status, 'active');
    assert.equal(store.getTimer('sch-1').lastStatus, 'skipped');
    assert.equal(store.getTimer('sch-1').dueAt, 76_000);

    // Wait for async wake drain.
    await runtime.drainScope('session:research');
    assert.equal(handled.length, 1);
    assert.equal(handled[0].scopeKey, 'session:research');
    assert.deepEqual(handled[0].reasons, ['检查回测结果']);

    // 3. Next schedule tick returns stable event key -> enqueues once, dedupes if same key repeats.
    precheckValue = 'filing-2026Q3';
    clock = 76_000;
    const tick2 = await runtime.tickTimers();
    assert.equal(tick2.fired, 1);
    await runtime.drainScope('butler');
    assert.equal(handled.length, 2);
    assert.equal(handled[1].scopeKey, 'butler');

    // Same eventKey on next cycle is deduplicated!
    clock = 136_000;
    const tick3 = await runtime.tickTimers();
    assert.equal(tick3.fired, 0);
    assert.equal(tick3.skipped, 1);
    assert.equal(store.getTimer('sch-1').lastStatus, 'deduped');
  } finally {
    runtime.close();
    store.close();
  }
});

test('parseDurationMs parses common duration strings cleanly', () => {
  assert.equal(parseDurationMs('30s'), 30_000);
  assert.equal(parseDurationMs('15m'), 900_000);
  assert.equal(parseDurationMs('2h'), 7_200_000);
  assert.equal(parseDurationMs('1d'), 86_400_000);
  assert.equal(parseDurationMs('invalid'), null);
  assert.equal(parseDurationMs('-5m'), null);
});

test('AlwaysOn HTTP routes enforce ownerOnly and support CLI timer commands', async () => {
  const store = new AlwaysOnStore(':memory:');
  const runtime = createAlwaysOnRuntime({
    store,
    handleScope: async () => {},
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.auth = { owner: req.headers['x-owner'] !== '0' };
    next();
  });
  const ownerOnly = (req, res, next) => (req.auth.owner ? next() : res.status(403).json({ error: 'forbidden' }));
  mountAlwaysOnRoutes(app, {
    store,
    runtime,
    resolveSessionTarget: async name => ({ tmuxSession: name, provider: 'codex', threadId: 'thr-1' }),
    ownerOnly,
  });

  const { server, baseUrl } = await startTestServer(app);
  try {
    // Share token blocked
    const forbidden = await fetch(`${baseUrl}/api/always-on/overview`, { headers: { 'x-owner': '0' } });
    assert.equal(forbidden.status, 403);

    // Owner CLI flow via mock request adapter
    const request = async (_conn, endpoint, method = 'GET', body) => {
      const res = await fetch(`${baseUrl}${endpoint}`, {
        method,
        headers: body !== undefined ? { 'content-type': 'application/json' } : {},
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      if (res.status === 204) return {};
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      return data;
    };

    const created = await runCodeck(['timer', 'followup', '--in', '30m', '--reason', '复查测试结果', '--session', 'research'], {}, { request });
    assert.equal(created.kind, 'follow_up');
    assert.equal(created.scopeKey, 'session:research');
    assert.equal(created.provider, 'codex');

    const listed = await runCodeck(['timer', 'list'], {}, { request });
    assert.equal(listed.timers.length, 1);

    const paused = await runCodeck(['timer', 'pause', created.id], {}, { request });
    assert.equal(paused.status, 'paused');

    const resumed = await runCodeck(['timer', 'resume', created.id], {}, { request });
    assert.equal(resumed.status, 'active');

    const removed = await runCodeck(['timer', 'remove', created.id], {}, { request });
    assert.deepEqual(removed, { removed: created.id });
    assert.equal((await runCodeck(['timer', 'list'], {}, { request })).timers.length, 0);
  } finally {
    runtime.close();
    store.close();
    await new Promise(resolve => server.close(resolve));
  }
});
