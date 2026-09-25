import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, answers } from '../test-support/autonomy-fixture.js';

for (const [budget, rounds, minutes] of [['', null, null], ['  ', null, null], ['不限', null, null], ['5轮 / 30分钟', 5, 30],
  ['10001轮', 10001, null], ['10001分钟', null, 10001]]) test(`five-field definition accepts budget ${JSON.stringify(budget)}`, async () => {
  const f = fixture(); await f.manager.start(f.target); await f.approve(budget);
  assert.equal(f.state().plan.maxRounds, rounds); assert.equal(f.state().plan.minutes, minutes);
  assert.equal(f.state().plan.problem, undefined); assert.equal(f.state().status, 'running'); f.manager.close();
});

for (const budget of ['随便', '0轮', '-1分钟', '1.5轮', '9007199254740992轮']) test(`invalid budget ${budget} does not start work`, async () => {
  const f = fixture(); await f.manager.start(f.target); await assert.rejects(f.approve(budget), /预算/);
  assert.equal(f.sent.length, 0); assert.equal(f.state().setup, true); f.manager.close();
});

test('explicit A retries failed model preparation once without a second stop or terminal send', async () => {
  const f = fixture(); f.manager.suggestDefinition = async () => { throw Error('unavailable'); };
  await f.manager.start(f.target); await new Promise(resolve => setImmediate(resolve));
  let release, calls = 0; f.manager.suggestDefinition = async () => { calls++; return new Promise(resolve => { release = resolve; }); };
  await f.manager.start(f.target); await f.manager.start(f.target);
  assert.equal(calls, 1); assert.equal(f.stops.length, 1);
  release({ goal: '新提炼目标' }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.state().definition.goal, '新提炼目标'); assert.equal(f.sent.length, 0); f.manager.close();
});

test('late definition cannot replace approval and cancellation aborts its independent model call', async () => {
  const f = fixture(); let release, signal;
  f.manager.suggestDefinition = input => { signal = input.signal; return new Promise(resolve => { release = resolve; }); };
  await f.manager.start(f.target); const requestId = f.state().requestId;
  await f.manager.respond(f.target, { requestId, answers: answers() });
  assert.equal(signal.aborted, true); release({ goal: '迟到目标' }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.state().plan.goal, answers().goal[0]); assert.equal(f.sent.length, 0); f.manager.close();
});
