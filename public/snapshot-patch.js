const UNSAFE_PATH_PARTS = new Set(['__proto__', 'prototype', 'constructor']);

function isObject(value) {
  return value !== null && typeof value === 'object';
}

function isSafePath(path) {
  return Array.isArray(path) && path.every((part) => (
    typeof part === 'number'
      ? Number.isSafeInteger(part) && part >= 0
      : typeof part === 'string' && !UNSAFE_PATH_PARTS.has(part)
  ));
}

function cloneValue(value) {
  if (!isObject(value)) return value;
  if (Array.isArray(value)) return value.map(cloneValue);
  const copy = {};
  for (const [key, child] of Object.entries(value)) {
    if (UNSAFE_PATH_PARTS.has(key)) throw new Error('Unsafe snapshot patch value');
    copy[key] = cloneValue(child);
  }
  return copy;
}

// Positional array diffing rewrites every element after an insertion, so a new entry in a
// sorted list (a tmux session, a delivery turn) produces a patch larger than the snapshot
// it replaces and the frame falls back to a full send — exactly when the update matters.
// Aligning by a stable element key first turns an insertion or a removal into one splice.
const KEYED_DIFF_LIMIT = 512;

function elementKey(value) {
  if (!isObject(value) || Array.isArray(value)) return null;
  if (typeof value.id === 'string' && value.id) return `id:${value.id}`;
  if (typeof value.name === 'string' && value.name) return `name:${value.name}`;
  return null;
}

function keySequence(items) {
  if (items.length > KEYED_DIFF_LIMIT) return null;
  const keys = [];
  const seen = new Set();
  for (const item of items) {
    const key = elementKey(item);
    if (!key || seen.has(key)) return null;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

function matchedPairs(before, after) {
  const n = before.length;
  const m = after.length;
  const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i][j] = before[i] === after[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) i += 1;
    else j += 1;
  }
  return pairs;
}

export function createSnapshotPatch(previous, next, { maxOperations = 512 } = {}) {
  if (!Number.isSafeInteger(maxOperations) || maxOperations < 1) return null;
  const operations = [];
  let exceeded = false;

  const add = (operation) => {
    if (operations.length >= maxOperations) {
      exceeded = true;
      return false;
    }
    operations.push(operation);
    return true;
  };

  const diff = (before, after, path) => {
    if (exceeded || Object.is(before, after)) return;
    if (typeof before === 'string' && typeof after === 'string' && after.startsWith(before)) {
      add({ op: 'append', path, value: after.slice(before.length) });
      return;
    }
    const beforeArray = Array.isArray(before);
    const afterArray = Array.isArray(after);
    if (!isObject(before) || !isObject(after) || beforeArray !== afterArray) {
      add({ op: 'set', path, value: after });
      return;
    }

    if (afterArray) {
      const beforeKeys = keySequence(before);
      const afterKeys = beforeKeys && keySequence(after);
      if (afterKeys) {
        const pairs = matchedPairs(beforeKeys, afterKeys);
        // Emit splices from the tail backwards so each one leaves the lower indices in
        // place. Once they have all applied the array holds the target key order, so the
        // per-element diffs that follow can address elements by their `after` index.
        const edits = [];
        let beforeEnd = before.length;
        let afterEnd = after.length;
        for (let index = pairs.length - 1; index >= -1; index -= 1) {
          const [pairBefore, pairAfter] = index >= 0 ? pairs[index] : [-1, -1];
          const remove = beforeEnd - (pairBefore + 1);
          const insert = after.slice(pairAfter + 1, afterEnd);
          if (remove || insert.length) {
            edits.push({ op: 'splice', path, index: pairBefore + 1, remove, insert });
          }
          beforeEnd = pairBefore;
          afterEnd = pairAfter;
        }
        for (const edit of edits) if (!add(edit)) return;
        for (const [pairBefore, pairAfter] of pairs) {
          if (exceeded) return;
          diff(before[pairBefore], after[pairAfter], [...path, pairAfter]);
        }
        return;
      }
      const shared = Math.min(before.length, after.length);
      for (let index = 0; index < shared && !exceeded; index += 1) {
        diff(before[index], after[index], [...path, index]);
      }
      if (after.length < before.length) add({ op: 'truncate', path, length: after.length });
      else {
        for (let index = shared; index < after.length && !exceeded; index += 1) {
          add({ op: 'set', path: [...path, index], value: after[index] });
        }
      }
      return;
    }

    for (const key of Object.keys(before)) {
      if (exceeded) return;
      if (UNSAFE_PATH_PARTS.has(key)) {
        exceeded = true;
        return;
      }
      if (!Object.hasOwn(after, key)) add({ op: 'remove', path: [...path, key] });
    }
    for (const key of Object.keys(after)) {
      if (exceeded) return;
      if (UNSAFE_PATH_PARTS.has(key)) {
        exceeded = true;
        return;
      }
      if (!Object.hasOwn(before, key)) add({ op: 'set', path: [...path, key], value: after[key] });
      else diff(before[key], after[key], [...path, key]);
    }
  };

  diff(previous, next, []);
  return exceeded ? null : operations;
}

