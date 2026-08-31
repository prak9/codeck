import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommandReceiptCache } from '../src/command-receipts.js';

test('command receipts share one in-flight side effect and replay its result', async () => {
  let executions = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const receipts = createCommandReceiptCache({ ttlMs: 60_000 });
  const execute = async () => {
    executions += 1;
    await gate;
    return { accepted: true };
  };

  const first = receipts.run('command-12345678', 'same-payload', execute);
  const duplicate = receipts.run('command-12345678', 'same-payload', execute);
  release();

  assert.deepEqual(await first, { accepted: true });
  assert.deepEqual(await duplicate, { accepted: true });
  assert.deepEqual(await receipts.run('command-12345678', 'same-payload', execute), { accepted: true });
  assert.equal(executions, 1);
});

test('a command id cannot be reused for a different side effect', async () => {
  const receipts = createCommandReceiptCache();
  await receipts.run('command-12345678', 'first-payload', async () => ({ ok: true }));

  await assert.rejects(
    receipts.run('command-12345678', 'different-payload', async () => ({ ok: false })),
    /different payload/i,
  );
});

test('the receipt cache never evicts an unexpired idempotency record', async () => {
  const receipts = createCommandReceiptCache({ maxEntries: 1, ttlMs: 60_000 });
  await receipts.run('command-12345678', 'first-payload', async () => ({ ok: true }));

  await assert.rejects(
    receipts.run('command-87654321', 'second-payload', async () => ({ ok: true })),
    /capacity/i,
  );
  assert.deepEqual(
    await receipts.run('command-12345678', 'first-payload', async () => ({ ok: false })),
    { ok: true },
  );
});

test('a failed side effect is not silently retried under the same command id', async () => {
  // 载荷可能在 tmux 写入成功之后才失败 (recordSessionMessage 等后续步骤抛错),
  // 所以失败结果必须和成功一样被记住: 同 commandId 重试只能拿回同一个失败,
  // 不能重新执行 —— 否则"同一服务进程内重试不重复写 tmux"就被打穿了。
  let executions = 0;
  const receipts = createCommandReceiptCache({ ttlMs: 60_000 });
  const execute = async () => {
    executions += 1;
    throw new Error('tmux write rejected');
  };

  await assert.rejects(receipts.run('command-12345678', 'same-payload', execute), /tmux write rejected/);
  await assert.rejects(receipts.run('command-12345678', 'same-payload', execute), /tmux write rejected/);
  assert.equal(executions, 1, 'a retry must not re-run a side effect that may already have landed');
});
