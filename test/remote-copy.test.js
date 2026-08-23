import test from 'node:test';
import assert from 'node:assert/strict';
import { agentOutputText, writeAgentOutputToClipboard } from '../public/remote-copy.js';

test('collects only the visible model text from one turn', () => {
  assert.equal(agentOutputText({ items: [
    { type: 'userMessage', text: 'Question' },
    { type: 'agentMessage', text: 'First line\ncontinued' },
    { type: 'reasoning', text: 'Private reasoning' },
    { type: 'agentMessage', text: 'Final answer' },
  ] }), 'First line\ncontinued\n\nFinal answer');
  assert.equal(agentOutputText({ items: [] }), '');
});

test('copies model output without changing whitespace', async () => {
  const writes = [];
  await writeAgentOutputToClipboard('第一行\n\n  indented', {
    writeText: async (text) => writes.push(text),
  });
  assert.deepEqual(writes, ['第一行\n\n  indented']);
});

test('reports unsupported and denied clipboard writes clearly', async () => {
  await assert.rejects(
    writeAgentOutputToClipboard('answer', null),
    /当前浏览器不支持剪贴板写入/,
  );
  await assert.rejects(
    writeAgentOutputToClipboard('answer', { writeText: async () => { throw new Error('denied'); } }),
    /复制失败：浏览器拒绝了剪贴板访问/,
  );
});
