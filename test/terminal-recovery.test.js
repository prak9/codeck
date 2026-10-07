import test from 'node:test';
import assert from 'node:assert/strict';
import { bindTerminalRecovery } from '../public/terminal-recovery.js';

function fixture() {
  const socket = new EventTarget(), page = new EventTarget(), window = new EventTarget();
  page.hidden = false;
  const timers = new Map(); let next = 0, calls = 0;
  const recovery = bindTerminalRecovery(socket, () => calls++, {
    page, window, schedule: fn => { timers.set(++next, fn); return next; },
    cancel: id => timers.delete(id),
  });
  return { page, window, timers, recovery, calls: () => calls,
    close(code, reason = '') { const event = new Event('close'); Object.assign(event, { code, reason }); socket.dispatchEvent(event); },
    tick() { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } },
  };
}

test('background output drain failure recovers once on return, without waiting for socket traffic', () => {
  const f = fixture();
  f.page.hidden = true;
  f.close(1011, '终端显示同步超时，排队输入已取消；请重新连接');
  assert.equal(f.timers.size, 0);
  f.page.hidden = false;
  f.page.dispatchEvent(new Event('visibilitychange'));
  f.window.dispatchEvent(new Event('pageshow'));
  assert.equal(f.timers.size, 1);
  f.tick();
  assert.equal(f.calls(), 1);
  f.recovery.stop();
});

test('normal detach, policy errors and unrelated backend failures never reconnect', () => {
  for (const code of [1000, 1008, 1011]) {
    const f = fixture(); f.close(code, 'terminal exited');
    f.page.dispatchEvent(new Event('visibilitychange')); f.tick();
    assert.equal(f.calls(), 0); f.recovery.stop();
  }
});

test('dead socket detection does not depend on the close handshake; stale retries are cancelled', () => {
  const f = fixture();
  f.recovery.recover(); f.close(4000); f.window.dispatchEvent(new Event('online'));
  assert.equal(f.timers.size, 1);
  const stale = [...f.timers.values()][0];
  f.recovery.stop(); stale();
  assert.equal(f.calls(), 0);
});

test('network loss reconnects while visible but waits if hidden before retry fires', () => {
  const f = fixture(); f.close(1006);
  f.page.hidden = true; f.tick(); assert.equal(f.calls(), 0);
  f.page.hidden = false; f.window.dispatchEvent(new Event('online')); f.tick();
  assert.equal(f.calls(), 1); f.recovery.stop();
});
