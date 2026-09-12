import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { AgentRegistry } from '../src/agent-connection.js';
import { encodeHistoryCursor, decodeHistoryCursor } from '../src/thread-history-cursor.js';

for (const provider of ['codex', 'claude', 'qodercli']) {
  test(`${provider} shares append-stable, thread-scoped pagination with legacy anchor compatibility`, async () => {
    const turns = Array.from({ length: 65 }, (_, id) => ({ id: `turn-${id}`, items: [] }));
    const backend = new EventEmitter();
    backend.openThread = async () => ({ thread: { id: 'thread', turns } });
    const registry = new AgentRegistry({ [provider]: backend });
    const legacy = await registry.loadThreadHistory(provider, 'thread', { beforeTurnId: 'turn-45', limit: 20 });
    assert.equal('nextCursor' in legacy, false);
    const first = await registry.loadThreadHistory(provider, 'thread', { beforeTurnId: 'turn-45', cursor: '', limit: 20 });
    assert.deepEqual(first.turns, turns.slice(25, 45));
    assert.equal(decodeHistoryCursor(first.nextCursor, provider, 'thread'), 'turn-25');
    turns.push({ id: 'turn-65', items: [] });
    const second = await registry.loadThreadHistory(provider, 'thread', { cursor: first.nextCursor, limit: 20 });
    assert.deepEqual(second.turns, turns.slice(5, 25));
    const last = await registry.loadThreadHistory(provider, 'thread', { cursor: second.nextCursor, limit: 20 });
    assert.deepEqual(last.turns, turns.slice(0, 5));
    assert.equal(last.nextCursor, null);
    assert.equal(last.truncated, false);
    await assert.rejects(registry.loadThreadHistory(provider, 'different-thread', { cursor: first.nextCursor, limit: 20 }), /Invalid/);
    await assert.rejects(registry.loadThreadHistory(provider, 'thread', { cursor: 'garbage', limit: 20 }), /Invalid/);
    const missing = encodeHistoryCursor(provider, 'thread', 'deleted');
    await assert.rejects(registry.loadThreadHistory(provider, 'thread', { cursor: missing, limit: 20 }), /anchor/);
  });
}

test('history cursors reject cross-provider reuse', () => {
  assert.throws(() => decodeHistoryCursor(encodeHistoryCursor('qodercli', 'thread', 'oldest'), 'codex', 'thread'), /Invalid/);
});
