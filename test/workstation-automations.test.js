import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { AlwaysOnStore } from '../src/always-on-store.js';
import { createAlwaysOnRuntime } from '../src/always-on-runtime.js';
import { createWorkstationAutomations } from '../src/workstation-automations.js';
import { nextCalendarDue } from '../src/workstation-automation-schedule.js';
import { WorkstationStore } from '../src/workstation-store.js';
import { createTelegramTask } from '../src/telegram-task.js';

function fixture(t, scriptDirectory, launch) {
  const store = new AlwaysOnStore(':memory:');
  const tracking = new WorkstationStore(store.db);
  let time = Date.parse('2026-11-20T00:00:00Z'), check = async () => 'first';
  const main = { name: 'research', createdAt: time - 5000, agent: { kind: 'codex', id: 'old', cwd: '/project' }, hasRunningProcess: true };
  const target = { session: 'research', createdAt: main.createdAt, provider: 'codex', threadId: 'old' };
  const sessions = [main], launched = [], sent = [];
  const parameters = { reason: 'Verify filings', target, dueAt: time + 1000, recurrenceMs: 10000, check: ['/bin/true'] };
  const service = createWorkstationAutomations({ store, tracking, scriptDirectory, now: () => time, listSessions: async () => sessions,
    precheck: () => check(), wake: () => {}, create: launch || (async task => {
      launched.push(task);
      const paneId = '%' + launched.length;
      sessions.push({ name: task.name, paneId, createdAt: time, agent: { kind: task.provider, id: 'thread-' + paneId, cwd: task.cwd } });
      return { tmuxSession: task.name, paneId, provider: task.provider };
    }), send: async value => { sent.push(value); return { submissionStatus: 'unconfirmed' }; } });
  const runtime = createAlwaysOnRuntime({ store, now: () => time, precheck: () => check(), handleScope: service.dispatch });
  t.after(() => { runtime.close(); store.close(); });
  return { service, runtime, store, tracking, sessions, launched, sent, target, parameters, main,
    advance: (delta = 10000) => { time += delta; }, setCheck: fn => { check = fn; } };
}

test('preview, no change, duplicate announcements and manual retries use one scheduler and keep a busy main untouched', async t => {
  const f = fixture(t);
  let checks = 0;
  f.setCheck(async () => { checks++; return null; });
  assert.equal((await f.service.preview(f.parameters)).mode, 'independent');
  assert.equal(checks, 0);
  assert.equal(f.service.list().length, 0);
  const rule = await f.service.create(f.parameters);
  f.advance();
  await f.runtime.tickTimers();
  assert.equal(f.service.runs(rule.id)[0].status, 'skipped');
  assert.equal(f.launched.length, 0);
  f.setCheck(async () => 'Q3 release');
  f.advance(); await f.runtime.tickTimers();
  await new Promise(r => setImmediate(r));
  await f.service.reconcile();
  const first = f.service.runs(rule.id)[0];
  assert.equal(f.launched.length, 1);
  assert.notEqual(f.launched[0].name, 'research');
  assert.equal(f.launched[0].cwd, '/project');
  assert.equal(f.tracking.task(first.taskId).target.session, f.launched[0].name);
  assert.equal(f.sent.length, 0);
  f.advance(); await f.runtime.tickTimers();
  assert.equal(f.service.runs(rule.id)[0].status, 'deduped');
  f.setCheck(async () => 'Q4 release');
  const pair = await Promise.all([f.service.runNow(rule.id, 'click-1'), f.service.runNow(rule.id, 'click-1')]);
  assert.equal(pair[0].eventId, pair[1].eventId);
  await f.runtime.drainScope(rule.scopeKey); await f.service.reconcile();
  assert.equal(f.launched.length, 2);
  assert.equal(f.service.runs(rule.id).length, 4);
  assert.equal(f.service.setEnabled(rule.id, false).status, 'paused');
  f.advance(); await f.runtime.tickTimers();
  assert.equal(f.launched.length, 2);
  assert.equal(f.tracking.task(first.taskId).status, 'active');
});

