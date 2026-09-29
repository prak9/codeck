import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixture } from '../test-support/autonomy-fixture.js';
import { writeReceipt } from '../src/autonomy-receipt.js';
import { autonomyPresentation } from '../public/remote-autonomy.js';

test('legacy controller methods and stored runs are not supported', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeck-retired-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'autonomy.json');
  fs.writeFileSync(file, JSON.stringify({ version: 2, runs: [{ target: { provider: 'codex', threadId: 'thread', tmuxSession: 'work' },
    round: 1, status: 'running', pending: { text: 'must not send' }, plan: { goal: 'old' } }] }));
  const f = fixture('codex', file);
  for (const name of ['start', 'respond', 'finish', 'poll', 'loadDefinitionSuggestions']) assert.equal(f.manager[name], undefined);
  assert.equal(f.state(), null); await f.manager.tick(); assert.equal(f.sent.length, 0);
  await f.manager.preparePlanning(f.target); assert.equal(f.state().status, 'planning'); f.manager.close();
});

function report(f, status, extra = {}) {
  const observation = f.run().observation;
  const file = status === 'started' ? observation.startFile : observation.endFile;
  const values = { summary: status, ...(status === 'started' ? { goal: '修复输入' } : { next: '交接后续事项', cleanup: '任务资源已逐项核验回收' }), ...extra };
  writeReceipt(['--receipt', file, '--status', status, ...Object.entries(values).flatMap(([k, v]) => [`--${k}`, v])]);
}

for (const provider of ['codex', 'claude', 'qodercli']) test(`${provider}: observed colors require explicit receipts, never schedule work`, async () => {
  const f = fixture(provider); const prepared = await f.manager.preparePlanning(f.target);
  assert.match(prepared.text, /^请基于最近的讨论/); assert.equal(f.state().status, 'planning');
  assert.match(prepared.text, /只在当前对话中询问/);
  assert.match(prepared.text, /等待我用普通消息回复/);
  assert.match(prepared.text, /不要调用原生提问工具/);
  await f.manager.tick(); assert.equal(autonomyPresentation(f.state()).tone, 'idle');
  report(f, 'started'); await f.manager.tick(); assert.equal(autonomyPresentation(f.state()).tone, 'running');
  assert.equal(f.state().plan.goal, '修复输入');
  f.now += 1_000_000; await f.manager.tick(); assert.equal(f.state().status, 'running', 'quiet time is not completion');
  assert.throws(() => report(f, 'completed'), /验证证据/);
  report(f, 'completed', { evidence: '日志地址，回归通过', version: 'abc123', verification: '实际回归测试通过' });
  await f.manager.tick(); assert.equal(autonomyPresentation(f.state()).tone, 'idle');
  assert.equal(f.sent.length, 0); assert.equal(f.stops.length, 1);
  await f.manager.resetObserved(f.target); assert.equal(autonomyPresentation(f.state()).tone, 'idle');
  assert.equal(f.sent.length, 0); f.manager.close();
});

for (const [status, tone] of [['stopped', 'idle'], ['budget', 'idle'], ['blocked', 'idle'], ['error', 'idle']]) test(`${status} returns to default while retaining the result`, async () => {
  const f = fixture(); await f.manager.preparePlanning(f.target); report(f, 'started'); await f.manager.tick();
  report(f, status); await f.manager.tick(); assert.equal(autonomyPresentation(f.state()).tone, tone);
  await f.manager.tick(); assert.equal(autonomyPresentation(f.state()).tone, tone);
  await f.manager.resetObserved(f.target); await f.manager.tick();
  assert.equal(f.state().status, 'off'); assert.equal(f.sent.length, 0); f.manager.close();
});

