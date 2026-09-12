import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { QoderSessionSource } from '../src/qoder-session-source.js';
import { QoderAgentBackend } from '../src/qoder-agent-backend.js';
import { QoderTranscriptCache } from '../src/qoder-transcript.js';
import { getSessionMessages } from '@qoder-ai/qoder-agent-sdk';
import { threadSnapshotRefreshInterval } from '../src/session-status.js';

const threadId = '11111111-1111-4111-8111-111111111111';
const user = (uuid, parentUuid = null) => ({ type: 'user', uuid, parentUuid, sessionId: threadId,
  cwd: '/fixture', message: { role: 'user', content: uuid } });

async function fixture(t, entries) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codeck-qoder-worker-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'projects', '-fixture', `${threadId}.jsonl`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
  const backend = new QoderAgentBackend({ configDir: root });
  t.after(() => backend.close());
  return { root, file, backend };
}

test('Qoder retains a valid final line without newline across later appends', async t => {
  const { file } = await fixture(t, []);
  const cache = new QoderTranscriptCache();
  await fs.writeFile(file, JSON.stringify(user('one')));
  assert.deepEqual((await cache.load(file)).records.map(r => r.entry.uuid), ['one']);
  await fs.appendFile(file, '\n' + JSON.stringify(user('two', 'one')) + '\n');
  assert.deepEqual((await cache.load(file)).records.map(r => r.entry.uuid), ['one', 'two']);
});

test('Qoder worker reads the exact discovered file when bounded metadata has no cwd', async t => {
  const entry = user('one');
  delete entry.cwd;
  const { backend } = await fixture(t, [entry]);
  const result = await backend.read('open', { threadId });
  assert.equal(result.thread.turns.length, 1);
  assert.match(JSON.stringify(result.thread.turns), /one/);
});

test('Qoder worker settles timeout, restarts cleanly, and preserves runtime list entries', async t => {
  const { backend } = await fixture(t, [user('one')]);
  backend.readTimeoutMs = 1;
  await assert.rejects(backend.read('open', { threadId }), /超时/);
  backend.readTimeoutMs = 30_000;
  assert.equal((await backend.read('open', { threadId })).thread.turns.length, 1);
  backend.runtimes.set('runtime-only', { threadId: 'runtime-only', preview: 'live', cwd: '/fixture',
    createdAt: Date.now(), activeTurn: { id: 'active' }, pendingTurns: [] });
  const result = await backend.listThreads();
  assert.equal(result.data.find(thread => thread.id === 'runtime-only')?.status.type, 'active');
  backend.runtimes.clear();
});

test('Qoder SDK payload projection preserves tool and branch semantics and original payload', async t => {
  const entries = [user('u'), { type: 'assistant', uuid: 'a', parentUuid: 'u', sessionId: threadId,
    message: { id: 'msg-a', role: 'assistant', content: [
      { type: 'thinking', thinking: 'reason' }, { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
    ] } }, { ...user('r', 'a'), toolUseResult: { stdout: 'full original output', stderr: '', interrupted: false },
    toolDenialKind: 'user_rejected', userFeedback: 'retain metadata', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'tool-1', content: [{ type: 'text', text: '/fixture' }] },
    ] } }, { type: 'assistant', uuid: 'b', parentUuid: 'r', sessionId: threadId,
    message: { id: 'msg-b', role: 'assistant', content: [{ type: 'text', text: 'done' },
      { type: 'image', source: { type: 'base64', data: 'preserve-image' } }] } }];
  const { root } = await fixture(t, entries);
  const source = new QoderSessionSource({ configDir: root });
  t.after(() => source.close());
  const expected = await getSessionMessages(threadId, { dir: '/fixture', sessionStore: { load: async () => entries } });
  assert.deepEqual(await source.getSessionMessages(threadId, { dir: '/fixture' }), expected);
});

test('Qoder cold opens share one read and surface delayed errors instead of loading forever', async t => {
  const backend = new QoderAgentBackend();
  t.after(() => backend.close());
  let rejectRead;
  let calls = 0;
  backend.read = () => { calls += 1; return new Promise((resolve, reject) => { rejectRead = reject; }); };
  const results = await Promise.all([backend.openThread(threadId), backend.openThread(threadId)]);
  assert.equal(calls, 1);
  assert.equal(results[0].thread.historyLoading, true);
  assert.equal(results[0].thread.truncated, true);
  assert.equal(threadSnapshotRefreshInterval(results[0], 'done'), 350);
  rejectRead(new Error('reader failed'));
  await assert.rejects([...backend.openReads.values()][0], /reader failed/);
  assert.match((await backend.openThread(threadId)).thread.historyError, /reader failed/);
  backend.read = async () => ({ thread: { id: threadId, turns: [] } });
  assert.equal((await backend.openThread(threadId)).thread.historyLoading, undefined);
});

