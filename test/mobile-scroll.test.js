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

function selectionGesture(t, platform, tracking) {
  const document = new EventTarget();
  const mouseEvents = [];
  const frames = new Map();
  const scrolls = [];
  const target = new EventTarget();
  const container = new EventTarget();
  const terminal = {
    rows: 10,
    options: { fontSize: 16, macOptionClickForcesSelection: false },
    modes: { mouseTrackingMode: tracking ? 'drag' : 'none' },
    clearSelection() {}, getSelection: () => '', hasSelection: () => false,
  };
  const globals = {
    document, window: {}, navigator: { platform },
    MouseEvent: class extends Event {
      constructor(type, { bubbles, cancelable, ...init }) {
        super(type, { bubbles, cancelable });
        Object.assign(this, init);
      }
    },
    requestAnimationFrame: (callback) => { frames.set(1, callback); return 1; },
    cancelAnimationFrame: (id) => frames.delete(id),
  };
  const previousGlobals = new Map();
  for (const [name, value] of Object.entries(globals)) {
    previousGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  const record = (event) => mouseEvents.push({
    type: event.type, shift: Boolean(event.shiftKey), alt: Boolean(event.altKey),
    macForcesSelection: terminal.options.macOptionClickForcesSelection,
  });
  target.addEventListener('mousedown', record);
  document.addEventListener('mousemove', record);
  document.addEventListener('mouseup', record);
  container.querySelector = (selector) => selector === '.xterm' ? target : { clientHeight: 200 };
  const cancel = bindMobileScroll(container, terminal, (rows) => scrolls.push(rows), {
    isMobile: () => true, getViewportScale: () => 1, longPressMs: 5,
  });
  t.after(() => {
    cancel();
    for (const [name, previous] of previousGlobals) {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else delete globalThis[name];
    }
  });
  const touch = (type, points = [{ clientX: 20, clientY: 30 }]) => container.dispatchEvent(touchEvent(type, points));
  return { touch, terminal, mouseEvents, cancel, scrolls, frames };
}

for (const platform of ['Linux armv8l', 'iPhone', 'MacIntel']) {
  for (const tracking of [false, true]) {
    test(`long press forces only local selection on ${platform}, tracking=${tracking}`, async (t) => {
      const gesture = selectionGesture(t, platform, tracking);
      gesture.touch('touchstart');
      await new Promise((resolve) => setTimeout(resolve, 15));
      gesture.touch('touchmove', [{ clientX: 60, clientY: 70 }]);
      gesture.touch('touchend', []);
      const mac = platform === 'MacIntel';
      assert.deepEqual(gesture.mouseEvents, [
        { type: 'mousedown', shift: tracking && !mac, alt: tracking && mac, macForcesSelection: tracking && mac },
        { type: 'mousemove', shift: false, alt: false, macForcesSelection: false },
        { type: 'mouseup', shift: false, alt: false, macForcesSelection: false },
      ]);
      assert.equal(gesture.terminal.options.macOptionClickForcesSelection, false, 'desktop option must be restored');
      assert.deepEqual(gesture.scrolls, []);
    });
  }
}

test('a second finger and cancellation release selection without leaving Alt held', async (t) => {
  const gesture = selectionGesture(t, 'MacIntel', true);
  gesture.touch('touchstart');
  await new Promise((resolve) => setTimeout(resolve, 15));
  gesture.touch('touchstart', [{ clientX: 20, clientY: 30 }, { clientX: 80, clientY: 30 }]);
  gesture.touch('touchcancel', []);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.deepEqual(gesture.mouseEvents.map(({ type, alt }) => ({ type, alt })), [
    { type: 'mousedown', alt: true }, { type: 'mouseup', alt: false },
  ]);
  assert.equal(gesture.terminal.options.macOptionClickForcesSelection, false);
});

test('long press preserves an already enabled Mac selection option', async (t) => {
  const gesture = selectionGesture(t, 'MacIntel', true);
  gesture.terminal.options.macOptionClickForcesSelection = true;
  gesture.touch('touchstart');
  await new Promise((resolve) => setTimeout(resolve, 15));
  gesture.touch('touchend', []);
  assert.equal(gesture.terminal.options.macOptionClickForcesSelection, true);
  assert.equal(gesture.mouseEvents.at(-1).alt, false);
});

test('ordinary swipes still scroll and cancellation discards a queued scroll', async (t) => {
  const gesture = selectionGesture(t, 'Linux armv8l', true);
  gesture.touch('touchstart');
  gesture.touch('touchmove', [{ clientX: 20, clientY: 70 }]);
  for (const callback of gesture.frames.values()) callback();
  gesture.frames.clear();
  assert.deepEqual(gesture.scrolls, [2]);
  gesture.touch('touchmove', [{ clientX: 20, clientY: 110 }]);
  gesture.cancel();
  assert.equal(gesture.frames.size, 0);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.deepEqual(gesture.mouseEvents, []);
});
