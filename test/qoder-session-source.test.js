import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { QoderSessionSource } from '../src/qoder-session-source.js';

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