test('pausing during an awaited check never re-enables a timer or launches its event', async t => {
  const f = fixture(t);
  const rule = await f.service.create(f.parameters);
  let resolveCheck;
  f.setCheck(() => new Promise(resolve => { resolveCheck = resolve; }));
  f.advance();
  const tick = f.runtime.tickTimers();
  f.service.setEnabled(rule.id, false);
  resolveCheck('late');
  await tick;
  assert.equal(f.store.getTimer(rule.id).status, 'paused');
  assert.equal(f.store.listEvents().length, 0);
  assert.equal(f.launched.length, 0);
});

test('a project schedule needs no source session and launches once when its timer is due', async t => {
  const f = fixture(t);
  f.sessions.length = 0;
  const project = { provider: 'qodercli', cwd: os.tmpdir() };
  const input = { reason: 'Compile report', project, dueAt: f.parameters.dueAt, requestId: 'new-project' };
  assert.equal((await f.service.preview(input)).mode, 'independent');
  const rule = await f.service.create(input);
  assert.equal(rule.sessionName, null);
  assert.equal(rule.threadId, null);
  await assert.rejects(f.service.create({ ...input, project: { ...project, provider: 'claude' } }), /标识/);
  await assert.rejects(f.service.preview({ ...input, project: { ...project, cwd: 'relative' } }), /目录/);
  await assert.rejects(f.service.preview({ ...input, project: { ...project, provider: 'other' } }), /Agent/);
  await assert.rejects(f.service.preview({ ...input, target: f.target }), /来源/);
  await f.runtime.tickTimers();
  assert.equal(f.launched.length, 0);
  f.advance();
  await f.runtime.tickTimers();
  await new Promise(r => setImmediate(r));
  await f.runtime.tickTimers();
  await f.service.reconcile();
  assert.equal(f.launched.length, 1);
  const [worker] = f.launched;
  assert.equal(worker.provider, project.provider);
  assert.equal(worker.cwd, project.cwd);
  assert.match(worker.text, /Compile report/);
  assert.equal(f.service.runs(rule.id)[0].sessionName, worker.name);
  assert.deepEqual(f.sent, []);
});

test('an independent rule can be edited and dispatched after its template session was replaced', async t => {
  const f = fixture(t);
  const rule = await f.service.create(f.parameters);
  f.main.createdAt++;
  f.main.agent = { kind: 'claude', id: 'replacement', cwd: '/another-project' };
  await f.service.update(rule.id, { ...f.parameters, reason: 'Updated assignment', version: 0 });
  await f.service.runNow(rule.id, 'run');
  await f.runtime.drainScope(rule.scopeKey);
  assert.equal(f.launched.length, 1);
  assert.equal(f.launched[0].provider, 'codex');
  assert.equal(f.launched[0].cwd, '/project');
  assert.match(f.launched[0].text, /Updated assignment/);
  assert.deepEqual(f.sent, []);
});

test('a removed project is a definite launch failure, with no session to inspect', async t => {
  const f = fixture(t, undefined, createTelegramTask);
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'codeck-removed-project-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const rule = await f.service.create({ reason: 'Rebuild', project: { cwd, provider: 'codex' }, dueAt: f.parameters.dueAt });
  await fs.rmdir(cwd);
  await f.service.runNow(rule.id, 'deleted-project');
  await f.runtime.drainScope(rule.scopeKey);
  const [run] = f.service.runs(rule.id);
  assert.equal(run.dispatchStatus, 'failed');
  assert.equal(run.sessionName, null);
});

