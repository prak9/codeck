import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { QoderSessionSource } from '../src/qoder-session-source.js';
import { SdkAgentBackend } from '../src/sdk-agent-backend.js';
import { AgentHub, AgentRegistry } from '../src/agent-connection.js';
import { EventEmitter } from 'node:events';

const id = '11111111-1111-4111-8111-111111111111';
const cwd = '/qoder-test';
const user = (uuid, text, extra = {}) => ({ type: 'user', uuid, sessionId: id, parentUuid: null,
  message: { role: 'user', content: text }, ...extra });

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codeck-qoder-source-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'projects', '-qoder-test', `${id}.jsonl`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const write = entries => fs.writeFile(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  const append = entries => fs.appendFile(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  const source = new QoderSessionSource({ configDir: root });
  return { source, file, write, append };
}

test('Qoder confirms newly appended input even when SDK active-branch history loses the baseline', async t => {
  const { source, write, append } = await setup(t);
  await write([user('old', 'Continue')]);
  const baseline = await source.prepare({ threadId: id, cwd, text: 'Continue' });
  source.record({ threadId: id, commandId: 'command-1', text: 'Continue', deliveryBaseline: baseline });
  assert.deepEqual(source.confirmations(id), []);
  await append([user('new', 'Continue'), { type: 'active-leaf', sessionId: id, leafUuid: 'new' }]);
  const messages = await source.getSessionMessages(id, { dir: cwd });
  assert.deepEqual(messages.map(m => m.uuid), ['new'], 'retain SDK branch semantics');
  assert.deepEqual(source.confirmations(id), [{ commandId: 'command-1', itemId: 'new' }]);
  await append([{ type: 'active-leaf', sessionId: id, leafUuid: null }]);
  assert.deepEqual(await source.getSessionMessages(id, { dir: cwd }), []);
  assert.deepEqual(source.confirmations(id), [{ commandId: 'command-1', itemId: 'new' }], 'observed receipt does not regress after clear');
});

test('Qoder never confirms old, rewritten, tool-result, or duplicate same-text records', async t => {
  const { source, write, append } = await setup(t);
  await write([user('old', 'Continue')]);
  for (const commandId of ['command-1', 'command-2']) {
    const deliveryBaseline = await source.prepare({ threadId: id, cwd, text: 'Continue' });
    source.record({ threadId: id, commandId, text: 'Continue', deliveryBaseline });
  }
  await append([
    user('old', 'Continue'), user('meta', 'Continue', { isMeta: true }),
    user('compact', 'Continue', { isCompactSummary: true }),
    user('side', 'Continue', { isSidechain: true }),
    user('result', [{ type: 'tool_result', content: 'Continue', tool_use_id: 'tool' }]),
    user('new-1', 'Continue'),
  ]);
  await source.getSessionMessages(id, { dir: cwd });
  assert.deepEqual(source.confirmations(id), [{ commandId: 'command-1', itemId: 'new-1' }]);
  await append([user('new-2', 'Continue')]);
  await source.getSessionMessages(id, { dir: cwd });
  assert.deepEqual(source.confirmations(id).map(c => c.itemId), ['new-1', 'new-2']);
  const deliveryBaseline = await source.prepare({ threadId: id, cwd, text: 'Continue' });
  source.record({ threadId: id, commandId: 'command-rewrite', text: 'Continue', deliveryBaseline });
  await write(Array.from({ length: 12 }, (_, n) => user(`rewritten-${n}`, 'Continue')));
  await source.getSessionMessages(id, { dir: cwd });
  assert.equal(source.confirmations(id).length, 2, 'a rewritten source is not evidence of delivery');
});

test('Qoder propagates read errors, keeps SDK clear semantics, and skips malformed JSONL lines', async t => {
  const { source, file, write } = await setup(t);
  await assert.rejects(source.getSessionMessages(id, { dir: cwd }), /ENOENT/);
  await write([user('old', 'Hello'), { type: 'active-leaf', sessionId: id, leafUuid: null }]);
  assert.deepEqual(await source.getSessionMessages(id, { dir: cwd }), []);
  await fs.appendFile(file, '{broken\n' + JSON.stringify(user('new', 'Hello again')) + '\n'
    + JSON.stringify({ type: 'active-leaf', sessionId: id, leafUuid: 'new' }) + '\n');
  assert.deepEqual((await source.getSessionMessages(id, { dir: cwd })).map(m => m.uuid), ['new']);
});

test('Qoder hides raw compaction summaries after SDK branch reconstruction without changing history', async t => {
  const { source, write } = await setup(t);
  const summary = 'This session is being continued from a previous conversation that ran out of context.';
  await write([
    user('user-1', 'Continue the fix'),
    { type: 'assistant', uuid: 'assistant-1', sessionId: id, parentUuid: 'user-1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Checking.' }] } },
    { type: 'system', subtype: 'compact_boundary', uuid: 'compact-boundary', sessionId: id,
      parentUuid: null, logicalParentUuid: 'assistant-1', message: { role: 'system', content: '' },
      compactMetadata: { trigger: 'auto' } },
    user('compact-summary', summary, { parentUuid: 'compact-boundary', isCompactSummary: true,
      isVisibleInTranscriptOnly: true }),
    { type: 'assistant', uuid: 'assistant-2', sessionId: id, parentUuid: 'compact-summary',
      message: { role: 'assistant', content: [{ type: 'text', text: 'The fix is complete.' }] } },
    user('user-2', summary, { parentUuid: 'assistant-2' }),
    { type: 'assistant', uuid: 'assistant-3', sessionId: id, parentUuid: 'user-2',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Ordinary user text is preserved.' }] } },
  ]);
  const backend = new SdkAgentBackend({ provider: 'qodercli', label: 'QoderCLI', sessionSource: source,
    getSessionInfo: async () => ({ sessionId: id, cwd, lastModified: 1, fileSize: 1 }) });
  t.after(() => backend.close());

  const opened = await backend.openThread(id);
  assert.deepEqual(opened.thread.turns.flatMap(turn => turn.items).map(item => (
    item.type === 'userMessage' ? ['user', item.content[0].text] : ['assistant', item.text]
  )), [
    ['user', 'Continue the fix'],
    ['assistant', 'Checking.'],
    ['assistant', 'The fix is complete.'],
    ['user', summary],
    ['assistant', 'Ordinary user text is preserved.'],
  ]);
});

