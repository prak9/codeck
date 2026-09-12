// Synthetic, content-free workload. Run baseline and candidate in separate
// processes for comparable RSS: node --expose-gc scripts/qoder-history-benchmark.mjs [baseline|candidate]
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { setImmediate as yieldToIO } from 'node:timers/promises';
import { getSessionInfo, getSessionMessages } from '@qoder-ai/qoder-agent-sdk';
import { QoderAgentBackend } from '../src/qoder-agent-backend.js';

const mode = process.argv[2] || 'candidate';
const shape = process.argv[3] || 'text';
assert.ok(['baseline', 'candidate'].includes(mode));
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codeck-qoder-bench-'));
const threadId = '11111111-1111-4111-8111-111111111111';
const folder = path.join(root, 'projects', '-fixture');
const file = path.join(folder, `${threadId}.jsonl`);
const total = 920;
const payload = 'x'.repeat(128 * 1024);
const entries = index => shape === 'tools' ? [
  { type: 'user', uuid: `u${index}`, parentUuid: index ? `a${index - 1}` : null,
    sessionId: threadId, cwd: '/fixture', message: { role: 'user', content: `question ${index}` } },
  { type: 'assistant', uuid: `t${index}`, parentUuid: `u${index}`, sessionId: threadId,
    message: { id: `mt${index}`, role: 'assistant', content: [{ type: 'tool_use', id: `tool${index}`, name: 'Bash', input: { command: 'pwd' } }] } },
  { type: 'user', uuid: `r${index}`, parentUuid: `t${index}`, sessionId: threadId,
    toolUseResult: { stdout: payload.slice(0, 64 * 1024) },
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tool${index}`, content: payload.slice(0, 64 * 1024) }] } },
  { type: 'assistant', uuid: `a${index}`, parentUuid: `r${index}`, sessionId: threadId,
    message: { id: `m${index}`, role: 'assistant', content: [{ type: 'text', text: `done ${index}` }] } },
] : [
  { type: 'user', uuid: `u${index}`, parentUuid: index ? `a${index - 1}` : null,
    sessionId: threadId, cwd: '/fixture', message: { role: 'user', content: `question ${index}` } },
  { type: 'assistant', uuid: `a${index}`, parentUuid: `u${index}`, sessionId: threadId,
    message: { id: `m${index}`, role: 'assistant', content: [{ type: 'text', text: `${index}:${payload}` }] } },
];
const append = index => fs.appendFile(file, entries(index).map(JSON.stringify).join('\n') + '\n');
let backend;
let timer;
try {
  await fs.mkdir(folder, { recursive: true });
  for (let index = 0; index < total; index += 1) await append(index);
  // A large catalog must not cause unrelated transcript payloads to be parsed.
  for (let index = 1; index <= 704; index += 1) {
    const id = `22222222-2222-4222-8222-${String(index).padStart(12, '0')}`;
    await fs.writeFile(path.join(folder, `${id}.jsonl`), 'unrelated malformed history\n');
  }
  global.gc?.();
  const size = (await fs.stat(file)).size;
  assert.ok(size >= 115 * 1024 * 1024);
  let maxGapMs = 0;
  let ticks = 0;
  let lastTick = performance.now();
  timer = setInterval(() => {
    const now = performance.now();
    maxGapMs = Math.max(maxGapMs, now - lastTick);
    lastTick = now;
    ticks += 1;
  }, 10);
  const store = { load: async () => (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean).map(JSON.parse) };
  backend = mode === 'candidate' ? new QoderAgentBackend({ configDir: root }) : null;
  async function read() {
    if (backend) return backend.read('open', { threadId, limit: 20 });
    await getSessionInfo(threadId, { dir: '/fixture', sessionStore: store });
    const messages = await getSessionMessages(threadId, { dir: '/fixture', sessionStore: store });
    return { ids: messages.map(message => message.uuid) };
  }
  const start = performance.now();
  const firstResponse = backend ? await backend.openThread(threadId) : await read();
  const initialResponseMs = performance.now() - start;
  const first = backend ? await backend.openReads.values().next().value || firstResponse : firstResponse;
  const firstReadyMs = performance.now() - start;
  if (backend) {
    assert.equal(first.thread.turns.length, 20);
    assert.equal(first.thread.truncated, true);
    assert.match(JSON.stringify(first.thread.turns.at(-1)), /question 919/);
  } else assert.equal(first.ids.length, total * (shape === 'tools' ? 4 : 2));
  const before = backend ? await backend.read('stats') : null;
  const appendMs = [];
  for (let index = total; index < total + 3; index += 1) {
    await append(index);
    const started = performance.now();
    const result = await read();
    appendMs.push(performance.now() - started);
    if (backend) assert.match(JSON.stringify(result.thread.turns.at(-1)), new RegExp(`question ${index}`));
    else assert.equal(result.ids.at(-1), `a${index}`);
    await yieldToIO();
  }
  const after = backend ? await backend.read('stats') : null;
  let sendPreparationMs = null;
  if (backend) {
    assert.equal(after.parsedRecords - before.parsedRecords, shape === 'tools' ? 12 : 6);
    assert.ok(after.readBytes - before.readBytes < 1024 * 1024);
    const page = await backend.loadThreadHistory(threadId, { beforeTurnId: first.thread.oldestTurnId, limit: 20 });
    assert.equal(page.turns.length, 20);
    assert.ok(!page.turns.some(turn => first.thread.turns.some(later => later.id === turn.id)));
    const preparing = performance.now();
    const baseline = await backend.prepareSessionMessage({ threadId, commandId: 'benchmark-only', text: 'not sent' });
    sendPreparationMs = performance.now() - preparing;
    assert.equal(baseline.offset, (await fs.stat(file)).size);
    assert.equal((await backend.read('stats')).parsedRecords, after.parsedRecords,
      'fresh delivery evidence validates bytes without reparsing unchanged JSON records');
  }
  await yieldToIO();
  console.log(JSON.stringify({ mode, shape, bytes: size, libraryFiles: 705, initialResponseMs, firstReadyMs,
    appendMs, sendPreparationMs, maxTimerGapMs: maxGapMs, timerTicks: ticks, rssMB: process.memoryUsage().rss / 1024 / 1024,
    incrementalReadBytes: before ? after.readBytes - before.readBytes : null,
    incrementalParsedRecords: before ? after.parsedRecords - before.parsedRecords : null }, null, 2));
} finally {
  clearInterval(timer);
  backend?.close();
  await fs.rm(root, { recursive: true, force: true });
}
