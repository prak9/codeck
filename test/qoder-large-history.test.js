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
import { AgentHub, AgentRegistry } from '../src/agent-connection.js';
import { EventEmitter } from 'node:events';

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

test('Qoder send preparation is independent of a busy history worker', async t => {
  const { backend, file } = await fixture(t, [user('one')]);
  await backend.read('open', { threadId });
  backend.reader.postMessage = () => {}; // Deterministically hold the history lane.
  const blocked = backend.read('open', { threadId }).catch(() => {});
  t.after(() => { backend.close(); return blocked; });
  const baseline = await backend.prepareSessionMessage({ threadId, text: 'two', commandId: 'command' });
  assert.equal(baseline.offset, (await fs.stat(file)).size);
  assert.notEqual(backend.preparer, backend.reader);
  assert.equal(backend.pendingReads.size, 1);
});

test('Qoder input-log parsing stays off the service event loop', async t => {
  const { backend, root } = await fixture(t, [user('one')]);
  const logFile = path.join(root, 'tmp', '-fixture', 'logs.json');
  await fs.mkdir(path.dirname(logFile), { recursive: true });
  await fs.writeFile(logFile, JSON.stringify([{ sessionId: threadId, messageId: 7,
    message: 'input-log-thread-isolation-' + 'x'.repeat(65536), type: 'user' }]));
  const parse = JSON.parse;
  let mainThreadParses = 0;
  JSON.parse = (...args) => {
    if (String(args[0]).includes('input-log-thread-isolation-')) mainThreadParses += 1;
    return parse(...args);
  };
  try {
    const baseline = await backend.prepareSessionMessage({ threadId, text: 'two', commandId: 'command' });
    assert.equal(baseline.inputLog.lastId, 7);
    assert.equal(mainThreadParses, 0, 'input logs must not be parsed on the main thread');
  } finally { JSON.parse = parse; }
});

test('Qoder preparation timeout/close cancel only preparation, not the history reader', async t => {
  const { backend } = await fixture(t, [user('one')]);
  await backend.read('open', { threadId });
  const reader = backend.reader;
  backend.readTimeoutMs = 1; // Cold preparation worker cannot finish startup in 1ms.
  await assert.rejects(backend.prepareSessionMessage({ threadId, text: 'two', commandId: 'one' }), /发送准备超时/);
  assert.equal(backend.preparer, null);
  assert.equal(backend.reader, reader);
  backend.readTimeoutMs = 30_000;
  assert.equal((await backend.read('open', { threadId })).thread.turns.length, 1);
  assert.ok(await backend.prepareSessionMessage({ threadId, text: 'two', commandId: 'retry' }));
  const preparing = backend.prepareSessionMessage({ threadId, text: 'two', commandId: 'two' });
  backend.close();
  await assert.rejects(preparing, /closed/);
  assert.equal(backend.pendingReads.size, 0);
  assert.equal(backend.preparer, null);
  await assert.rejects(backend.prepareSessionMessage({ threadId, text: 'two', commandId: 'three' }), /closed/);
});

test('Qoder history worker exit does not reject pending preparation or its replacement worker', async t => {
  const { backend } = await fixture(t, [user('one')]);
  await backend.read('open', { threadId });
  const params = { threadId, text: 'two', commandId: 'command' };
  await backend.prepareSessionMessage(params);
  const reader = backend.reader;
  const preparer = backend.preparer;
  const postPrepare = preparer.postMessage.bind(preparer);
  let held;
  preparer.postMessage = message => { held = message; };
  const preparing = backend.prepareSessionMessage(params);
  reader.postMessage = () => {};
  const reading = backend.read('open', { threadId });
  const failed = assert.rejects(reading, /reader exited/);
  await reader.terminate();
  await failed;
  assert.equal(backend.preparer, preparer);
  assert.equal(backend.pendingReads.size, 1);
  postPrepare(held);
  assert.ok((await preparing).hash);
  assert.equal((await backend.read('open', { threadId })).thread.turns.length, 1);
  assert.notEqual(backend.reader, reader);
  assert.equal(backend.pendingReads.size, 0);
});

test('Qoder Remote send RPC finishes once while display reads remain blocked', async t => {
  const { backend } = await fixture(t, [user('one')]);
  let unblock;
  const read = backend.read.bind(backend);
  backend.read = (method, params) => method === 'prepare' ? read(method, params)
    : new Promise(resolve => { unblock = resolve; });
  t.after(() => unblock?.({ thread: { id: threadId, turns: [] } }));
  assert.equal((await backend.openThread(threadId)).thread.historyLoading, true);
  let writes = 0;
  const registry = new AgentRegistry({ qodercli: backend }, {
    sendTmuxMessage: async () => { writes += 1; return { submissionStatus: 'submitted' }; },
  });
  t.after(() => registry.close());
  const socket = new EventEmitter();
  socket.readyState = 1;
  const replies = [];
  socket.send = raw => replies.push(JSON.parse(raw));
  const hub = new AgentHub(registry, { threadFeed: {
    subscribeFrom: () => () => {}, invalidate: async () => {}, refreshSubscribed: async () => {},
  } });
  hub.handleConnection(socket, { streamVersion: 2 });
  const message = { type: 'sendSessionMessage', provider: 'qodercli', threadId,
    tmuxSession: 'fixture', text: 'two', commandId: 'send-once', id: 1 };
  socket.emit('message', JSON.stringify(message));
  const deadline = Date.now() + 5000;
  while (!replies.some(reply => reply.id === 1) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(replies.find(reply => reply.id === 1)?.ok, true, JSON.stringify(replies));
  assert.equal(backend.openReads.size, 1, 'display work remains blocked throughout sending');
  socket.emit('message', JSON.stringify({ ...message, id: 2 }));
  while (!replies.some(reply => reply.id === 2) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(replies.find(reply => reply.id === 2)?.ok, true);
  assert.equal(writes, 1, 'retrying the same command must not paste twice');
  socket.emit('close');
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
