import test from 'node:test';
import assert from 'node:assert/strict';
import { applySnapshotPatch, createSnapshotPatch } from '../public/snapshot-patch.js';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('snapshot patches reproduce nested object and array changes exactly', () => {
  const previous = {
    capabilities: { canWrite: true, obsolete: true },
    thread: {
      id: 'thread-1',
      turns: [
        { id: 'turn-1', status: 'completed', items: [{ id: 'one', text: 'done' }] },
        { id: 'turn-2', status: 'inProgress', items: [{ id: 'two', text: 'hel' }] },
        { id: 'stale', status: 'completed', items: [] },
      ],
    },
  };
  const next = {
    capabilities: { canWrite: false, canManage: true },
    thread: {
      id: 'thread-1',
      turns: [
        { id: 'turn-1', status: 'completed', items: [{ id: 'one', text: 'done' }] },
        { id: 'turn-2', status: 'completed', items: [
          { id: 'two', text: 'hello' },
          { id: 'three', text: 'final' },
        ] },
      ],
    },
  };

  const patch = createSnapshotPatch(previous, next);
  assert.deepEqual(applySnapshotPatch(clone(previous), patch), next);
  assert.ok(patch.length > 0);
});

test('snapshot patches stay small when only the active tail of a long thread changes', () => {
  const previous = {
    thread: {
      id: 'thread-1',
      turns: Array.from({ length: 80 }, (_, index) => ({
        id: `turn-${index}`,
        status: index === 79 ? 'inProgress' : 'completed',
        items: [{ id: `item-${index}`, type: 'agentMessage', text: 'x'.repeat(2_000) }],
      })),
    },
  };
  const next = clone(previous);
  next.thread.turns[79].items[0].text += 'next token';

  const patch = createSnapshotPatch(previous, next);
  assert.deepEqual(applySnapshotPatch(clone(previous), patch), next);
  assert.ok(JSON.stringify(patch).length < JSON.stringify(next).length / 100);
});

test('snapshot patch creation stops at its operation limit', () => {
  const previous = { values: Array.from({ length: 20 }, () => 0) };
  const next = { values: Array.from({ length: 20 }, () => 1) };
  assert.equal(createSnapshotPatch(previous, next, { maxOperations: 4 }), null);
});

test('snapshot patch application rejects unsafe or malformed paths', () => {
  assert.throws(() => applySnapshotPatch({}, [{ op: 'set', path: ['__proto__', 'polluted'], value: true }]), /path/i);
  assert.throws(() => applySnapshotPatch({}, [{ op: 'truncate', path: ['missing'], length: 0 }]), /array/i);
  assert.equal({}.polluted, undefined);
});

test('applying a patch leaves the previous snapshot untouched', () => {
  // 客户端把上一帧快照同时作为渲染模型的来源; 就地改写会让"新旧对比"
  // 失效 —— 渲染层据此判定"无变化"而不重绘。
  const previous = { turns: [{ id: 'u1', items: [{ id: 'i1', result: { stdout: 'partial' } }] }] };
  const next = structuredClone(previous);
  next.turns[0].items[0].result.stdout = 'partial+more';

  const before = structuredClone(previous);
  const patched = applySnapshotPatch(previous, createSnapshotPatch(previous, next));

  assert.deepEqual(patched, next);
  assert.deepEqual(previous, before, 'previous snapshot must not be mutated');
  assert.notEqual(patched, previous);
  assert.notEqual(patched.turns[0].items[0].result, previous.turns[0].items[0].result);
});

test('untouched subtrees stay shared with the previous snapshot', () => {
  const previous = { keep: { deep: [1, 2] }, change: { text: 'a' } };
  const next = structuredClone(previous);
  next.change.text = 'ab';

  const patched = applySnapshotPatch(previous, createSnapshotPatch(previous, next));

  assert.equal(patched.keep, previous.keep, 'unchanged subtree should not be cloned');
  assert.notEqual(patched.change, previous.change);
});

