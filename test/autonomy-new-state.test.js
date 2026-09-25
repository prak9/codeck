import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AutonomyController } from '../src/autonomy.js';
import { fixture as runFixture } from '../test-support/autonomy-fixture.js';

test('confirmation replaces the previous draft once; subsequent automatic rounds preserve new human input', async () => {
  const f = runFixture(); const send = f.manager.send; const replacements = [];
  f.manager.send = async (...args) => { replacements.push(args[3].replaceDraft); return send(...args); };
  await f.start();
  assert.deepEqual(f.stops.at(-1), { stopBackground: true, replaceDraft: true });
  f.reply(); await f.manager.tick(); await f.manager.tick();
  assert.deepEqual(replacements, [true, false]); f.manager.close();
});

test('a fresh A request supersedes a stuck setup and ignores its late failure', async () => {
  const f = runFixture(); const read = f.manager.readSession; let reject;
  f.manager.readSession = () => new Promise((_resolve, fail) => { reject = fail; });
  const first = f.manager.start(f.target);
  f.manager.readSession = read;
  await f.manager.start(f.target); const id = f.state().id, requestId = f.state().requestId;
  reject(new Error('old setup failed')); await first;
  assert.equal(f.state().id, id); assert.equal(f.state().requestId, requestId);
  assert.equal(f.state().setup, true); assert.equal(f.state().status, 'configuring'); f.manager.close();
});

const target = { provider: 'qodercli', threadId: 'thread', tmuxSession: 'work' };
const answers = Object.fromEntries(Object.entries({ goal: '修复窄屏', strategy: '最小修复', acceptance: '切换回归通过', budget: '', constraints: '不部署' }).map(([key, value]) => [key, [value]]));
const fixture = file => new AutonomyController({ file, schedule: () => 1, cancel() {},
  readSession: async () => ({ name: 'work', agent: { kind: 'qodercli', id: 'thread', paneId: '%1' } }),
  readThread: async () => ({ thread: { turns: [] } }), stop: async () => {}, send: async () => { throw Error('no real send'); } });

test('A always uses local setup and five-field approval; no old resume API exists', async () => {
  const controller = fixture();
  await controller.start(target);
  assert.equal(controller.snapshot(target).setup, true);
  await controller.respond(target, { requestId: controller.snapshot(target).requestId, answers });
  assert.equal(controller.snapshot(target).status, 'running');
  controller.exit(target, '用户接管');
  assert.equal(controller.snapshot(target).status, 'off');
  assert.equal(controller.message, undefined); assert.equal(controller.pause, undefined);
  assert.equal(controller.restoreProposal, undefined);
  await controller.start(target);
  assert.equal(controller.snapshot(target).setup, true); assert.equal(controller.snapshot(target).round, 0);
  controller.close();
});

test('old unfinished persistence is historical data, never a resumable exchange', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeck-new-state-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'autonomy.json');
  for (const status of ['paused', 'blocked', 'waiting', 'queued', 'running', 'configuring', 'confirming', 'stopping']) {
    fs.writeFileSync(file, JSON.stringify({ version: 1, runs: [{ id: 'old', target, round: 2, status,
      summary: '已验证的成果', suspended: { exchange: { text: 'never replay' } }, exchange: { text: 'never replay' },
      plan: { goal: '原目标', acceptance: '原验收', preferences: '范围不变', maxRounds: null },
    }] }));
    const controller = fixture(file); await controller.tick();
    const run = controller.snapshot(target);
    assert.equal(run.status, 'off'); assert.equal(run.summary, '已验证的成果'); assert.equal(run.plan.goal, '原目标');
    assert.equal(run.suspended, undefined); assert.equal(run.proposal, undefined); assert.equal(run.requestId, null);
    controller.close();
  }
});
