import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AutonomyController } from '../src/autonomy.js';
import { taskPreview, contextGoals, contextDefinition } from '../public/autonomy-definition.js';

const target = { provider: 'codex', threadId: 'thread', tmuxSession: 'work' };
function fixture(file) {
  let now = 1000;
  const sent = [], turns = [], session = { name: 'work', agent: { kind: 'codex', id: 'thread', paneId: '%1' } };
  const manager = new AutonomyController({ file, now: () => now, schedule: () => 1, cancel() {},
    readSession: async () => session, readThread: async () => ({ thread: { turns } }),
    stop: async () => { session.hasRunningProcess = false; }, send: async (_, text) => {
      sent.push(text); turns.push({ status: 'inProgress', items: [{ type: 'userMessage', content: text }] });
    } });
  return { manager, sent, advance: ms => { now += ms; }, reply(record) {
    const turn = turns.at(-1); turn.status = 'completed';
    const nonce = /"nonce":"([^"]+)"/.exec(sent.at(-1))[1];
    turn.items.push({ type: 'agentMessage', text: '```codeck-autonomy\n' + JSON.stringify({ nonce, ...record }) + '\n```' });
  } };
}
const answers = { goal: ['修复会话切换后输入丢失'], budget: ['30 分钟'], constraints: ['不改变公开接口'],
  acceptance: ['复现后修复，切换和重连回归通过'], deliverable: ['改动及验证记录'], rounds: [''], continuation: ['false'] };

test('latest dialogue alone supplies defaults and five-field setup needs no problem field', async () => {
  const definition = contextDefinition({ turns: [
    { items: [{ type: 'userMessage', content: '修复旧任务的缓存错误' }, { type: 'agentMessage', text: '## 目标\n修复旧任务的缓存错误。\n## 策略\n替换缓存。' }] },
    { items: [{ type: 'userMessage', content: '制定下一阶段目标' }] },
  ] });
  assert.equal(definition.goal, ''); assert.equal(definition.strategy, ''); assert.deepEqual(definition.suggestions, []);
  const f = fixture(); await f.manager.start(target, { simple: true });
  const input = { goal: answers.goal, strategy: ['复现并最小修复'], acceptance: answers.acceptance,
    budget: ['5轮 / 30分钟'], constraints: [''], continuation: ['false'] };
  await f.manager.respond(target, { requestId: f.manager.snapshot(target).requestId, answers: input });
  assert.equal(f.manager.snapshot(target).plan.maxRounds, 5);
  assert.equal(f.manager.snapshot(target).plan.problem, undefined); f.manager.close();
});

test('execution failures carry an explicit error flag while human pauses do not', async () => {
  const f = fixture(); await f.manager.start(target, { simple: true });
  await f.manager.respond(target, { requestId: f.manager.snapshot(target).requestId, answers });
  f.manager.send = async () => { throw new Error('发送失败'); };
  await f.manager.tick(); assert.equal(f.manager.snapshot(target).failed, true);
  f.manager.pause(target, '用户接管'); assert.equal(f.manager.snapshot(target).failed, false);
  f.manager.close();
});

test('six-field definition preserves problem and strategy, requires them, and accepts unlimited budget', async () => {
  const f = fixture(); await f.manager.start(target, { simple: true });
  const requestId = f.manager.snapshot(target).requestId;
  const input = { problem: ['切换后输入丢失'], goal: answers.goal, strategy: ['先复现，再最小修复'],
    acceptance: answers.acceptance, budget: ['不限'], constraints: ['不重启'], continuation: ['false'] };
  await assert.rejects(f.manager.respond(target, { requestId, answers: { ...input, problem: [''] } }));
  await f.manager.respond(target, { requestId, answers: input });
  const plan = f.manager.snapshot(target).plan;
  assert.equal(plan.problem, input.problem[0]); assert.equal(plan.strategy, input.strategy[0]);
  assert.equal(plan.minutes, null); assert.equal(plan.maxRounds, null);
  await f.manager.tick(); assert.match(f.sent[0], /先复现，再最小修复/);
  f.manager.close();
});

