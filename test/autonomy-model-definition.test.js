import test from 'node:test';
import assert from 'node:assert/strict';
import { AutonomyController } from '../src/autonomy.js';
import { recentDialogue, extractDefinition } from '../src/autonomy-definition.js';

const target = { provider: 'codex', threadId: 'thread', tmuxSession: 'work' };
const definition = { goal: '比较五种标签的净收益', strategy: '统一成交条件，分组对照', acceptance: '报告净收益及跨周稳定性', budget: '', constraints: '暂不做自适应选择' };
const turn = (user, answer) => ({ items: [{ type: 'userMessage', content: user }, { type: 'agentMessage', text: answer }] });

test('model sees only the latest dialogue round, not tools, controls or older tasks', async () => {
  const thread = { turns: [turn('旧任务', '旧结果'), turn('比较标签', '五组实验'), turn('怎么验收？', '看净收益和稳定性'), turn('先不做自适应', '限定为固定方案'),
    { items: [{ type: 'commandExecution', text: 'secret tool log' }] }] };
  const dialogue = recentDialogue(thread);
  assert.equal(dialogue.length, 1);
  let calls = 0;
  const result = await extractDefinition({ provider: 'codex', thread }, { generate: async input => {
    calls++; assert.equal(input.provider, 'codex'); assert.match(input.prompt, /先不做自适应/);
    assert.doesNotMatch(input.prompt, /比较标签|五组实验|旧任务|secret tool log/); return definition.goal;
  } });
  assert.equal(calls, 1); assert.equal(result.goal, definition.goal); assert.equal(result.budget, ''); assert.equal(result.fieldsVersion, 5);
});

test('setup reads only one turn and a stalled history read cannot leave extraction loading', async () => {
  let options, generated = false;
  const manager = new AutonomyController({ definitionTimeoutMs: 20, schedule: () => 1, cancel() {},
    readSession: async () => ({ name: 'work', agent: { kind: 'codex', id: 'thread', paneId: '%1' } }),
    readThread: async (_target, _exchange, opts) => { options = opts; return new Promise(() => {}); },
    suggestDefinition: async () => { generated = true; }, stop: async () => {} });
  await manager.start(target);
  assert.equal(options.turnLimit, 1); assert.equal(options.definitionOnly, true);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(manager.snapshot(target).definition.loading, false);
  assert.match(manager.snapshot(target).definition.error, /超时/);
  assert.equal(manager.snapshot(target).setup, true); assert.equal(generated, false); manager.close();
});

test('model timeout aborts extraction and ignores a late result without leaving setup', async () => {
  let release, signal;
  const manager = new AutonomyController({ definitionTimeoutMs: 20, schedule: () => 1, cancel() {},
    readSession: async () => ({ name: 'work', agent: { kind: 'codex', id: 'thread', paneId: '%1' } }),
    readThread: async () => ({ thread: { turns: [turn('目标', '结果')] } }),
    suggestDefinition: async input => { signal = input.signal; return new Promise(resolve => { release = resolve; }); },
    stop: async () => {} });
  await manager.start(target);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(signal.aborted, true);
  assert.equal(manager.snapshot(target).definition.loading, false);
  assert.match(manager.snapshot(target).definition.error, /超时/);
  release(definition); await new Promise(resolve => setImmediate(resolve));
  assert.equal(manager.snapshot(target).definition.goal, undefined);
  assert.equal(manager.snapshot(target).setup, true); manager.close();
});

test('empty context makes no model request; empty or protocol output never becomes a task', async () => {
  const empty = await extractDefinition({ provider: 'claude', thread: { turns: [] } }, { generate: () => { throw Error('must not call'); } });
  assert.equal(empty.goal, '');
  for (const text of ['', '   ', JSON.stringify(definition), '```json\n{}\n```']) {
    await assert.rejects(extractDefinition({ provider: 'claude', thread: { turns: [turn('继续研究', '下一步比较')] } }, { generate: async () => text }));
  }
});

test('one plain task description preserves the budget and constraints without a second extraction', async () => {
  const description = '比较五种固定标签；统一成交条件验证净收益和跨周稳定性。最多 3 轮，不做自适应，不部署。';
  let calls = 0;
  const result = await extractDefinition({ provider: 'qodercli', thread: { turns: [turn('比较固定标签，最多3轮，不部署', '按净收益和跨周稳定性验证')] } }, {
    generate: async ({ prompt }) => { calls++; assert.match(prompt, /任务描述/); return description; },
  });
  assert.equal(result.goal, description); assert.equal(calls, 1);
  assert.equal(result.strategy, ''); assert.equal(result.acceptance, '');
});

for (const provider of ['codex', 'claude', 'qodercli']) test(`${provider}: A extracts once; stale results cannot replace confirmation; empty budget stays unlimited`, async () => {
  const target = { provider, threadId: 'thread', tmuxSession: 'work' };
  let release, calls = 0;
  const manager = new AutonomyController({ schedule: () => 1, cancel() {},
    readSession: async () => ({ name: 'work', agent: { kind: provider, id: 'thread', paneId: '%1' } }),
    readThread: async () => ({ thread: { turns: [turn('比较标签', '五组实验')] } }),
    suggestDefinition: async input => { assert.equal(input.provider, provider); calls++; return new Promise(resolve => { release = resolve; }); },
    stop: async () => {}, send: () => { throw Error('must not send into terminal'); } });
  await manager.start(target, { simple: true }); await manager.start(target, { simple: true });
  assert.equal(calls, 1); assert.equal(manager.snapshot(target).definition.loading, true);
  await manager.respond(target, { requestId: manager.snapshot(target).requestId, answers: {
    goal: ['手动新目标'], strategy: ['复现再修复'], acceptance: ['回归通过'], budget: [''], constraints: [''],
  } });
  release({ ...definition, fieldsVersion: 5 }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(manager.snapshot(target).plan.goal, '手动新目标');
  assert.equal(manager.snapshot(target).plan.maxRounds, null); assert.equal(manager.snapshot(target).deadline, null); manager.close();
});

test('extraction failure leaves editable setup with an explicit error, not mechanical defaults', async () => {
  const manager = new AutonomyController({ schedule: () => 1, cancel() {},
    readSession: async () => ({ name: 'work', agent: { kind: 'codex', id: 'thread', paneId: '%1' } }),
    readThread: async () => ({ thread: { turns: [turn('机械原文', '不要照抄')] } }),
    suggestDefinition: async () => { throw Error('provider unavailable'); }, stop: async () => {} });
  await manager.start(target, { simple: true }); await new Promise(resolve => setImmediate(resolve));
  const run = manager.snapshot(target);
  assert.equal(run.setup, true); assert.equal(run.definition.loading, false); assert.ok(run.definition.error);
  assert.equal(run.definition.goal, undefined); manager.close();
});
