import test from 'node:test';
import assert from 'node:assert/strict';
import { qoderTaskPanel, stopQoderTasks } from '../src/qoder-stop.js';

const panel = (count, selected = '❯ test running PID 123', hint = 'k kill') => `Background tasks\n${count} running\nCommands (2)\n${selected}\n↑↓ navigate · Enter output · ${hint} · Esc close`;
test('Qoder task stopping uses only the live panel and verifies every changed selection', async () => {
  const frames = [panel(2), panel(1, '❯ test exited (0) PID 123', 'k clear'), panel(1, '❯ other running PID 456'), panel(0)];
  const keys = [];
  await stopQoderTasks({ read: async () => frames[0], key: async key => { keys.push(key); frames.shift(); }, wait: async () => {} });
  assert.deepEqual(keys, ['k', 'Down', 'k', 'Escape']);
});
test('Qoder task stopping rejects unknown menus, never repeats an unconfirmed kill', async () => {
  assert.equal(qoderTaskPanel('quoted Background tasks\n> /tasks'), null);
  assert.equal(qoderTaskPanel(panel(1) + '\n> user draft'), null);
  assert.equal(qoderTaskPanel(panel(1) + '\n > '), null);
  assert.equal(qoderTaskPanel(panel(1) + '\n * '), null);
  const keys = [];
  await assert.rejects(stopQoderTasks({ read: async () => panel(1), key: async key => keys.push(key), wait: async () => {} }), /未确认/);
  assert.deepEqual(keys, ['k']);
});

test('an empty native task panel closes without sending cancellation or history-clear keys', async () => {
  const screen = '────────\nNo background tasks.\n────────\nEsc close';
  const keys = [];
  await stopQoderTasks({ read: async () => screen, key: async key => keys.push(key), wait: async () => {} });
  assert.deepEqual(keys, ['Escape']);
});
