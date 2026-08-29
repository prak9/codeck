import test from 'node:test';
import assert from 'node:assert/strict';
import { hideSharedCodexBackgroundFooter } from '../public/terminal-output.js';

test('hides a shared Codex background footer without moving terminal columns', () => {
  const footer = '• Working (2m 4s) · 2 background terminals running · /ps to view · /stop to close\x1b[0m';
  const filtered = hideSharedCodexBackgroundFooter(footer);

  assert.equal(filtered.length, footer.length);
  assert.equal(filtered.includes('background terminals'), false);
  assert.equal(filtered.startsWith('• Working (2m 4s)'), true);
  assert.equal(filtered.endsWith('\x1b[0m'), true);
});

test('leaves unrelated terminal output and non-string websocket data unchanged', () => {
  assert.equal(hideSharedCodexBackgroundFooter('1 background task in the transcript'), '1 background task in the transcript');
  const binary = new Uint8Array([1, 2, 3]);
  assert.equal(hideSharedCodexBackgroundFooter(binary), binary);
});