test('a failed patch leaves the previous snapshot intact', () => {
  const previous = { a: { text: 'x' }, b: 1 };
  const before = structuredClone(previous);

  assert.throws(() => applySnapshotPatch(previous, [
    { op: 'append', path: ['a', 'text'], value: 'y' },
    { op: 'truncate', path: ['missing'], length: 0 },
  ]), /array/i);
  assert.deepEqual(previous, before, 'a rejected patch must not partially apply');
});

test('inserting into a keyed list costs one operation wherever it lands', () => {
  // 会话列表是排序的, 新会话常常插在队首/中间。按下标比对会重写其后每一项,
  // 补丁反而比全量还大 (实测队首插入 = 全量的 143%) 而回落全量 —— 恰恰是最
  // 该省的时刻付全价。按 key 对齐后, 插入应退化成一个 splice。
  const item = (id) => ({ id, payload: 'x'.repeat(40) });
  const previous = { list: ['a', 'b', 'c', 'd'].map(item) };

  for (const position of [0, 2, 4]) {
    const next = structuredClone(previous);
    next.list.splice(position, 0, item('new'));
    const patch = createSnapshotPatch(previous, next);
    assert.equal(patch.length, 1, `insert at ${position} should be one operation`);
    assert.deepEqual(applySnapshotPatch(structuredClone(previous), patch), next);
  }
});

test('removing from a keyed list costs one operation', () => {
  const item = (id) => ({ id, payload: 'y'.repeat(40) });
  const previous = { list: ['a', 'b', 'c', 'd'].map(item) };
  const next = structuredClone(previous);
  next.list.splice(1, 1);

  const patch = createSnapshotPatch(previous, next);
  assert.equal(patch.length, 1);
  assert.deepEqual(applySnapshotPatch(structuredClone(previous), patch), next);
});

test('a keyed list still diffs surviving elements field by field', () => {
  const previous = { list: [{ id: 'a', text: 'one' }, { id: 'b', text: 'two' }] };
  const next = structuredClone(previous);
  next.list[1].text = 'two+more';

  const patch = createSnapshotPatch(previous, next);
  assert.deepEqual(patch, [{ op: 'append', path: ['list', 1, 'text'], value: '+more' }]);
  assert.deepEqual(applySnapshotPatch(structuredClone(previous), patch), next);
});

test('an insert combined with an edit stays correct', () => {
  const previous = { list: [{ id: 'a', n: 1 }, { id: 'b', n: 2 }, { id: 'c', n: 3 }] };
  const next = { list: [{ id: 'z', n: 0 }, { id: 'a', n: 1 }, { id: 'c', n: 9 }] };

  const patch = createSnapshotPatch(previous, next);
  assert.deepEqual(applySnapshotPatch(structuredClone(previous), patch), next);
});

test('lists without stable keys keep the positional diff', () => {
  const previous = { list: [1, 2, 3] };
  const next = { list: [1, 2, 3, 4] };
  assert.deepEqual(createSnapshotPatch(previous, next), [{ op: 'set', path: ['list', 3], value: 4 }]);
});

test('duplicate keys fall back to the positional diff', () => {
  const previous = { list: [{ id: 'a', n: 1 }, { id: 'a', n: 2 }] };
  const next = { list: [{ id: 'a', n: 1 }, { id: 'a', n: 3 }] };
  const patch = createSnapshotPatch(previous, next);
  assert.deepEqual(applySnapshotPatch(structuredClone(previous), patch), next);
});

test('splice keeps copy-on-write and rejects an out-of-range range', () => {
  const previous = { list: [{ id: 'a' }, { id: 'b' }] };
  const patched = applySnapshotPatch(previous, [
    { op: 'splice', path: ['list'], index: 1, remove: 0, insert: [{ id: 'x' }] },
  ]);
  assert.equal(previous.list.length, 2, 'input must not be mutated');
  assert.deepEqual(patched.list.map((entry) => entry.id), ['a', 'x', 'b']);

  assert.throws(() => applySnapshotPatch(previous, [
    { op: 'splice', path: ['list'], index: 9, remove: 0, insert: [] },
  ]), /array/i);
  assert.throws(() => applySnapshotPatch(previous, [
    { op: 'splice', path: ['list'], index: 0, remove: 0, insert: [JSON.parse('{"__proto__": 1}')] },
  ]), /unsafe/i);
});