test('restart preserves observed state without resending; reset retires old receipts', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeck-observed-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = fixture('qodercli', path.join(dir, 'autonomy.json')); await f.manager.preparePlanning(f.target);
  report(f, 'started'); await f.manager.tick(); const old = f.run().observation; f.restart();
  assert.equal(f.state().status, 'running'); await f.manager.tick(); assert.equal(f.sent.length, 0);
  await f.manager.resetObserved(f.target); assert.equal(f.state().status, 'off'); assert.equal(f.sent.length, 1, 'only the explicit reset asks for a summary');
  await f.manager.preparePlanning(f.target);
  assert.equal(fs.existsSync(old.startFile), false);
  assert.throws(() => writeReceipt(['--receipt', old.endFile, '--status', 'completed', '--summary', '旧结果', '--next', '无', '--evidence', '旧日志', '--version', 'old', '--verification', 'old']), { code: 'ENOENT' });
  await f.manager.tick(); assert.equal(f.state().status, 'planning'); assert.equal(f.sent.length, 1); f.manager.close();
});

test('a new task reclaims prior receipts and result fields without touching another task', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeck-reclaim-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = fixture('codex', path.join(dir, 'autonomy.json')); t.after(() => f.manager.close());
  await f.manager.preparePlanning(f.target);
  report(f, 'started'); await f.manager.tick();
  report(f, 'completed', { evidence: '日志', version: 'abc', verification: '测试' }); await f.manager.tick();
  const old = f.run();
  const unrelated = path.join(f.manager.receiptDirectory, 'keep.json'); fs.writeFileSync(unrelated, 'keep');
  await f.manager.resetObserved(f.target);
  await f.manager.preparePlanning(f.target);
  assert.equal(fs.existsSync(old.observation.startFile), false);
  assert.equal(fs.existsSync(old.observation.endFile), false);
  assert.equal(fs.existsSync(path.dirname(old.observation.endFile)), false);
  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'keep');
  const current = f.state();
  assert.notEqual(current.id, old.id); assert.equal(current.plan, null); assert.equal(current.summary, '');
  for (const key of ['next', 'checkpoint', 'evidence', 'startedAt', 'stoppedAt']) assert.equal(current[key], undefined);
  f.restart();
  assert.equal(f.state().id, current.id); assert.equal(f.state().status, 'planning');
  report(f, 'started'); await f.manager.tick(); assert.equal(f.state().status, 'running');
});

test('a final receipt without a confirmed start cannot turn A green', async () => {
  const f = fixture(); await f.manager.preparePlanning(f.target);
  report(f, 'completed', { evidence: '日志', version: 'abc', verification: '测试' });
  await f.manager.tick(); assert.equal(f.state().status, 'planning');
  assert.equal(f.sent.length, 0); f.manager.close();
});

test('a slow planning poll cannot be bypassed by starting another task', async t => {
  const f = fixture(); t.after(() => f.manager.close());
  await f.manager.preparePlanning(f.target); report(f, 'started');
  const read = f.manager.readSession; let resolve;
  f.manager.readSession = () => new Promise(done => { resolve = done; });
  const oldPoll = f.manager.tick();
  f.manager.readSession = read;
  await assert.rejects(f.manager.preparePlanning(f.target), /退出/);
  resolve(f.session); await oldPoll;
  assert.equal(f.state().status, 'running');
});

test('new tasks reclaim flat stored receipts without following arbitrary saved paths', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeck-flat-receipts-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = fixture('qodercli', path.join(dir, 'autonomy.json')); t.after(() => f.manager.close());
  await f.manager.preparePlanning(f.target);
  const old = f.run().observation;
  fs.rmdirSync(path.dirname(old.startFile));
  old.startFile = path.join(f.manager.receiptDirectory, `${old.startNonce}.json`);
  const unrelated = path.join(dir, `${old.endNonce}.json`);
  old.endFile = unrelated; fs.writeFileSync(unrelated, 'keep');
  report(f, 'started');
  await f.manager.resetObserved(f.target); f.restart();
  await f.manager.preparePlanning(f.target);
  assert.equal(fs.existsSync(old.startFile), false);
  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'keep');
  // A late flat-layout receipt is no longer observed by the new task.
  writeReceipt(['--receipt', old.startFile, '--status', 'started', '--goal', '旧目标', '--summary', '旧任务']);
  await f.manager.tick(); assert.equal(f.state().status, 'planning');
});

