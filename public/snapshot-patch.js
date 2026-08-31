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
