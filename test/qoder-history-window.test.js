import test from 'node:test';
import assert from 'node:assert/strict';
import { QoderHistoryWindowCache } from '../src/qoder-history-window.js';

test('Qoder windows are detached from full graphs and from each reader', () => {
  const cache = new QoderHistoryWindowCache();
  const result = { thread: { turns: [{ id: 'one', items: [{ text: 'original' }] }] } };
  cache.set('session', 'revision', 20, result);
  result.thread.turns[0].items[0].text = 'changed';
  const first = cache.get('session', 'revision', 20);
  assert.equal(first.thread.turns[0].items[0].text, 'original');
  first.thread.turns.push({ id: 'runtime' });
  assert.equal(cache.get('session', 'revision', 20).thread.turns.length, 1);
  assert.equal(cache.get('session', 'other-revision', 20), null);
  assert.equal(cache.get('session', 'revision', 40), null);
});

test('Qoder windows enforce byte and entry budgets and reject oversized replacements', () => {
  const cache = new QoderHistoryWindowCache({ maxBytes: 1024, maxEntries: 2 });
  const value = { text: 'x'.repeat(300) };
  cache.set('one', 'r', 20, value);
  cache.set('two', 'r', 20, value);
  assert.ok(cache.get('one', 'r', 20));
  cache.set('three', 'r', 20, value);
  assert.equal(cache.get('two', 'r', 20), null, 'least recently used window is evicted');
  assert.ok(cache.get('one', 'r', 20));
  cache.set('one', 'r2', 20, { text: 'x'.repeat(1024) });
  assert.equal(cache.get('one', 'r', 20), null, 'oversized replacement cannot leave a stale window');
  assert.equal(cache.get('one', 'r2', 20), null);
  const bounded = new QoderHistoryWindowCache({ maxBytes: 1024, maxEntries: 100 });
  for (let index = 0; index < 20; index += 1) {
    bounded.set(String(index), 'r', 20, value);
    assert.ok(bounded.bytes <= 1024);
  }
  assert.equal(bounded.get('0', 'r', 20), null);
  assert.ok(bounded.get('19', 'r', 20));
  for (const key of [...bounded.entries.keys()]) bounded.delete(key);
  assert.equal(bounded.bytes, 0);
});
