import test from 'node:test';
import assert from 'node:assert/strict';
import { bindTranscriptClick } from '../public/terminal-transcript-click.js';

test('fullscreen fallback forwards clicks, never drag selection, links, modified or native mouse clicks', () => {
  const handlers = {}, sent = [];
  const terminal = { cols: 80, rows: 24, hasSelection: () => false, modes: { mouseTrackingMode: 'none' } };
  bindTranscriptClick({ addEventListener: (name, fn) => { handlers[name] = fn; },
    querySelector: () => ({ getBoundingClientRect: () => ({ left: 20, top: 30, width: 800, height: 480 }) }) }, terminal, value => sent.push(value));
  const click = { button: 0, clientX: 45, clientY: 60, target: { closest: () => null } };
  handlers.pointerdown(click); handlers.click(click);
  assert.deepEqual(sent, [{ column: 3, row: 2 }]);
  handlers.pointerdown(click); handlers.click({ ...click, clientX: 200 });
  handlers.pointerdown(click); handlers.click({ ...click, shiftKey: true });
  handlers.pointerdown(click); handlers.click({ ...click, target: { closest: () => ({}) } });
  terminal.hasSelection = () => true;
  handlers.pointerdown(click); handlers.click(click);
  terminal.hasSelection = () => false;
  terminal.modes.mouseTrackingMode = 'any';
  handlers.pointerdown(click); handlers.click(click);
  assert.equal(sent.length, 1);
});
