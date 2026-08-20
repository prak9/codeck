import test from 'node:test';
import assert from 'node:assert/strict';
import { bindMobileScroll } from '../public/mobile-scroll.js';

function touchEvent(type, touches) {
  const event = new Event(type, { cancelable: true });
  Object.defineProperty(event, 'touches', { value: touches });
  return event;
}

function createGesture(options = {}) {
  const container = new EventTarget();
  let selectionStarts = 0;
  container.querySelector = () => { selectionStarts += 1; return null; };
  const terminal = {
    rows: 10,
    options: { fontSize: 16 },
    clearSelection() {},
    getSelection: () => '',
    hasSelection: () => false,
  };
  const cancel = bindMobileScroll(container, terminal, () => {}, {
    isMobile: () => true,
    longPressMs: 5,
    ...options,
  });
  return { cancel, container, selectionStarts: () => selectionStarts };
}

test('touchcancel clears a pending long press', async () => {
  const gesture = createGesture();
  gesture.container.dispatchEvent(touchEvent('touchstart', [{ clientX: 10, clientY: 10 }]));
  gesture.container.dispatchEvent(touchEvent('touchcancel', []));
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(gesture.selectionStarts(), 0);
  gesture.cancel();
});

test('one-finger panning while zoomed cannot turn into selection', async () => {
  const gesture = createGesture({ getViewportScale: () => 2 });
  gesture.container.dispatchEvent(touchEvent('touchstart', [{ clientX: 10, clientY: 10 }]));
  gesture.container.dispatchEvent(touchEvent('touchmove', [{ clientX: 10, clientY: 20 }]));
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(gesture.selectionStarts(), 0);
  gesture.cancel();
});
