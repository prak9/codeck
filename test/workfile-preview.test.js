import test from 'node:test';
import assert from 'node:assert/strict';
import { workfileFormat, readPreviewText } from '../public/workfile-preview.js';

test('preview types keep HTML inert and unsupported binaries downloadable', () => {
  assert.equal(workfileFormat('report.MD'), 'markdown');
  assert.equal(workfileFormat('chart.png'), 'image');
  assert.equal(workfileFormat('filing.pdf'), 'pdf');
  assert.equal(workfileFormat('untrusted.html'), 'text');
  assert.equal(workfileFormat('model.bin'), 'download');
});

test('text preview is bounded, cancels excess bytes, and never emits a partial UTF-8 character', async () => {
  let cancelled = false;
  const content = new TextEncoder().encode('报告\nnext');
  const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(content); }, cancel() { cancelled = true; } }));
  const result = await readPreviewText(response, 4);
  assert.deepEqual(result, { text: '报', truncated: true }); assert.equal(cancelled, true);
  assert.deepEqual(await readPreviewText(new Response('完整报告')), { text: '完整报告', truncated: false });
});