for (const provider of ['codex', 'claude', 'qodercli']) test(`${provider}: concurrent A resets request one cleanup and verify its result`, async () => {
  const f = fixture(provider); await f.manager.preparePlanning(f.target); report(f, 'started'); await f.manager.tick();
  f.session.hasRunningProcess = true; f.session.agent.hasBackgroundProcess = true;
  await Promise.all([f.manager.resetObserved(f.target), f.manager.resetObserved(f.target)]);
  assert.equal(f.stops.length, 2); assert.equal(f.stops.every(scope => scope.stopBackground === false), true);
  assert.equal(f.session.agent.hasBackgroundProcess, false); assert.equal(f.sent.length, 1);
  assert.match(f.sent[0], /只总结.*进展.*结果.*下一步/); assert.match(f.sent[0], /不要续跑/);
  assert.equal(f.state().status, 'off'); await f.manager.resetObserved(f.target);
  assert.equal(f.sent.length, 1); f.manager.close();
});

for (const failure of ['identity', 'stop', 'delivery']) test(`${failure} cannot falsely report a successful reset`, async () => {
  const f = fixture(); await f.manager.preparePlanning(f.target); report(f, 'started'); await f.manager.tick();
  if (failure === 'identity') f.session.agent.paneId = '%2';
  if (failure === 'stop') f.manager.stop = async () => { throw Error('停止失败'); };
  if (failure === 'delivery') f.manager.send = async () => ({ submissionStatus: 'unconfirmed' });
  await assert.rejects(f.manager.resetObserved(f.target)); assert.equal(f.state().status, 'error');
  await f.manager.tick(); assert.equal(f.sent.length, 0);
  await assert.rejects(f.manager.resetObserved(f.target));
  assert.equal(f.state().exitFailed, true, 'failed exit cannot be dismissed as success'); f.manager.close();
});

test('a pending planning preparation cannot be replaced before cleanup', async () => {
  const f = fixture(); const read = f.manager.readSession; let reject;
  f.manager.readSession = () => new Promise((_resolve, fail) => { reject = fail; });
  const first = f.manager.preparePlanning(f.target); f.manager.readSession = read;
  await assert.rejects(f.manager.preparePlanning(f.target), /退出/);
  reject(Error('旧请求失败')); await assert.rejects(first);
  await f.manager.resetObserved(f.target);
  const second = await f.manager.preparePlanning(f.target);
  assert.equal(f.state().id, second.planningId); assert.equal(f.state().status, 'planning');
  assert.equal(f.sent.length, 0); f.manager.close();
});

test('a failed planning preparation is red until explicitly reset', async () => {
  const f = fixture(); f.manager.readSession = async () => { throw new Error('连接失败'); };
  await assert.rejects(f.manager.preparePlanning(f.target), /连接失败/);
  assert.equal(f.state().status, 'error');
  await f.manager.resetObserved(f.target); assert.equal(f.state().status, 'off');
  assert.equal(f.sent.length, 0); f.manager.close();
});

for (const [status, tone] of [['budget', 'idle'], ['error', 'idle'], ['completed', 'idle']]) test(`${status} result survives restart with an idle button`, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeck-observed-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = fixture('qodercli', path.join(dir, 'autonomy.json')); await f.manager.preparePlanning(f.target);
  report(f, 'started'); await f.manager.tick();
  report(f, status, { evidence: '日志', version: 'abc', verification: '测试' }); await f.manager.tick();
  f.restart(); await f.manager.tick(); assert.equal(autonomyPresentation(f.state()).tone, tone);
  assert.equal(f.sent.length, 0); await f.manager.resetObserved(f.target);
  assert.equal(f.state().status, 'off'); assert.equal(f.sent.length, 0); f.manager.close();
});