test('one-time follow-up retains source identity, waits for idle, and never retries an uncertain receipt', async t => {
  const f = fixture(t);
  const task = f.tracking.trackTask({ title: 'Reconcile', target: f.target, anchor: 'turn:9' });
  const { recurrenceMs, ...single } = f.parameters;
  const rule = await f.service.create({ ...single, taskId: task.id });
  f.advance(); await f.runtime.tickTimers();
  await new Promise(r => setImmediate(r));
  assert.equal(f.sent.length, 0);
  assert.equal(f.service.runs(rule.id)[0].dispatchStatus, 'pending');
  f.main.hasRunningProcess = false;
  await f.runtime.drainScope(rule.scopeKey);
  assert.equal(f.sent.length, 1);
  assert.equal(f.service.runs(rule.id)[0].dispatchStatus, 'unknown');
  f.runtime.recoverOnStartup(); await f.runtime.drainScope(rule.scopeKey);
  assert.equal(f.sent.length, 1);
  const original = { id: f.target.threadId, receivedDeliveryIds: [f.sent[0].commandId] };
  f.service.observeThread({ ...f.main, createdAt: f.main.createdAt + 1 }, original);
  assert.equal(f.service.runs(rule.id)[0].dispatchStatus, 'unknown');
  f.service.observeThread(f.main, original);
  assert.equal(f.service.runs(rule.id)[0].dispatchStatus, 'confirmed');
  const second = await f.service.create({ ...single, taskId: task.id });
  f.main.createdAt++;
  await f.service.runNow(second.id, 'follow-replaced');
  await f.runtime.drainScope(second.scopeKey);
  assert.equal(f.service.runs(second.id)[0].dispatchStatus, 'failed');
  assert.equal(f.sent.length, 1);
  await assert.rejects(f.service.create({ ...single, taskId: task.id }), /身份/);
});

test('weekday local wall time skips weekends, and previews preserve one occurrence across DST folds', async t => {
  const f = fixture(t);
  const calendar = { weekdays: true, timeZone: 'Asia/Shanghai', time: '09:00' };
  const pattern = { reason: 'Calendar', target: f.target, calendar };
  let p = await f.service.preview(pattern);
  assert.equal(new Date(p.dueAt).toISOString(), '2026-11-20T01:00:00.000Z');
  f.advance(3600000);
  p = await f.service.preview(pattern);
  assert.equal(new Date(p.dueAt).toISOString(), '2026-11-23T01:00:00.000Z');
  const eastern = { timeZone: 'America/New_York', time: '01:30' };
  // The fall-back morning has two local 01:30s; it is one occurrence of the daily rule.
  assert.equal(nextCalendarDue(eastern, Date.parse('2026-11-01T00:00:00Z')), Date.parse('2026-11-01T05:30:00Z'));
  assert.equal(nextCalendarDue(eastern, Date.parse('2026-11-01T05:30:00Z')), Date.parse('2026-11-02T06:30:00Z'));
  assert.equal(nextCalendarDue({ ...eastern, time: '02:30' }, Date.parse('2026-03-08T00:00:00Z')), Date.parse('2026-03-09T06:30:00Z'));
});

test('a crashed launch never replays its independent session, and a claimed event cannot be submitted by an expired worker', async t => {
  const f = fixture(t);
  const rule = await f.service.create(f.parameters);
  const run = await f.service.runNow(rule.id, 'launch');
  const pending = f.store.claimBatch({ scopeKey: rule.scopeKey, workerId: 'stale', leaseMs: 10, now: 100 });
  assert.equal(pending[0].id, run.eventId);
  f.store.recoverExpiredLeases({ now: 111 });
  const fresh = f.store.claimBatch({ scopeKey: rule.scopeKey, workerId: 'current', leaseMs: 10, now: 111 });
  assert.equal(fresh[0].id, run.eventId);
  assert.throws(() => f.store.markEventsSubmitting([run.eventId], 'stale-cmd', 112, 'stale'), /租约/);
  f.store.markEventsSubmitting([run.eventId], 'current-cmd', 113, 'current');
  f.store.recoverExpiredLeases({ now: 150 });
  assert.equal(f.service.runs(rule.id)[0].dispatchStatus, 'unknown');
  await f.runtime.drainScope(rule.scopeKey);
  assert.equal(f.launched.length, 0);
});

test('lost create response can be retried after saving; reusing the request ID for another draft is rejected', async t => {
  const f = fixture(t);
  const input = { ...f.parameters, requestId: 'save-1' };
  const [a, b] = await Promise.all([f.service.create(input), f.service.create(input)]);
  assert.equal(a.id, b.id);
  assert.equal(f.service.list().length, 1);
  await assert.rejects(f.service.create({ ...input, reason: 'different task' }), /标识/);
  assert.equal(f.service.list()[0].reason, 'Verify filings');
});

