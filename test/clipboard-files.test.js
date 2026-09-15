import test from 'node:test';
import assert from 'node:assert/strict';
import { clipboardFiles, readClipboardPayload } from '../public/clipboard-files.js';

test('Windows screenshot files are read from items or files fallback, without duplicates', () => {
  const png = { type: 'image/png', name: 'image.png' };
  assert.deepEqual(clipboardFiles({ items: [{ kind: 'file', getAsFile: () => png }], files: [png] }), [png]);
  assert.deepEqual(clipboardFiles({ items: [{ kind: 'file', getAsFile: () => null }], files: [png] }), [png]);
  assert.deepEqual(clipboardFiles({ files: [png] }), [png]);
  assert.deepEqual(clipboardFiles({ items: [{ kind: 'string' }] }), []);
});
test('paste button prefers screenshot over alternative text and reads one image representation', async () => {
  const blob = new Blob(['png'], { type: 'image/png' });
  const payload = await readClipboardPayload({ read: async () => [{ types: ['text/html', 'image/png', 'image/jpeg'], getType: async type => { assert.equal(type, 'image/png'); return blob; } }] });
  assert.deepEqual(payload.images, [blob]);
  assert.equal(payload.text, '');
});
test('paste button preserves plain text and falls back when read API is unavailable', async () => {
  assert.equal((await readClipboardPayload({ readText: async () => 'hello' })).text, 'hello');
  assert.equal((await readClipboardPayload({ read: async () => [{ types: ['text/plain'], getType: async () => new Blob(['hello']) }] })).text, 'hello');
  await assert.rejects(readClipboardPayload({ read: async () => { throw Error('denied'); } }), /denied/);
});
