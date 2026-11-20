#!/usr/bin/env node
/**
 * Outbox signal-to-noise (SNR) offline replay evaluator.
 * Measures suppression rate, merge efficiency, and duplicate avoidance on isolated synthetic logs.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AlwaysOnStore } from '../src/always-on-store.js';
import { createMemoryStore } from '../src/always-on-memory.js';
import { createOutboxDispatcher } from '../src/always-on-outbox.js';
import { createButlerOrchestrator } from '../src/always-on-butler.js';

export async function runSnrEval() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codeck-snr-eval-'));
  const store = new AlwaysOnStore(':memory:');
  try {
    const memory = createMemoryStore({ directory: dir });
    let pushes = 0;
    const dispatcher = createOutboxDispatcher({
      store,
      memory,
      deliverTelegram: async () => { pushes++; },
      now: () => 100_000,
    });
    const butler = createButlerOrchestrator({ store, memory, outboxDispatcher: dispatcher, now: () => 100_000 });

    const sampleEvents = [
      { source: 'timer', payload: { reason: '巡检无变化', priority: 'silent' } },
      { source: 'timer', payload: { reason: '研究草稿更新', priority: 'digest' } },
      { source: 'timer', payload: { reason: '回测指标汇总', priority: 'digest' } },
      { source: 'web', payload: { reason: '任务A完成', priority: 'notify', channel: 'telegram' } },
      { source: 'web', payload: { reason: '任务B完成', priority: 'notify', channel: 'telegram' } },
      { source: 'approval_resolved', payload: { reason: '任务A完成', priority: 'notify', channel: 'telegram' } }, // duplicate after reported
    ];

    for (const [idx, item] of sampleEvents.entries()) {
      const ev = store.enqueueEvent({ scopeKey: 'butler', source: item.source, dedupeKey: `eval:${idx}`, payload: item.payload, now: 1000 + idx }).event;
      await butler.handleBatch([ev], {});
      if (idx === 4) await dispatcher.tick(); // deliver batch before duplicate arrives
    }
    const digest = await dispatcher.compileDigest({ title: 'Eval Digest' });
    const allOutbox = store.listOutbox({ limit: 100 });
    const silentCount = allOutbox.filter(i => i.status === 'suppressed').length;
    const digestedCount = allOutbox.filter(i => i.status === 'digested').length;
    const sentCount = allOutbox.filter(i => i.status === 'sent').length;

    return {
      totalEvents: sampleEvents.length,
      outboundPushCalls: pushes,
      silentCount,
      digestedCount,
      sentCount,
      digestItemsCompiled: digest.count,
      noiseReductionRatio: Number(((sampleEvents.length - pushes) / sampleEvents.length).toFixed(3)),
    };
  } finally {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runSnrEval();
  console.log(JSON.stringify(result, null, 2));
}
