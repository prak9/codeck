import test from 'node:test';
import assert from 'node:assert/strict';
import { bindTerminalHeartbeat } from '../public/terminal-heartbeat.js';

function fixture() {
  const socket = new EventTarget();
  socket.readyState = 1;
  const sent = [], timers = new Map();
  let next = 0, failures = 0;
  socket.send = raw => sent.push(JSON.parse(raw));
  const page = new EventTarget();
  page.hidden = false;
  const window = new EventTarget();
  const stop = bindTerminalHeartbeat(socket, () => failures++, {
    page, window, schedule: fn => { timers.set(++next, fn); return next; },
    cancel: id => timers.delete(id),
  });
  const tick = () => { const [id, fn] = timers.entries().next().value; timers.delete(id); fn(); };
  const pong = id => { const event = new Event('message'); event.data = new TextEncoder().encode(JSON.stringify({ type: 'pong', id })).buffer; socket.dispatchEvent(event); };
  return { socket, sent, page, window, stop, tick, pong, timers, failures: () => failures };
}

test('an apparently OPEN but silent socket times out without terminal input or replay', () => {
  const f = fixture();
  f.tick();
  assert.deepEqual(f.sent, [{ type: 'ping', id: 1 }]);
  f.tick();
  assert.equal(f.failures(), 1);
  assert.equal(f.timers.size, 0);
});

test('matching binary pong keeps an idle terminal alive; stale pong cannot confirm a new probe', () => {
  const f = fixture();
  f.tick(); f.pong(1); f.tick(); f.pong(1); f.tick();
  assert.equal(f.failures(), 1);
});

test('background suspension gives a fresh probe on return, never an immediate stale timeout', () => {
  const f = fixture();
  f.tick();
  f.page.hidden = true; f.page.dispatchEvent(new Event('visibilitychange'));
  assert.equal(f.timers.size, 0);
  f.page.hidden = false; f.page.dispatchEvent(new Event('visibilitychange'));
  assert.equal(f.failures(), 0);
  assert.equal(f.sent.at(-1).id, 2);
  f.pong(2); f.stop();
  assert.equal(f.timers.size, 0);
});

test('close and disposal stop probes, including later focus/online events', () => {
  for (const close of [true, false]) {
    const f = fixture();
    if (close) f.socket.dispatchEvent(new Event('close')); else f.stop();
    f.window.dispatchEvent(new Event('focus'));
    f.window.dispatchEvent(new Event('online'));
    assert.equal(f.sent.length, 0);
    assert.equal(f.timers.size, 0);
  }
});
