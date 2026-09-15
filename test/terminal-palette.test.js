import test from 'node:test';
import assert from 'node:assert/strict';
import { bindTerminalPalette } from '../public/terminal-palette.js';

test('initial and live theme changes update only palette and contrast, preserving terminal state', () => {
  const root = { dataset: { terminalTheme: 'mac' } };
  const terminal = { options: {}, buffer: { history: ['existing output'] }, cols: 80, rows: 24 };
  let callback;
  class Observer { constructor(fn) { callback = fn; } observe(target, config) { assert.equal(target, root); assert.deepEqual(config.attributeFilter, ['data-terminal-theme']); } }
  bindTerminalPalette(terminal, root, Observer);
  assert.equal(terminal.options.theme.background, '#ffffff');
  assert.equal(terminal.options.minimumContrastRatio, 4.5);
  root.dataset.terminalTheme = 'classic'; callback();
  assert.equal(terminal.options.theme.background, '#2e3436');
  assert.equal(terminal.options.theme.green, '#4e9a06');
  assert.equal(terminal.options.minimumContrastRatio, 1);
  assert.deepEqual(terminal.buffer.history, ['existing output']);
  assert.equal(terminal.cols, 80);
  root.dataset.terminalTheme = 'mac'; callback();
  assert.equal(terminal.options.theme.foreground, '#24292f');
});
