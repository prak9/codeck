import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixture } from '../test-support/autonomy-fixture.js';
import { autonomyPresentation } from '../public/remote-autonomy.js';
import { writeReceipt } from '../src/autonomy-receipt.js';

test('natural completion waits for the final reply, clears goal and retires owned receipts', async t => {
  const f = fixture(); t.after(() => f.manager.close());
  await f.manager.preparePlanning(f.target);
  const source = f.run().observation;
  writeReceipt(['--receipt', source.startFile, '--status', 'started', '--goal', 'test', '--summary', 'start']);
  await f.manager.tick();
  writeReceipt(['--receipt', source.endFile, '--status', 'completed', '--summary', 'verified', '--next', 'none', '--evidence', 'tests', '--version', 'v1', '--verification', 'pass', '--cleanup', 'verified resources']);
  f.session.hasRunningProcess = true;
  await f.manager.tick();
  assert.equal(f.state().status, 'running');
  assert.equal(f.stops.length, 0);
  f.session.hasRunningProcess = false;
  await f.manager.tick();
  assert.equal(f.state().status, 'completed');
  assert.equal(f.stops[0].stopGoal, true);
  assert.equal(fs.existsSync(path.dirname(source.startFile)), false);
  assert.equal(f.state().summary, 'verified');
});

test('manual exit retires receipts after verified owned-resource cleanup', async t => {
  const f = fixture(); t.after(() => f.manager.close());
  const plan = await f.manager.preparePlanning(f.target);
  const source = f.run().observation;
  await f.readyPlan(); await f.manager.confirmPlanning(f.target, plan.planningId);
  await f.manager.resetObserved(f.target);
  assert.equal(fs.existsSync(path.dirname(source.startFile)), false);
  assert.match(f.sent.at(-1), /清理.*本任务/);
});

test('exit waits for cleanup acknowledgement and the final reply before going off', async t => {
  const f = fixture(); f.autoCleanup = false; t.after(() => f.manager.close());
  const plan = await f.manager.preparePlanning(f.target);
  await f.readyPlan(); await f.manager.confirmPlanning(f.target, plan.planningId);
  await f.manager.resetObserved(f.target);
  assert.equal(f.state().status, 'exiting');
  assert.equal(fs.existsSync(f.run().observation.planFile), true);
  writeReceipt(['--receipt', f.run().cleanupFile, '--status', 'stopped', '--summary', 'cleaned', '--evidence', 'checked resources', '--next', 'none']);
  f.session.hasRunningProcess = true;
  await f.manager.tick(); assert.equal(f.state().status, 'exiting');
  f.session.hasRunningProcess = false;
  await f.manager.tick(); assert.equal(f.state().status, 'off');
  assert.equal(f.state().cleanupReport.evidence, 'checked resources');
});

for (const failure of ['missing', 'background', 'reported-error', 'identity', 'filesystem']) test(`exit never reports success with ${failure} cleanup`, async t => {
  const f = fixture(); f.autoCleanup = false; t.after(() => f.manager.close());
  await f.manager.preparePlanning(f.target);
  await f.manager.resetObserved(f.target);
  if (failure === 'missing') f.now += 31_000;
  else writeReceipt(['--receipt', f.run().cleanupFile, '--status', failure === 'reported-error' ? 'error' : 'stopped', '--summary', 'cleanup report', '--evidence', 'checked', '--next', 'review']);
  if (failure === 'background') f.session.agent.hasBackgroundProcess = true;
  if (failure === 'identity') f.session.agent.paneId = '%2';
  if (failure === 'filesystem') f.manager.retireReceipts = () => { throw Error('disk permission'); };
  await f.manager.tick();
  assert.equal(f.state().status, 'error');
  assert.equal(f.state().exitFailed, true);
  assert.equal(fs.existsSync(f.run().cleanupFile), failure !== 'missing');
  await assert.rejects(f.manager.preparePlanning(f.target), /退出/);
});

test('cleanup failure keeps an actionable exit and retry clears the goal', async t => {
  const f = fixture(); t.after(() => f.manager.close());
  await f.manager.preparePlanning(f.target);
  const source = f.run().observation;
  writeReceipt(['--receipt', source.startFile, '--status', 'started', '--goal', 'test', '--summary', 'start']);
  await f.manager.tick();
  writeReceipt(['--receipt', source.endFile, '--status', 'budget', '--summary', 'saved', '--next', 'review', '--cleanup', 'verified resources']);
  const stop = f.manager.stop;
  f.manager.stop = async () => { throw Error('goal clear failed'); };
  await f.manager.tick();
  assert.equal(f.state().exitFailed, true);
  assert.equal(f.state().summary, 'saved');
  assert.equal(fs.existsSync(source.endFile), true);
  await assert.rejects(f.manager.preparePlanning(f.target), /退出/);
  f.manager.stop = stop;
  await f.manager.resetObserved(f.target);
  assert.equal(f.stops[0].stopGoal, true);
  assert.equal(fs.existsSync(source.endFile), false);
});

