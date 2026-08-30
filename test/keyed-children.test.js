import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileChildOrder } from '../public/keyed-children.js';

class FakeNode {
  constructor(id) {
    this.id = id;
    this.parentNode = null;
  }

  get nextSibling() {
    if (!this.parentNode) return null;
    const index = this.parentNode.children.indexOf(this);
    return this.parentNode.children[index + 1] || null;
  }
}

class FakeParent {
  constructor(children = []) {
    this.children = [];
    for (const child of children) this.insertBefore(child, null);
  }

  get firstChild() { return this.children[0] || null; }

  insertBefore(node, reference) {
    if (node.parentNode) node.parentNode.removeChild(node);
    const index = reference == null ? this.children.length : this.children.indexOf(reference);
    if (index < 0) throw new Error('reference is not a child');
    this.children.splice(index, 0, node);
    node.parentNode = this;
    return node;
  }

  removeChild(node) {
    const index = this.children.indexOf(node);
    if (index < 0) throw new Error('node is not a child');
    this.children.splice(index, 1);
    node.parentNode = null;
    return node;
  }
}

test('keyed rendering reorders reusable nodes and removes stale children without recreating them', () => {
  const one = new FakeNode('one');
  const two = new FakeNode('two');
  const stale = new FakeNode('stale');
  const three = new FakeNode('three');
  const parent = new FakeParent([one, two, stale]);

  reconcileChildOrder(parent, [two, one, three]);

  assert.deepEqual(parent.children, [two, one, three]);
  assert.equal(parent.children[0], two);
  assert.equal(parent.children[1], one);
  assert.equal(stale.parentNode, null);
});