function cloneNode(node) {
  return Array.isArray(node) ? [...node] : { ...node };
}

export function applySnapshotPatch(snapshot, operations) {
  if (!Array.isArray(operations)) throw new Error('Invalid snapshot patch operations');
  let root = snapshot;

  // Copy-on-write. The caller keeps the previous snapshot as the source of its render
  // model, so patching in place would make the old and new trees the same objects: a
  // structural comparison then reports "unchanged" and the view never repaints. Cloning
  // only the nodes along a patched path keeps untouched subtrees shared, and leaves the
  // input snapshot intact when a later operation rejects the whole patch.
  const owned = new WeakSet();

  const ownRoot = () => {
    if (isObject(root) && !owned.has(root)) {
      root = cloneNode(root);
      owned.add(root);
    }
    return root;
  };

  const ownPath = (path) => {
    let node = ownRoot();
    for (const part of path) {
      if (!isObject(node) || !Object.hasOwn(node, part)) throw new Error('Invalid snapshot patch path');
      let child = node[part];
      if (isObject(child) && !owned.has(child)) {
        child = cloneNode(child);
        owned.add(child);
        node[part] = child;
      }
      node = child;
    }
    return node;
  };

  for (const operation of operations) {
    if (!operation || typeof operation !== 'object' || !isSafePath(operation.path)) {
      throw new Error('Invalid snapshot patch path');
    }
    const { path } = operation;
    if (operation.op === 'set') {
      const value = cloneValue(operation.value);
      if (!path.length) {
        root = value;
        continue;
      }
      const parent = ownPath(path.slice(0, -1));
      const key = path.at(-1);
      if (!isObject(parent)) throw new Error('Invalid snapshot patch path');
      if (Array.isArray(parent)) {
        if (typeof key !== 'number' || key > parent.length) throw new Error('Invalid snapshot patch array path');
      } else if (typeof key !== 'string') {
        throw new Error('Invalid snapshot patch object path');
      }
      parent[key] = value;
      continue;
    }
    if (operation.op === 'remove') {
      if (!path.length) throw new Error('Invalid snapshot patch path');
      const parent = ownPath(path.slice(0, -1));
      const key = path.at(-1);
      if (!isObject(parent) || Array.isArray(parent) || typeof key !== 'string' || !Object.hasOwn(parent, key)) {
        throw new Error('Invalid snapshot patch path');
      }
      delete parent[key];
      continue;
    }
    if (operation.op === 'append') {
      if (typeof operation.value !== 'string') throw new Error('Invalid snapshot patch append');
      if (!path.length) {
        if (typeof root !== 'string') throw new Error('Invalid snapshot patch append path');
        root += operation.value;
        continue;
      }
      const parent = ownPath(path.slice(0, -1));
      const key = path.at(-1);
      if (!isObject(parent) || !Object.hasOwn(parent, key) || typeof parent[key] !== 'string') {
        throw new Error('Invalid snapshot patch append path');
      }
      parent[key] += operation.value;
      continue;
    }
    if (operation.op === 'splice') {
      if (!Array.isArray(operation.insert)) throw new Error('Invalid snapshot patch array');
      let target;
      try { target = ownPath(path); }
      catch { throw new Error('Invalid snapshot patch array'); }
      if (!Array.isArray(target)
        || !Number.isSafeInteger(operation.index) || operation.index < 0
        || !Number.isSafeInteger(operation.remove) || operation.remove < 0
        || operation.index + operation.remove > target.length) {
        throw new Error('Invalid snapshot patch array');
      }
      target.splice(operation.index, operation.remove, ...operation.insert.map(cloneValue));
      continue;
    }
    if (operation.op === 'truncate') {
      let target;
      try { target = ownPath(path); }
      catch { throw new Error('Invalid snapshot patch array'); }
      if (!Array.isArray(target) || !Number.isSafeInteger(operation.length)
        || operation.length < 0 || operation.length > target.length) {
        throw new Error('Invalid snapshot patch array');
      }
      target.length = operation.length;
      continue;
    }
    throw new Error('Invalid snapshot patch operation');
  }

  return root;
}