test('late original thread binds an isolated launch and confirms only the actual user turn; navigation or inspection never re-launches', async t => {
  const f = fixture(t);
  const bot = f.tracking.createBot({ name: 'Analyst', purpose: '核对公告', instructions: '优先核对原文', target: f.target });
  const rule = await f.service.create({ ...f.parameters, botId: bot.id });
  const run = await f.service.runNow(rule.id, 'start');
  await f.runtime.drainScope(rule.scopeKey);
  const worker = f.sessions.at(-1), id = worker.agent.id;
  worker.agent.id = null;
  f.advance(150_000); await f.service.reconcile();
  assert.equal(f.service.runs(rule.id)[0].dispatchStatus, 'unknown');
  worker.agent.id = id;
  const text = f.launched[0].text;
  assert.match(text, /核对公告/);
  assert.match(text, /优先核对原文/);
  const turn = { id: 't', items: [{ type: 'userMessage', id: 'user-1', content: text }] };
  const synthetic = { ...turn, items: [{ ...turn.items[0], delivery: { status: 'accepted' } }] };
  const snap = turns => ({ id, turns });
  f.service.observeThread({ ...worker, paneId: '%999' }, snap([turn]));
  assert.equal(f.service.runs(rule.id)[0].taskId, null);
  f.service.observeThread(worker, snap([synthetic]));
  const pending = f.service.runs(rule.id)[0];
  assert.equal(pending.dispatchStatus, 'launched');
  assert.equal(f.tracking.task(pending.taskId).botId, bot.id);
  f.service.observeThread(worker, snap([turn]));
  assert.equal(f.service.runs(rule.id)[0].dispatchStatus, 'confirmed');
  assert.equal(f.tracking.task(pending.taskId).runs[0].id, run.eventId);
  assert.equal(f.tracking.task(pending.taskId).status, 'active');
  assert.equal(f.launched.length, 1);
  assert.equal(f.sent.length, 0);
});

test('reactivating a consumed legacy one-time timer settles it without leaving it permanently overdue', async t => {
  const f = fixture(t);
  const dueAt = f.parameters.dueAt;
  f.store.putTimer({ id: 'legacy', kind: 'follow_up', dueAt, scopeKey: 'old', reason: 'Check' });
  // Use the legacy handler in this fixture: these events never create a workstation task.
  const engine = createAlwaysOnRuntime({ store: f.store, now: () => dueAt + 5, handleScope: async () => {} });
  t.after(() => engine.close());
  await engine.tickTimers(); await engine.drainScope('old');
  f.store.updateTimerState('legacy', { status: 'active' });
  await engine.tickTimers();
  assert.equal(f.store.getTimer('legacy').status, 'done');
  assert.equal(f.store.listEvents({ scopeKey: 'old' }).length, 1);
});

test('a Bot report uses the installed script, reports skip or failure and honours binding and pause', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codeck-bot-report-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const f = fixture(t, root);
  const bot = f.tracking.createBot({ name: 'Joe', target: f.target });
  f.tracking.bindTelegram(bot.id, { id: '7', username: 'reportbot' });
  const dir = path.join(root, bot.id);
  await fs.mkdir(dir);
  const script = path.join(dir, 'daily');
  await fs.writeFile(script, '#!/bin/sh\nexit 3\n', { mode: 0o700 });
  const input = { ...f.parameters, check: null, botId: bot.id, channelId: '7', script: 'daily' };
  await assert.rejects(f.service.create({ ...input, script: '../daily' }), /脚本/);
  await assert.rejects(f.service.create({ ...input, channelId: '8' }), /绑定/);
  const rule = await f.service.create(input);
  assert.deepEqual(await f.service.scriptOptions(), [{ botId: bot.id, script: 'daily', channelId: '7', username: 'reportbot' }]);
  f.sessions.length = 0; // The installed report runs independently of the Bot's open terminal.
  const edited = await f.service.update(rule.id, { ...input, reason: 'Evening report', version: 0 });
  assert.equal(edited.payload.workstation.script, 'daily'); assert.equal(edited.payload.workstation.channelId, '7');
  const run = async key => {
    await f.service.runNow(rule.id, key); await f.runtime.drainScope(rule.scopeKey);
    return f.service.runs(rule.id)[0];
  };
  assert.equal((await run('no-report')).dispatchStatus, 'skipped');
  await fs.writeFile(script, '#!/bin/sh\nexit 2\n');
  const failed = await run('invalid-report');
  assert.equal(failed.dispatchStatus, 'failed');
  assert.equal(f.store.db.prepare('SELECT status FROM events WHERE id=?').get(failed.eventId).status, 'failed');
  f.service.setEnabled(rule.id, false);
  await assert.rejects(f.service.runNow(rule.id, 'paused'), /未启用/);
  assert.deepEqual(f.launched, []); assert.deepEqual(f.sent, []);
});