test('confirmation is bound to the plan, rejects busy planning and starts only once', async t => {
  const f = fixture(); t.after(() => f.manager.close());
  const plan = await f.manager.preparePlanning(f.target);
  await assert.rejects(f.manager.confirmPlanning(f.target, 'stale'), /失效/);
  await assert.rejects(f.manager.confirmPlanning(f.target, plan.planningId), /规划/);
  await f.readyPlan();
  f.session.hasRunningProcess = true;
  await assert.rejects(f.manager.confirmPlanning(f.target, plan.planningId), /规划/);
  f.session.hasRunningProcess = false;
  await Promise.all([f.manager.confirmPlanning(f.target, plan.planningId), f.manager.confirmPlanning(f.target, plan.planningId)]);
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0], /create_goal/);
  assert.match(f.sent[0], /预算未指定/);
  assert.equal(f.state().status, 'running');
});

test('cancel planning stops generation, requests cleanup only and preserves pre-existing goal', async t => {
  const f = fixture(); t.after(() => f.manager.close());
  await f.manager.preparePlanning(f.target); f.session.hasRunningProcess = true;
  const directory = path.dirname(f.run().observation.planFile);
  await f.manager.resetObserved(f.target);
  assert.equal(f.stops.length, 2);
  assert.equal(f.state().status, 'off');
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0], /取消规划/);
  assert.equal(fs.existsSync(directory), false);
  assert.equal(f.manager.timer, null);
  assert.equal(f.stops[0].stopGoal, false, 'planning must preserve a pre-existing goal');
});

test('the separate stop button also clears a running autonomy goal', async t => {
  const f = fixture(); t.after(() => f.manager.close());
  const plan = await f.manager.preparePlanning(f.target);
  await f.readyPlan(); await f.manager.confirmPlanning(f.target, plan.planningId);
  await f.manager.interrupt(f.target, async () => 'stopped', { verified: true });
  assert.equal(f.stops[0].stopGoal, true);
  assert.equal(f.state().status, 'off');
  assert.equal(fs.existsSync(f.run().observation.planFile), false);
});

test('completed tasks must exit before planning a new task', async t => {
  const f = fixture(); t.after(() => f.manager.close());
  await f.manager.preparePlanning(f.target);
  f.manager.end(f.target, 'completed', 'verified');
  assert.equal(autonomyPresentation(f.state()).tone, 'idle');
  await assert.rejects(f.manager.preparePlanning(f.target), /退出/);
  await f.manager.resetObserved(f.target);
  const next = await f.manager.preparePlanning(f.target);
  assert.equal(f.state().id, next.planningId);
  await assert.rejects(f.manager.resetObserved(f.target, 'previous-run'), /已变化/);
  assert.equal(f.state().status, 'planning');
});

test('exit asks to stop native goal but preserves unrelated background processes', async t => {
  const f = fixture(); t.after(() => f.manager.close());
  const plan = await f.manager.preparePlanning(f.target);
  await f.readyPlan();
  await f.manager.confirmPlanning(f.target, plan.planningId);
  await f.manager.resetObserved(f.target);
  assert.deepEqual(f.stops[0], { stopBackground: false, stopGoal: true });
  assert.match(f.sent.at(-1), /不要续跑/);
});

test('restart during exit requires stop verification again, without automatically resuming', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeck-exit-restart-'));
  const f = fixture('codex', path.join(dir, 'state.json'));
  t.after(() => { f.manager.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const plan = await f.manager.preparePlanning(f.target);
  await f.readyPlan();
  await f.manager.confirmPlanning(f.target, plan.planningId);
  f.run().status = 'exiting'; f.manager.persist(); f.restart();
  assert.equal(f.state().exitFailed, true);
  await assert.rejects(f.manager.preparePlanning(f.target), /退出/);
  assert.equal(f.sent.length, 1);
  await f.manager.resetObserved(f.target);
  assert.equal(f.state().status, 'off');
  assert.equal(f.stops[0].stopGoal, true);
});
