import test from 'node:test';
import assert from 'node:assert/strict';
import { agentOutputText, latestAgentOutputText, writeAgentOutputToClipboard } from '../public/remote-copy.js';

test('collects only the visible model text from one turn', () => {
  assert.equal(agentOutputText({ items: [
    { type: 'userMessage', text: 'Question' },
    { type: 'agentMessage', text: 'First line\ncontinued' },
    { type: 'reasoning', text: 'Private reasoning' },
    { type: 'agentMessage', text: 'Final answer' },
  ] }), 'First line\ncontinued\n\nFinal answer');
  assert.equal(agentOutputText({ items: [] }), '');
});

test('finds the latest visible model reply even while the turn is running', () => {
  assert.equal(latestAgentOutputText([
    { status: 'completed', items: [{ type: 'agentMessage', text: 'Earlier answer' }] },
    { status: 'completed', items: [{ type: 'reasoning', text: 'No visible answer' }] },
    { status: 'completed', items: [{ type: 'agentMessage', text: 'Latest complete answer' }] },
    { status: 'inProgress', items: [{ type: 'agentMessage', text: 'Still streaming' }] },
  ]), 'Still streaming');

  assert.equal(latestAgentOutputText([
    { status: 'running', items: [{ type: 'agentMessage', text: 'Partial' }] },
  ]), 'Partial');
  assert.equal(latestAgentOutputText([{status: 'completed', items: [{type:'agentMessage', text:'Visible'}]},
    { status: 'running', items: [{type: 'reasoning', text:'hidden'}] }]), 'Visible');
  assert.equal(latestAgentOutputText([]), '');
});

test('copies model output without changing whitespace', async () => {
  const writes = [];
  await writeAgentOutputToClipboard('第一行\n\n  indented', {
    writeText: async (text) => writes.push(text),
  });
  assert.deepEqual(writes, ['第一行\n\n  indented']);
});

test('copying a final autonomy result excludes its machine protocol', async () => {
  const text = '已完成验证。下一步：扩大回归。\n```codeck-autonomy\n{"nonce":"n","status":"complete"}\n```';
  assert.equal(agentOutputText({ items: [{ type: 'agentMessage', text }] }), '已完成验证。下一步：扩大回归。');
  const writes = [];
  await writeAgentOutputToClipboard(text, { writeText: async value => writes.push(value) });
  assert.deepEqual(writes, ['已完成验证。下一步：扩大回归。']);
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

test('a latest-reply read can finish after the clipboard gesture, while a failed read never copies a fallback', async () => {
  let finish, item;
  class Item { constructor(types) { this.data = types['text/plain']; } }
  const clipboard = { async write(items) { [item] = items; await item.data; } };
  const copied = writeAgentOutputToClipboard(() => new Promise(resolve => { finish = resolve; }), clipboard, Item);
  assert.ok(item instanceof Item, 'the write starts synchronously on the click');
  finish('最新回复');
  await copied;
  assert.equal(await (await item.data).text(), '最新回复');
  await assert.rejects(writeAgentOutputToClipboard(async () => { throw new Error('读取失败'); }, clipboard, Item), /读取失败/);
});
