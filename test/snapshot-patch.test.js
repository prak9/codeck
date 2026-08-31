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