test('Qoder retains active history that precedes a compaction root', async t => {
  const { source, write } = await setup(t);
  const assistant = (uuid, parentUuid, text) => ({
    type: 'assistant', uuid, sessionId: id, parentUuid,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  });
  await write([
    user('user-old', 'Old question'),
    assistant('assistant-old', 'user-old', 'Old answer'),
    user('user-preserved', 'Preserved question', { parentUuid: 'assistant-old' }),
    assistant('assistant-preserved', 'user-preserved', 'Preserved answer'),
    { type: 'system', subtype: 'compact_boundary', uuid: 'compact-boundary', sessionId: id,
      parentUuid: null, logicalParentUuid: 'assistant-preserved',
      message: { role: 'system', content: '' },
      compactMetadata: { trigger: 'auto', preservedSegment: {
        headUuid: 'user-preserved', anchorUuid: 'compact-summary', tailUuid: 'assistant-preserved',
      } } },
    user('compact-summary', 'Internal summary', { parentUuid: 'compact-boundary',
      isCompactSummary: true, isVisibleInTranscriptOnly: true }),
    user('user-preserved', 'Preserved question', { parentUuid: 'compact-summary' }),
    assistant('assistant-preserved', 'user-preserved', 'Preserved answer'),
    user('user-new', 'New question', { parentUuid: 'assistant-preserved' }),
    assistant('assistant-new', 'user-new', 'New answer'),
    { type: 'system', subtype: 'compact_boundary', uuid: 'compact-boundary-2', sessionId: id,
      parentUuid: null, logicalParentUuid: 'assistant-new', message: { role: 'system', content: '' },
      compactMetadata: { trigger: 'auto', preservedSegment: {
        headUuid: 'user-new', anchorUuid: 'compact-summary-2', tailUuid: 'assistant-new',
      } } },
    user('compact-summary-2', 'Second internal summary', { parentUuid: 'compact-boundary-2',
      isCompactSummary: true, isVisibleInTranscriptOnly: true }),
    user('user-new', 'New question', { parentUuid: 'compact-summary-2' }),
    assistant('assistant-new', 'user-new', 'New answer'),
    user('user-latest', 'Latest question', { parentUuid: 'assistant-new' }),
    assistant('assistant-latest', 'user-latest', 'Latest answer'),
    { type: 'active-leaf', sessionId: id, leafUuid: 'assistant-latest' },
  ]);
  const backend = new SdkAgentBackend({ provider: 'qodercli', label: 'QoderCLI', sessionSource: source,
    getSessionInfo: async () => ({ sessionId: id, cwd, lastModified: 1, fileSize: 1 }) });
  t.after(() => backend.close());

  const opened = await backend.openThread(id);
  assert.deepEqual(opened.thread.turns.flatMap(turn => turn.items).map(item => (
    item.type === 'userMessage' ? item.content[0].text : item.text
  )), [
    'Old question', 'Old answer',
    'Preserved question', 'Preserved answer',
    'New question', 'New answer',
    'Latest question', 'Latest answer',
  ]);
});

