import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveViewportGeometry } from '../public/remote-viewport.js';

test('tracks the visual viewport height and top offset while the mobile keyboard is open', () => {
  assert.deepEqual(resolveViewportGeometry({ height: 487.4, offsetTop: 126.6 }, 844), {
    height: 487,
    top: 127,
  });
});

test('falls back to the layout viewport and rejects invalid visual viewport values', () => {
  assert.deepEqual(resolveViewportGeometry(undefined, 844), { height: 844, top: 0 });
  assert.deepEqual(resolveViewportGeometry({ height: 0, offsetTop: -20 }, 844), { height: 844, top: 0 });
});
