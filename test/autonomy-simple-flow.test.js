import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixture } from '../test-support/autonomy-fixture.js';
import { autonomyPresentation } from '../public/remote-autonomy.js';

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

test('cancel planning stops generation and never sends execution or summary', async t => {
  const f = fixture(); t.after(() => f.manager.close());
  await f.manager.preparePlanning(f.target); f.session.hasRunningProcess = true;
  await f.manager.resetObserved(f.target);
  assert.equal(f.stops.length, 1);
  assert.equal(f.state().status, 'off');
  assert.equal(f.sent.length, 0);
});

test('finished tasks look idle and can directly plan a new task', async t => {
  const f = fixture(); t.after(() => f.manager.close());
  await f.manager.preparePlanning(f.target);
  f.manager.end(f.target, 'completed', 'verified');
  assert.equal(autonomyPresentation(f.state()).tone, 'idle');
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
