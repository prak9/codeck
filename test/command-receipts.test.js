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