test('Qoder restores compacted history when the SDK omits the active boundary', async t => {
  const { source, write } = await setup(t);
  await write([
    user('user-old', 'Old question'),
    { type: 'assistant', uuid: 'assistant-old', sessionId: id, parentUuid: 'user-old',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Old answer' }] } },
    { type: 'system', subtype: 'compact_boundary', uuid: 'compact-boundary', sessionId: id,
      parentUuid: null, logicalParentUuid: 'assistant-old', isMeta: true,
      message: { role: 'system', content: '' }, compactMetadata: { trigger: 'auto' } },
    user('compact-summary', 'Internal summary', { parentUuid: 'compact-boundary',
      isCompactSummary: true, isVisibleInTranscriptOnly: true }),
    user('user-new', 'New question', { parentUuid: 'compact-summary' }),
    { type: 'assistant', uuid: 'assistant-new', sessionId: id, parentUuid: 'user-new',
      message: { role: 'assistant', content: [{ type: 'text', text: 'New answer' }] } },
    { type: 'active-leaf', sessionId: id, leafUuid: 'assistant-new' },
  ]);

  assert.deepEqual((await source.getSessionMessages(id, { dir: cwd })).map(message => message.uuid), [
    'user-old', 'assistant-old', 'compact-summary', 'user-new', 'assistant-new',
  ]);
});

test('Qoder does not restore history from an abandoned compaction branch', async t => {
  const { source, write } = await setup(t);
  await write([
    user('user-main', 'Main question'),
    { type: 'assistant', uuid: 'assistant-main', sessionId: id, parentUuid: 'user-main',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Main answer' }] } },
    { type: 'system', subtype: 'compact_boundary', uuid: 'abandoned-boundary', sessionId: id,
      parentUuid: null, logicalParentUuid: 'assistant-main', message: { role: 'system', content: '' },
      compactMetadata: { trigger: 'auto' } },
    user('abandoned-summary', 'Abandoned summary', { parentUuid: 'abandoned-boundary',
      isCompactSummary: true }),
    user('abandoned-user', 'Abandoned question', { parentUuid: 'abandoned-summary' }),
    user('user-current', 'Current question', { parentUuid: 'assistant-main' }),
    { type: 'assistant', uuid: 'assistant-current', sessionId: id, parentUuid: 'user-current',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Current answer' }] } },
    { type: 'active-leaf', sessionId: id, leafUuid: 'assistant-current' },
  ]);

  assert.deepEqual((await source.getSessionMessages(id, { dir: cwd })).map(message => message.uuid), [
    'user-main', 'assistant-main', 'user-current', 'assistant-current',
  ]);
});

test('Qoder deferred restoration returns the live tail first and reuses only historical prefixes', async t => {
  const { source, write, append } = await setup(t);
  await write([
    user('old', 'Old question'),
    { type: 'system', subtype: 'compact_boundary', uuid: 'boundary', sessionId: id,
      parentUuid: null, logicalParentUuid: 'old', message: { role: 'system', content: '' } },
    user('summary', 'Internal summary', { parentUuid: 'boundary', isCompactSummary: true }),
    user('latest', 'Latest question', { parentUuid: 'summary' }),
  ]);
  const tail = await source.getSessionMessages(id, { dir: cwd, deferCompactionRestore: true });
  assert.equal(tail.historyPending, true);
  assert.deepEqual(tail.map(m => m.uuid), ['summary', 'latest']);
  const state = source.compactionRestoreState.get(id);
  await state.inFlight;
  await append([user('newer', 'New input', { parentUuid: 'latest' })]);
  const complete = await source.getSessionMessages(id, { dir: cwd, deferCompactionRestore: true });
  assert.equal(source.compactionRestoreState.get(id), state, 'appending live output must not restart historical work');
  assert.deepEqual(complete.map(m => m.uuid), ['old', 'summary', 'latest', 'newer']);
  assert.equal(complete.historyPending, false);
  // Rewriting a boundary's parent must invalidate both restored-state and prefix caches.
  await write([
    user('old', 'Old question'),
    user('alternative', 'Alternative history'),
    { type: 'system', subtype: 'compact_boundary', uuid: 'boundary', sessionId: id,
      parentUuid: null, logicalParentUuid: 'alternative', message: { role: 'system', content: '' } },
    user('summary', 'Internal summary', { parentUuid: 'boundary', isCompactSummary: true }),
    user('latest', 'Latest question', { parentUuid: 'summary' }),
  ]);
  await source.getSessionMessages(id, { dir: cwd, deferCompactionRestore: true });
  assert.notEqual(source.compactionRestoreState.get(id), state);
  const pending = source.compactionRestoreState.get(id).inFlight;
  source.close();
  assert.deepEqual((await pending).map(m => m.uuid), ['alternative']);
  assert.equal(source.compactionRestoreState.size, 0);
  assert.equal(source.compactionHistory.size, 0, 'background completion cannot repopulate closed caches');
});

test('Qoder send preparation does not wait for compaction restoration', async t => {
  const { source, write } = await setup(t);
  await write([
    user('old', 'Old question'),
    { type: 'system', subtype: 'compact_boundary', uuid: 'boundary', sessionId: id,
      parentUuid: null, logicalParentUuid: 'old', message: { role: 'system', content: '' } },
    user('latest', 'Latest question', { parentUuid: 'boundary' }),
  ]);
  await source.getSessionMessages(id, { dir: cwd, deferCompactionRestore: true });
  const state = source.compactionRestoreState.get(id);
  await state.inFlight;
  state.ready = false;
  let release;
  state.inFlight = new Promise(resolve => { release = resolve; });
  t.after(() => release([]));
  const baseline = await Promise.race([
    source.prepare({ threadId: id, cwd, text: 'Continue' }),
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('send waited for history')), 1000);
      timer.unref();
      t.after(() => clearTimeout(timer));
    }),
  ]);
  assert.ok(baseline.offset > 0);
  assert.ok(source.compactionRestoreState.get(id).inFlight);
  const pending = source.compactionRestoreState.get(id).inFlight;
  source.close();
  release([]);
  await pending;
  assert.equal(source.compactionRestoreState.size, 0, 'completed background work cannot resurrect closed state');
});