test('all six fields are extracted from recent dialogue without inventing missing budgets', () => {
  const thread = { turns: [{ items: [{ type: 'userMessage', content: '整理下一阶段目标' },
    { type: 'agentMessage', text: '## 问题定义\n切换后输入丢失。\n## 目标\n修复切换会话时输入丢失。\n## 策略\n先复现，再修复事件顺序。\n## 验证方法\n切换和重连回归通过。\n## 预算轮次\n5轮 / 30分钟\n## 其他\n不重启服务。' }] }] };
  const result = contextDefinition(thread);
  assert.equal(result.problem, '切换后输入丢失。'); assert.equal(result.strategy, '先复现，再修复事件顺序。');
  assert.equal(result.budget, '5轮 / 30分钟'); assert.match(result.constraints, /不重启/);
  thread.turns[0].items[1].text = '问题定义：切换后输入丢失。\n目标：修复切换会话时输入丢失。\n策略：先复现，再修复事件顺序。\n验证方法：切换和重连回归通过。\n预算轮次：5轮 / 30分钟\n其他：不重启服务。';
  const inline = contextDefinition(thread);
  for (const key of ['problem', 'goal', 'strategy', 'acceptance', 'budget', 'constraints']) assert.equal(inline[key], result[key]);
  assert.equal(contextDefinition({ turns: [{ items: [{ type: 'userMessage', content: '修复输入丢失的问题' }] }] }).budget, '');
});

test('explicit A refreshes saved older setup once without stopping or sending again', async () => {
  const f = fixture(); await f.manager.start(target, { simple: true }); await Promise.resolve();
  const run = [...f.manager.runs.values()][0]; run.definition = { version: 2, goal: '旧版目标', loading: false };
  let reads = 0, release;
  f.manager.readThread = () => { reads++; return new Promise(resolve => { release = resolve; }); };
  await f.manager.start(target, { simple: true }); await f.manager.start(target, { simple: true });
  assert.equal(reads, 1); assert.equal(f.sent.length, 0);
  release({ thread: { turns: [] } }); await Promise.resolve();
  assert.equal(run.definition.fieldsVersion, 4); f.manager.close();
});

test('compact setup accepts editable definition without strategy and freezes it in execution', async () => {
  const f = fixture(); await f.manager.start(target, { simple: true });
  assert.equal(f.manager.snapshot(target).definition.version, 2);
  await f.manager.respond(target, { requestId: f.manager.snapshot(target).requestId, answers });
  assert.equal(f.manager.snapshot(target).plan.acceptance, answers.acceptance[0]);
  assert.equal(f.manager.snapshot(target).plan.deliverable, answers.deliverable[0]);
  assert.equal(f.manager.snapshot(target).plan.minutes, 30);
  await f.manager.tick(); assert.match(f.sent[0], /建立基线/); assert.match(f.sent[0], /最佳已验证/);
  f.manager.close();
});

test('context suggestions omit controls and protocol; previews distinguish evidence methods', () => {
  const thread = { turns: [{ items: ['修复切换会话时输入丢失的问题', '提交推送部署', '现在进展怎么样？请简要汇报', '<codeck-autonomy-context>'].map(content => ({ type: 'userMessage', content })) }] };
  assert.deepEqual(contextGoals(thread), ['修复切换会话时输入丢失的问题']);
  assert.match(taskPreview('提高性能').acceptance, /基线/);
  assert.match(taskPreview('研究缓存策略').deliverable, /研究结论/);
});

