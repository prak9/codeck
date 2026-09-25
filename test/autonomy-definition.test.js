import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AutonomyController } from '../src/autonomy.js';
import { taskPreview, contextGoals } from '../public/autonomy-definition.js';

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