test('Qoder Remote cold open advertises old history and paging cannot block live reads', async t => {
  const { source, write } = await setup(t);
  await write([
    user('old', 'Old question'),
    { type: 'system', subtype: 'compact_boundary', uuid: 'boundary', sessionId: id,
      parentUuid: null, logicalParentUuid: 'old', message: { role: 'system', content: '' } },
    user('latest', 'Latest question', { parentUuid: 'boundary' }),
  ]);
  const backend = new SdkAgentBackend({ provider: 'qodercli', label: 'QoderCLI', sessionSource: source,
    getSessionInfo: async () => ({ sessionId: id, cwd, lastModified: 1, fileSize: 1 }) });
  const registry = new AgentRegistry({ qodercli: backend });
  t.after(() => registry.close());
  const socket = new EventEmitter();
  socket.readyState = 1;
  const reply = new Promise(resolve => { socket.send = raw => {
    const message = JSON.parse(raw);
    if (message.id === 1) resolve(message);
  }; });
  const hub = new AgentHub(registry, { threadFeed: { subscribe: () => () => {} } });
  hub.handleConnection(socket);
  socket.emit('message', JSON.stringify({ id: 1, type: 'openThread', provider: 'qodercli', threadId: id, readOnly: true }));
  const opened = await reply;
  assert.equal(opened.ok, true);
  assert.equal(opened.result.thread.truncated, true);
  assert.deepEqual(opened.result.thread.turns.map(turn => turn.id), ['turn-latest']);
  const state = source.compactionRestoreState.get(id);
  const history = await state.inFlight;
  // A deterministic slow historical load must not be shared with the live lane.
  state.ready = false;
  let release;
  state.inFlight = new Promise(resolve => { release = resolve; });
  t.after(() => release(history));
  const pagePromise = registry.loadThreadHistory('qodercli', id, { beforeTurnId: 'turn-latest', limit: 20 });
  await new Promise(resolve => setImmediate(resolve));
  const live = await Promise.race([
    backend.openThread(id, { deferCompactionRestore: true }),
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('live read waited for pagination')), 1000);
      timer.unref();
      t.after(() => clearTimeout(timer));
    }),
  ]);
  assert.equal(live.thread.truncated, true);
  release(history);
  const page = await pagePromise;
  assert.deepEqual(page.turns.map(turn => turn.id), ['turn-old']);
  assert.equal(page.truncated, false);
  const full = await backend.openThread(id, { deferCompactionRestore: true });
  assert.deepEqual(full.thread.turns.map(turn => turn.id), ['turn-old', 'turn-latest']);
  assert.equal(Boolean(full.thread.truncated), false, 'partial cache cannot hide restored history at the same revision');
});

