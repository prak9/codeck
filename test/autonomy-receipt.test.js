import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { AutonomyController } from '../src/autonomy.js';
import { readReceipt, writeReceipt } from '../src/autonomy-receipt.js';

for (const provider of ['codex', 'claude', 'qodercli']) test(`${provider}: silent receipts wait for prose completion and never replay on restart`, async t => {
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
  await controller.start(target, { simple: true });
  await controller.respond(target, { requestId: controller.snapshot(target).requestId, answers: {
    goal: ['修复输入'], strategy: ['先复现后修复'], acceptance: ['回归通过'], budget: ['不限'], constraints: [''], continuation: ['false'],
  } });
  await controller.tick();
  const exchange = [...controller.runs.values()][0].exchange;
  assert.ok(exchange.receiptFile);
  assert.match(sent[0], /不要在对话中输出协议 JSON/);
  assert.doesNotMatch(sent[0], /输出.*fenced JSON|输出 \{"nonce"/);
  const args = ['src/autonomy-receipt.js', '--receipt', exchange.receiptFile, '--status', 'continue', '--summary', '8项测试通过', '--next', '扩大回归', '--progress', 'true',
    '--baseline', '输入丢失', '--version', 'abc123', '--verification', '8项测试通过', '--current', '窄屏待验证'];
  assert.equal(execFileSync(process.execPath, args, { encoding: 'utf8' }), '');
  assert.equal(execFileSync(process.execPath, args, { encoding: 'utf8' }), '', 'same receipt is idempotent');
  assert.equal(readReceipt(exchange.receiptFile, exchange.nonce).summary, '8项测试通过');
  await controller.tick(); assert.equal(controller.snapshot(target).status, 'running', 'receipt alone cannot cut off final prose');
  turns[0].status = 'completed'; turns[0].items.push({ type: 'agentMessage', text: '8项测试通过，下一步扩大回归。' });
  await controller.tick(); assert.equal(controller.snapshot(target).status, 'queued'); assert.equal(sent.length, 1);
  controller.close();
  const restored = new AutonomyController(options); await restored.tick();
  assert.equal(restored.snapshot(target).status, 'paused'); assert.equal(sent.length, 1); restored.close();
});

test('invalid receipt parameters can be corrected, but an accepted receipt cannot be changed', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codeck-receipt-validation-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, '00000000-0000-0000-0000-000000000001.json');
  const incomplete = ['--receipt', file, '--status', 'continue', '--summary', '验证通过', '--next', '继续', '--progress', 'true'];
  assert.throws(() => writeReceipt(incomplete), /baseline/); assert.equal(fs.existsSync(file), false);
  const complete = [...incomplete, '--baseline', '原有失败', '--version', 'abc', '--verification', '测试通过', '--current', '尚待覆盖'];
  writeReceipt(complete); writeReceipt(complete);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const changed = complete.map(value => value === '验证通过' ? '不同总结' : value);
  assert.throws(() => writeReceipt(changed), /不允许覆盖/);
  assert.throws(() => readReceipt(file, 'wrong'), /身份不匹配/);
});
