import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/terminal-theme.js', import.meta.url), 'utf8');
function fixture(saved, blocked = false) {
  const listeners = {};
  const select = { value: '', addEventListener: (type, fn) => { listeners[type] = fn; } };
  const root = { dataset: {} };
  const writes = [];
  vm.runInNewContext(source, {
    document: { documentElement: root, getElementById: () => select, addEventListener: (type, fn) => { listeners[type] = fn; } },
    localStorage: { getItem() { if (blocked) throw Error('blocked'); return saved; }, setItem(...args) { if (blocked) throw Error('blocked'); writes.push(args); } },
  });
  return { root, select, listeners, writes };
}
test('theme defaults to classic and only recognizes the explicit mac option', () => {
  for (const value of [null, 'dark', '<script>']) assert.equal(fixture(value).root.dataset.terminalTheme, 'classic');
  assert.equal(fixture('mac').root.dataset.terminalTheme, 'mac');
});
test('settings restore, apply and persist theme without touching terminal state', () => {
  const f = fixture('mac');
  f.listeners.DOMContentLoaded();
  assert.equal(f.select.value, 'mac');
  f.select.value = 'classic'; f.listeners.change();
  assert.equal(f.root.dataset.terminalTheme, 'classic');
  assert.deepEqual(f.writes, [['codeck-terminal-theme', 'classic']]);
});
test('blocked storage still permits changing appearance for this page', () => {
  const f = fixture(null, true); f.listeners.DOMContentLoaded();
  f.select.value = 'mac'; f.listeners.change();
  assert.equal(f.root.dataset.terminalTheme, 'mac');
});