test('Qoder post-summary assistant keeps its pagination anchor after history restoration', async t => {
  const { source, write } = await setup(t);
  await write([
    user('old', 'Old question'),
    { type: 'system', subtype: 'compact_boundary', uuid: 'boundary', sessionId: id,
      parentUuid: null, logicalParentUuid: 'old', message: { role: 'system', content: '' } },
    user('summary', 'Internal summary', { parentUuid: 'boundary', isCompactSummary: true }),
    { type: 'assistant', uuid: 'answer', parentUuid: 'summary', sessionId: id,
      message: { role: 'assistant', content: 'Continued answer' } },
  ]);
  const backend = new SdkAgentBackend({ provider: 'qodercli', label: 'QoderCLI', sessionSource: source,
    getSessionInfo: async () => ({ sessionId: id, cwd, lastModified: 1, fileSize: 1 }) });
  const registry = new AgentRegistry({ qodercli: backend });
  t.after(() => registry.close());
  const { thread } = await backend.openThread(id, { deferCompactionRestore: true });
  const anchor = thread.oldestTurnId;
  const page = await registry.loadThreadHistory('qodercli', id, { beforeTurnId: anchor, limit: 20 });
  assert.deepEqual(page.turns.map(turn => turn.id), ['turn-old']);
  const complete = await backend.openThread(id);
  assert.deepEqual(complete.thread.turns.at(-1), thread.turns[0]);
});

test('server stream window uses a visible pagination anchor while Qoder history is pending', async () => {
  const server = await fs.readFile(new URL('../src/server.js', import.meta.url), 'utf8');
  const start = server.indexOf('function windowedThread(');
  const end = server.indexOf('\nconst threadFeed', start);
  assert.ok(start >= 0 && end > start);
  const window = new Function('THREAD_STREAM_TURN_WINDOW',
    `${server.slice(start, end)}; return windowedThread;`)(20);
  const turns = Array.from({ length: 30 }, (_, index) => ({ id: `turn-${index}`, items: [] }));
  const result = window({ thread: { turns, truncated: true, oldestTurnId: 'turn-0' } });
  assert.equal(result.thread.oldestTurnId, result.thread.turns[0].id);
  assert.equal(result.thread.turns.length, 20);
});

test('Qoder exposes an unresolved receipt after a bounded wait and can still confirm it later', async t => {
  const { source, write, append } = await setup(t);
  let now = 1000;
  source.now = () => now;
  await write([user('old', 'Start')]);
  const deliveryBaseline = await source.prepare({ threadId: id, cwd, text: 'Continue' });
  source.record({ threadId: id, commandId: 'command-1', text: 'Continue', deliveryBaseline });
  assert.deepEqual(source.unconfirmed(id), []);
  now += 60_000;
  assert.deepEqual(source.unconfirmed(id), ['command-1']);
  await append([user('new', 'Continue')]);
  await source.getSessionMessages(id, { dir: cwd });
  assert.deepEqual(source.unconfirmed(id), []);
  assert.deepEqual(source.confirmations(id), [{ commandId: 'command-1', itemId: 'new' }]);
});

