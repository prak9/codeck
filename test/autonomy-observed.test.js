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
  const values = { summary: status, ...(status === 'started' ? { goal: '修复输入' } : { next: '交接后续事项' }), ...extra };
  writeReceipt(['--receipt', file, '--status', status, ...Object.entries(values).flatMap(([k, v]) => [`--${k}`, v])]);
}

for (const provider of ['codex', 'claude', 'qodercli']) test(`${provider}: observed colors require explicit receipts, never schedule work`, async () => {
  const f = fixture(provider); const prepared = await f.manager.preparePlanning(f.target);
  assert.match(prepared.text, /^请基于最近的讨论/); assert.equal(f.state().status, 'planning');
  await f.manager.tick(); assert.equal(autonomyPresentation(f.state()).tone, 'idle');
  report(f, 'started'); await f.manager.tick(); assert.equal(autonomyPresentation(f.state()).tone, 'running');
  assert.equal(f.state().plan.goal, '修复输入');
  f.now += 1_000_000; await f.manager.tick(); assert.equal(f.state().status, 'running', 'quiet time is not completion');
  assert.throws(() => report(f, 'completed'), /验证证据/);
  report(f, 'completed', { evidence: '日志地址，回归通过', version: 'abc123', verification: '实际回归测试通过' });
  await f.manager.tick(); assert.equal(autonomyPresentation(f.state()).tone, 'completed');
  assert.equal(f.sent.length, 0); assert.equal(f.stops.length, 0);
  await f.manager.resetObserved(f.target); assert.equal(autonomyPresentation(f.state()).tone, 'idle');
  assert.equal(f.sent.length, 0); f.manager.close();
});

for (const [status, tone] of [['stopped', 'running'], ['budget', 'running'], ['blocked', 'running'], ['error', 'error']]) test(`${status} stays colored until a user reset`, async () => {
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
  writeReceipt(['--receipt', old.endFile, '--status', 'completed', '--summary', '旧结果', '--next', '无', '--evidence', '旧日志', '--version', 'old', '--verification', 'old']);
  await f.manager.tick(); assert.equal(f.state().status, 'planning'); assert.equal(f.sent.length, 1); f.manager.close();
});

test('a final receipt without a confirmed start cannot turn A green', async () => {
  const f = fixture(); await f.manager.preparePlanning(f.target);
  report(f, 'completed', { evidence: '日志', version: 'abc', verification: '测试' });
  await f.manager.tick(); assert.equal(f.state().status, 'planning');
  assert.equal(f.sent.length, 0); f.manager.close();
});

for (const provider of ['codex', 'claude', 'qodercli']) test(`${provider}: concurrent A resets stop once, preserve background work and request one summary`, async () => {
  const f = fixture(provider); await f.manager.preparePlanning(f.target); report(f, 'started'); await f.manager.tick();
  f.session.hasRunningProcess = true; f.session.agent.hasBackgroundProcess = true;
  await Promise.all([f.manager.resetObserved(f.target), f.manager.resetObserved(f.target)]);
  assert.equal(f.stops.length, 1); assert.equal(f.stops[0].stopBackground, false);
  assert.equal(f.session.agent.hasBackgroundProcess, true); assert.equal(f.sent.length, 1);
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
  await f.manager.resetObserved(f.target); assert.equal(f.state().status, 'off'); f.manager.close();
});

test('a superseded planning read cannot overwrite the newer plan on late failure', async () => {
  const f = fixture(); const read = f.manager.readSession; let reject;
  f.manager.readSession = () => new Promise((_resolve, fail) => { reject = fail; });
  const first = f.manager.preparePlanning(f.target); f.manager.readSession = read;
  const second = await f.manager.preparePlanning(f.target);
  reject(Error('旧请求失败')); await assert.rejects(first);
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

for (const [status, tone] of [['budget', 'running'], ['error', 'error'], ['completed', 'completed']]) test(`${status} survives restart until reset`, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeck-observed-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = fixture('qodercli', path.join(dir, 'autonomy.json')); await f.manager.preparePlanning(f.target);
  report(f, 'started'); await f.manager.tick();
  report(f, status, { evidence: '日志', version: 'abc', verification: '测试' }); await f.manager.tick();
  f.restart(); await f.manager.tick(); assert.equal(autonomyPresentation(f.state()).tone, tone);
  assert.equal(f.sent.length, 0); await f.manager.resetObserved(f.target);
  assert.equal(f.state().status, 'off'); assert.equal(f.sent.length, 0); f.manager.close();
});