test('Qoder worker receipt survives reader restart without resending user input', async t => {
  const { backend, file } = await fixture(t, [user('one')]);
  const deliveryBaseline = await backend.prepareSessionMessage({ threadId, text: 'two', commandId: 'command' });
  backend.recordSessionMessage({ threadId, text: 'two', commandId: 'command', deliveryBaseline });
  await fs.appendFile(file, JSON.stringify(user('two', 'one')) + '\n');
  const before = (await backend.openThread(threadId)).thread;
  // A cold worker can return the loading shell; await its actual read if needed.
  const observed = before.historyLoading ? (await [...backend.openReads.values()][0]).thread : before;
  assert.deepEqual(observed.deliveryConfirmations, [{ commandId: 'command', itemId: 'two' }]);
  const reader = backend.reader;
  await reader.terminate();
  const result = await backend.read('open', { threadId, receipts: [...backend.readReceipts.values()] });
  assert.deepEqual(result.thread.deliveryConfirmations, observed.deliveryConfirmations);
});

test('Qoder worker pagination reaches pre-compaction history without moving the live anchor', async t => {
  const assistant = (uuid, parentUuid) => ({ type: 'assistant', uuid, parentUuid, sessionId: threadId,
    message: { role: 'assistant', content: [{ type: 'text', text: uuid }] } });
  const { backend, file } = await fixture(t, [user('old'), assistant('old-answer', 'old'),
    { type: 'system', subtype: 'compact_boundary', uuid: 'boundary', sessionId: threadId,
      parentUuid: null, logicalParentUuid: 'old-answer', message: { role: 'system', content: '' } },
    { ...user('summary', 'boundary'), isCompactSummary: true },
    user('latest', 'summary'), assistant('latest-answer', 'latest')]);
  const first = await backend.read('open', { threadId, limit: 1 });
  const anchor = first.thread.oldestTurnId;
  assert.equal(first.thread.truncated, true);
  await fs.appendFile(file, JSON.stringify(user('newest', 'latest-answer')) + '\n');
  const page = await backend.loadThreadHistory(threadId, { beforeTurnId: anchor, limit: 20 });
  const texts = page.turns.flatMap(turn => turn.items.map(item => item.type === 'userMessage' ? item.content[0].text : item.text));
  assert.deepEqual(texts, ['old', 'old-answer']);
  assert.equal(page.truncated, false);
  const refreshed = await backend.read('open', { threadId, limit: 2 });
  assert.equal(refreshed.thread.turns[0].id, anchor);
  assert.doesNotMatch(JSON.stringify([...page.turns, ...refreshed.thread.turns]), /"text":"summary"/);
});

test('Qoder growing transcripts parse only appended records and recover from partial lines and replacement', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codeck-qoder-incremental-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const id = '11111111-1111-4111-8111-111111111111';
  const file = path.join(root, 'projects', '-fixture', `${id}.jsonl`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const entry = (uuid, parentUuid = null) => ({ type: 'user', uuid, parentUuid, sessionId: id,
    cwd: '/fixture', message: { role: 'user', content: uuid } });
  await fs.writeFile(file, JSON.stringify(entry('old')) + '\n');
  const source = new QoderSessionSource({ configDir: root });
  t.after(() => source.close());
  await source.getSessionMessages(id, { dir: '/fixture' });
  const first = source.readStats?.parsedRecords;
  assert.equal(first, 1);
  const next = JSON.stringify(entry('new', 'old'));
  await fs.appendFile(file, next.slice(0, 25));
  assert.deepEqual((await source.getSessionMessages(id, { dir: '/fixture' })).map(m => m.uuid), ['old']);
  await fs.appendFile(file, next.slice(25) + '\n');
  assert.deepEqual((await source.getSessionMessages(id, { dir: '/fixture' })).map(m => m.uuid), ['old', 'new']);
  assert.equal(source.readStats.parsedRecords, 2);
  await fs.writeFile(file, JSON.stringify(entry('replacement')) + '\n');
  assert.deepEqual((await source.getSessionMessages(id, { dir: '/fixture' })).map(m => m.uuid), ['replacement']);
});