test('Qoder confirms CLI receipt while queued input has no new transcript revision', async t => {
  const { source, file, write, append } = await setup(t);
  const logFile = path.join(path.dirname(path.dirname(path.dirname(file))), 'tmp', '-qoder-test', 'logs.json');
  await fs.mkdir(path.dirname(logFile), { recursive: true });
  const logged = (messageId, message, sessionId = id) => ({ sessionId, messageId, type: 'user', message,
    timestamp: new Date().toISOString() });
  const old = logged(0, 'Continue');
  await fs.writeFile(logFile, JSON.stringify([old]));
  await write([user('old', 'Start')]);
  let now = 1000;
  source.now = () => now;
  let revision = 1;
  const backend = new SdkAgentBackend({ provider: 'qodercli', label: 'QoderCLI', sessionSource: source,
    getSessionInfo: async () => ({ sessionId: id, cwd, lastModified: revision, fileSize: revision }) });
  t.after(() => backend.close());
  await backend.openThread(id);
  const deliveryBaseline = await backend.prepareSessionMessage({ threadId: id, commandId: 'command-1', text: 'Continue' });
  backend.recordSessionMessage({ threadId: id, commandId: 'command-1', text: 'Continue', deliveryBaseline });
  await backend.openThread(id); // Consume the post-send cache invalidation before the log write.
  now += 60_000;
  await fs.writeFile(logFile, JSON.stringify([old, logged(0, 'Continue', 'other-session')]));
  assert.deepEqual((await backend.openThread(id)).thread.receivedDeliveryIds, []);
  await fs.writeFile(logFile, JSON.stringify([old, logged(0, 'Continue', 'other-session'), logged(1, 'Continue')]));
  const received = (await backend.openThread(id)).thread;
  assert.deepEqual(received.receivedDeliveryIds, ['command-1']);
  assert.deepEqual(received.unconfirmedDeliveryIds, []);
  assert.deepEqual(received.deliveryConfirmations, [], 'CLI receipt is not a fabricated transcript message');
  assert.equal(received.turns.length, 1);
  await append([user('actual', 'Continue', { parentUuid: 'old' })]);
  revision += 1;
  assert.deepEqual((await backend.openThread(id)).thread.deliveryConfirmations,
    [{ commandId: 'command-1', itemId: 'actual' }]);
});

test('Qoder input receipts reject replay, replacement and duplicate matches, and recover from partial log writes', async t => {
  const { source, file, write } = await setup(t);
  const logFile = path.join(path.dirname(path.dirname(path.dirname(file))), 'tmp', '-qoder-test', 'logs.json');
  await fs.mkdir(path.dirname(logFile), { recursive: true });
  await write([user('old', 'Start')]);
  const logged = (messageId, message = 'Continue') => ({ sessionId: id, messageId, message,
    type: 'user', timestamp: new Date().toISOString() });
  const old = logged(0);
  await fs.writeFile(logFile, JSON.stringify([old]));
  const deliveryBaseline = await source.prepare({ threadId: id, cwd, text: 'Continue' });
  for (const commandId of ['one', 'two']) source.record({ threadId: id, text: 'Continue', commandId, deliveryBaseline });
  for (const entries of [[old], [old, old], [logged(1)], [old, logged(1, 'Different')]]) {
    await fs.writeFile(logFile, JSON.stringify(entries));
    assert.deepEqual(await source.received(id), []);
  }
  await fs.writeFile(logFile, '[{"sessionId":');
  assert.deepEqual(await source.received(id), []);
  const first = logged(1);
  await fs.writeFile(logFile, JSON.stringify([old, first, first]));
  assert.deepEqual(await source.received(id), ['one'], 'one CLI input cannot acknowledge two commands');
  await fs.writeFile(logFile, JSON.stringify([old, first, logged(2)]));
  assert.deepEqual(await source.received(id), ['one', 'two']);
  await fs.writeFile(logFile, '');
  assert.deepEqual(await source.received(id), ['one', 'two'], 'observed receipt must not regress');
});