test('recent assistant plan resolves a short goal request into a concise editable definition', () => {
  const thread = { turns: [{ items: [
    { type: 'userMessage', content: '制定下下一阶段目标' },
    { type: 'agentMessage', text: '## 下一阶段目标\n\n在统一成交模型下，比较五种标签的完整策略净收益。\n\n暂不推进每周自适应选择。\n\n### 验收方法\n同条件配对实验，报告跨周稳定性。\n\n### 最终交付\n各品种排名、收益差和保留基线的决策。' },
  ] }] };
  const result = contextDefinition(thread);
  assert.equal(result.goal, '在统一成交模型下，比较五种标签的完整策略净收益。');
  assert.match(result.acceptance, /配对实验/); assert.match(result.deliverable, /各品种排名/);
  assert.match(result.constraints, /暂不推进/);
  assert.doesNotMatch(result.goal, /制定下|##/);
  thread.turns.push({ items: [{ type: 'userMessage', content: '先不做实验，修复切换会话时输入丢失的问题。' }] });
  assert.match(contextDefinition(thread).goal, /修复切换/);
  assert.doesNotMatch(contextDefinition(thread).goal, /比较五种/);
});

test('explicit continuation retains remaining budget and rejects changed acceptance', async () => {
  const f = fixture(); await f.manager.start(target, { simple: true });
  await f.manager.respond(target, { requestId: f.manager.snapshot(target).requestId, answers });
  f.advance(60_000); f.manager.pause(target, '用户接管');
  await f.manager.start(target, { simple: true });
  const requestId = f.manager.snapshot(target).requestId;
  await assert.rejects(f.manager.respond(target, { requestId, answers: { ...answers, continuation: ['true'], acceptance: ['降低标准'] } }));
  await f.manager.respond(target, { requestId, answers: { ...answers, continuation: ['true'] } });
  assert.equal(f.manager.snapshot(target).deadline, 1000 + 30 * 60_000);
  f.manager.close();
});

test('slow suggestions cannot block setup or replace a later confirmed definition', async () => {
  const f = fixture(); let release;
  f.manager.readThread = () => new Promise(resolve => { release = resolve; });
  await f.manager.start(target, { simple: true });
  assert.equal(f.manager.snapshot(target).setup, true);
  await f.manager.respond(target, { requestId: f.manager.snapshot(target).requestId, answers });
  release({ thread: { turns: [{ items: [{ type: 'userMessage', content: '迟到的旧任务，不能替换当前目标' }] }] } });
  await Promise.resolve();
  assert.equal(f.manager.snapshot(target).plan.goal, answers.goal[0]);
  assert.equal(f.sent.length, 0); f.manager.close();
});

test('checkpoint preserves best across unsuccessful experiments; restart never replays', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codeck-definition-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'autonomy.json');
  const f = fixture(file); await f.manager.start(target, { simple: true });
  await f.manager.respond(target, { requestId: f.manager.snapshot(target).requestId, answers });
  await f.manager.tick();
  const best = { version: 'abc+diff1', evidence: '回归通过', artifact: 'patch-1' };
  f.reply({ status: 'continue', summary: '首个可靠结果', next: '检查边界', progress: true, best,
    checkpoint: { baseline: '原有一个失败', version: 'abc+diff1', verification: '新增回归通过', current: '边界待验证' } });
  await f.manager.tick(); await f.manager.tick();
  f.reply({ status: 'continue', summary: '否定一个假设', next: '尝试另一解释', progress: false,
    checkpoint: { baseline: '原有一个失败', version: 'abc+diff2', verification: '实验失败', current: '未验证patch-2' } });
  await f.manager.tick(); assert.deepEqual(f.manager.snapshot(target).best, best);
  f.manager.close(); const restored = fixture(file);
  assert.equal(restored.manager.snapshot(target).status, 'paused');
  assert.deepEqual(restored.manager.snapshot(target).best, best);
  await restored.manager.tick(); assert.equal(restored.sent.length, 0); restored.manager.close();
});

test('deadline stops current execution and requests only a summary; completion needs version evidence', async () => {
  const f = fixture(); await f.manager.start(target, { simple: true });
  await f.manager.respond(target, { requestId: f.manager.snapshot(target).requestId, answers });
  await f.manager.tick(); f.advance(30 * 60000); await f.manager.tick();
  assert.equal(f.manager.snapshot(target).status, 'exiting');
  await f.manager.tick(); assert.equal(f.sent.length, 2); assert.match(f.sent[1], /"phase":"summary"/);
  assert.equal(f.manager.snapshot(target).round, 1); f.manager.close();
  const g = fixture(); await g.manager.start(target, { simple: true });
  await g.manager.respond(target, { requestId: g.manager.snapshot(target).requestId, answers });
  await g.manager.tick(); g.reply({ status: 'complete', summary: '好了', evidence: '声称通过' }); await g.manager.tick();
  assert.equal(g.manager.snapshot(target).status, 'paused'); assert.match(g.manager.snapshot(target).reason, /版本/); g.manager.close();
});
