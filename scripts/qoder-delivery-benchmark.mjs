// Synthetic data only; no tmux writes or real sessions. Run unchanged before/after.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { QoderSessionSource } from '../src/qoder-session-source.js';
import { QoderAgentBackend } from '../src/qoder-agent-backend.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codeck-qoder-delivery-bench-'));
const threadId = '11111111-1111-4111-8111-111111111111';
const file = path.join(root, 'projects', '-fixture', `${threadId}.jsonl`);
const logFile = path.join(root, 'tmp', '-fixture', 'logs.json');
const source = new QoderSessionSource({ configDir: root, sessionFile: () => file });
const backend = new QoderAgentBackend({ configDir: root });
const measure = async fn => { const start = performance.now(); await fn(); return performance.now() - start; };
try {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.mkdir(path.dirname(logFile), { recursive: true });
  await fs.writeFile(logFile, '[]');
  await fs.writeFile(file, JSON.stringify({ type: 'user', uuid: 'u', sessionId: threadId,
    cwd: '/fixture', message: { role: 'user', content: 'start' } }) + '\n');
  const payload = 'x'.repeat(1024 * 1024);
  for (let i = 0; i < 182; i += 1) await fs.appendFile(file, JSON.stringify({
    type: 'assistant', uuid: `a${i}`, parentUuid: i ? `a${i - 1}` : 'u', sessionId: threadId,
    message: { id: `m${i}`, role: 'assistant', content: [{ type: 'text', text: payload }] },
  }) + '\n');
  let gap = 0, last = performance.now();
  const timer = setInterval(() => { const now = performance.now(); gap = Math.max(gap, now - last); last = now; }, 10);
  let duringOpenMs;
  try {
    const opening = backend.read('open', { threadId, limit: 1 });
    duringOpenMs = await measure(async () => {
      const baseline = await backend.prepareSessionMessage({ threadId, text: 'Continue', commandId: 'bench' });
      assert.equal(baseline.offset, (await fs.stat(file)).size);
    });
    await opening;
  } finally { clearInterval(timer); backend.close(); }
  const baseline = await source.prepare({ threadId, cwd: '/fixture', text: 'Continue' });
  source.record({ threadId, commandId: 'bench', text: 'Continue', deliveryBaseline: baseline });
  await fs.writeFile(logFile, JSON.stringify([{ sessionId: threadId, messageId: 1,
    type: 'user', message: 'Continue', timestamp: new Date().toISOString() }]));
  assert.deepEqual(await source.received(threadId), ['bench']);
  await source.getSessionMessages(threadId, { dir: '/fixture' });
  const bytesBefore = source.readStats.readBytes;
  const pollsMs = [];
  for (let i = 0; i < 3; i += 1) pollsMs.push(await measure(() => source.getSessionMessages(threadId, { dir: '/fixture' })));
  console.log(JSON.stringify({ bytes: (await fs.stat(file)).size, duringOpenMs, maxParentTimerGapMs: gap,
    unchangedPollReadBytes: source.readStats.readBytes - bytesBefore, pollsMs }, null, 2));
} finally {
  source.close(); backend.close();
  await fs.rm(root, { recursive: true, force: true });
}
