import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { AutonomyController } from '../src/autonomy.js';
import { readReceipt, writeReceipt } from '../src/autonomy-receipt.js';

for (const provider of ['codex', 'claude', 'qodercli']) test(`${provider}: silent start receipts persist without sending any work on restart`, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codeck-receipts-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const target = { provider, threadId: 'thread', tmuxSession: 'work' };
  const sent = [], turns = [];
  const options = { file: path.join(directory, 'autonomy.json'), schedule: () => 1, cancel() {},
    readSession: async () => ({ name: 'work', agent: { kind: provider, id: 'thread', paneId: '%1' } }),
    readThread: async () => ({ thread: { turns } }), stop: async () => {},
    send: async (_, text) => { sent.push(text); turns.push({ status: 'inProgress', items: [{ type: 'userMessage', content: text }] }); },
  };
  const controller = new AutonomyController(options);
  await controller.preparePlanning(target);
  const run = [...controller.runs.values()][0];
  const args = ['src/autonomy-receipt.js', '--receipt', run.observation.startFile, '--status', 'started', '--goal', '修复输入', '--summary', '用户已确认'];
  assert.equal(execFileSync(process.execPath, args, { encoding: 'utf8' }), '');
  assert.equal(execFileSync(process.execPath, args, { encoding: 'utf8' }), '', 'same receipt is idempotent');
  assert.equal(readReceipt(run.observation.startFile, run.observation.startNonce).summary, '用户已确认');
  await controller.tick(); assert.equal(controller.snapshot(target).status, 'running');
  assert.equal(sent.length, 0); controller.close();
  const restored = new AutonomyController(options); await restored.tick();
  assert.equal(restored.snapshot(target).status, 'running'); assert.equal(sent.length, 0); restored.close();
});

test('invalid receipt parameters can be corrected, but an accepted receipt cannot be changed', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codeck-receipt-validation-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, '00000000-0000-0000-0000-000000000001.json');
  const incomplete = ['--receipt', file, '--status', 'completed', '--summary', '验证通过', '--next', '无需后续'];
  assert.throws(() => writeReceipt(incomplete), /验证证据/); assert.equal(fs.existsSync(file), false);
  const complete = [...incomplete, '--evidence', '测试日志', '--version', 'abc', '--verification', '测试通过'];
  writeReceipt(complete); writeReceipt(complete);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const changed = complete.map(value => value === '验证通过' ? '不同总结' : value);
  assert.throws(() => writeReceipt(changed), /不允许覆盖/);
  assert.throws(() => readReceipt(file, 'wrong'), /身份不匹配/);
});