test('editing in place keeps history, execution mode and pause state and cancels undispatched old work', async t => {
  const f = fixture(t);
  const rule = await f.service.create({ ...f.parameters, requestId: 'saved' });
  const enqueued = await f.service.runNow(rule.id, 'before-edit');
  const edited = await f.service.update(rule.id, { ...f.parameters, reason: 'New assignment', version: 0 });
  assert.equal(edited.id, rule.id); assert.equal(edited.createdAt, rule.createdAt);
  assert.equal(edited.payload.version, 1);
  assert.equal(f.service.runs(rule.id)[0].eventId, enqueued.eventId);
  await f.runtime.drainScope(rule.scopeKey); assert.deepEqual(f.launched, []);
  assert.equal(f.service.runs(rule.id)[0].dispatchStatus, 'cancelled');
  await assert.rejects(f.service.update(rule.id, { ...f.parameters, version: 0 }), /已修改/);
  assert.throws(() => f.service.remove(rule.id, 0), /已修改/);
  await f.service.runNow(rule.id, 'new'); await f.runtime.drainScope(rule.scopeKey);
  assert.equal(f.launched.length, 1); assert.match(f.launched[0].text, /New assignment/);
  f.service.setEnabled(rule.id, false);
  const paused = await f.service.update(rule.id, { ...f.parameters, reason: 'Paused edit', version: 1 });
  assert.equal(paused.status, 'paused');
  f.service.remove(rule.id, 2); assert.deepEqual(f.service.list(), []);
  assert.equal(f.sessions.length, 2);
});

test('a stale precheck cannot enqueue after editing or deleting the rule, even within the same millisecond', async t => {
  const f = fixture(t);
  const rule = await f.service.create(f.parameters);
  let finish;
  f.setCheck(() => new Promise(resolve => { finish = resolve; }));
  const pending = f.service.runNow(rule.id, 'old');
  await f.service.update(rule.id, { ...f.parameters, version: 0, reason: 'Revised' });
  finish('event'); assert.equal((await pending).status, 'cancelled');
  const deleting = f.service.runNow(rule.id, 'delete');
  f.service.remove(rule.id, 1);
  finish('event'); assert.equal((await deleting).status, 'cancelled');
  assert.equal(f.store.listEvents().length, 0);
});

test('legacy reminder edits preserve scope, prior payload and next occurrence after a concurrent tick', async t => {
  const f = fixture(t);
  const rule = f.store.putTimer({ id: 'old', kind: 'schedule', recurrenceMs: 30000, dueAt: f.parameters.dueAt,
    scopeKey: 'butler', reason: 'Original', payload: { action: 'digest' } });
  const change = { version: 0, recurrenceMs: 30000, reason: 'Revised' };
  const next = rule.dueAt + 30000;
  f.store.updateTimerState(rule.id, { dueAt: next });
  const edited = await f.service.update(rule.id, change);
  assert.equal(edited.dueAt, next); assert.equal(edited.scopeKey, 'butler');
  assert.equal(edited.payload.action, 'digest'); assert.equal(edited.payload.workstation, undefined);
});
