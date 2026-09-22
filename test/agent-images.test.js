import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { createAgentImages, imageReferences } from '../src/agent-images.js';
import { safeImageSource } from '../public/remote-images.js';
import { CodexAgentBackend } from '../src/agent-backends.js';
import { EventEmitter } from 'node:events';
import { AgentRegistry } from '../src/agent-connection.js';

test('image references cover Markdown, image-view events and local attachments without executing HTML', () => {
  const text = '曲线\n![误差曲线](/data/results/chart.png)\n[下载高清图](/data/results/chart.png)';
  assert.deepEqual(imageReferences({ type: 'agentMessage', text }).map(r => [r.path, r.alt]), [['/data/results/chart.png', '误差曲线']]);
  assert.equal(imageReferences({ type: 'imageView', path: '/data/plot.png' })[0].path, '/data/plot.png');
  assert.equal(imageReferences({ type: 'userMessage', content: [{ type: 'localImage', path: '/tmp/a.jpg' }] })[0].path, '/tmp/a.jpg');
  assert.equal(imageReferences({ type: 'agentMessage', text: '![x](javascript:alert(1)) ![x](/tmp/a.svg) <img src="/etc/passwd">' }).length, 0);
  assert.equal(imageReferences({ type: 'agentMessage', text: '```\n![example](/tmp/a.png)\n```' }).length, 0);
  assert.equal(imageReferences({ type: 'agentMessage', text: '```\n![streaming example](/tmp/a.png)' }).length, 0);
  assert.equal(imageReferences({ type: 'agentMessage', text: '['.repeat(100_000) }).length, 0);
});

test('registry carries image descriptors through initial reads, history and live item events', async () => {
  const backend = new EventEmitter();
  const item = { id: 'view', type: 'imageView', path: '/tmp/chart.png' };
  backend.openThread = async () => ({ thread: { id: 'thread', turns: [{ id: 'turn', items: [item] }] } });
  backend.loadThreadHistory = async () => ({ turns: [{ id: 'older', items: [item] }], truncated: false });
  const images = createAgentImages('secret');
  const registry = new AgentRegistry({ codex: backend }, { decorateTranscript: images.decorate });
  const opened = await registry.openThread('codex', 'thread', { readOnly: true });
  const history = await registry.loadThreadHistory('codex', 'thread', { beforeTurnId: 'turn', limit: 20 });
  let event;
  registry.on('notification', value => { event = value; });
  backend.emit('notification', { method: 'item/completed', params: { threadId: 'thread', item } });
  const expected = opened.thread.turns[0].items[0].codeckImages;
  assert.deepEqual(history.turns[0].items[0].codeckImages, expected);
  assert.deepEqual(event.params.item.codeckImages, expected);
  assert.equal(item.codeckImages, undefined);
});

test('decorating snapshots, history and events does not mutate source items and produces stable URLs', () => {
  const images = createAgentImages('test-secret');
  const item = { id: 'one', type: 'agentMessage', text: '![曲线](/tmp/a.png)' };
  const result = { thread: { turns: [{ id: 'turn', items: [item] }] } };
  const decorated = images.decorate(result);
  const refs = decorated.thread.turns[0].items[0].codeckImages;
  assert.equal(item.codeckImages, undefined);
  assert.match(refs[0].url, /^\/api\/agent-images\//);
  assert.deepEqual(images.decorate({ params: { item } }).params.item.codeckImages, refs);
  assert.deepEqual(images.decorate({ turns: result.thread.turns }).turns[0].items[0].codeckImages, refs);
});

test('browser only authenticates signed local image routes', () => {
  const origin = 'https://codeck.test';
  assert.equal(safeImageSource('/api/agent-images/path.signature', origin).local, true);
  assert.equal(safeImageSource('https://example.com/chart.png?a=1#detail', origin).local, false);
  for (const value of ['javascript:alert(1)', '/api/download?path=anything', 'https://codeck.test/api/sessions', 'https://user:pass@example.com/a.png', '//example.com/a.png', 'https://example.com/a.svg']) {
    assert.equal(safeImageSource(value, origin), null);
  }
});

test('Codex image-only history reads a single turn, follows item pages and does not open or resume a thread', async () => {
  const server = new EventEmitter();
  const requests = [];
  const controller = new AbortController();
  server.request = async (method, params, options) => {
    requests.push({ method, params });
    assert.equal(options.signal, controller.signal);
    return params.cursor ? { data: [{ turnId: 'turn', item: { type: 'imageView', path: '/tmp/plot.png' } }], nextCursor: null }
      : { data: [
        { turnId: 'other', item: { type: 'imageView', path: '/tmp/wrong.png' } },
        { turnId: 'turn', item: { type: 'commandExecution', aggregatedOutput: 'huge tool output' } },
      ], nextCursor: 'next' };
  };
  const backend = new CodexAgentBackend(server);
  assert.deepEqual(await backend.readTurnImages('thread', 'turn', { signal: controller.signal }), [{ path: '/tmp/plot.png', alt: 'plot.png' }]);
  assert.deepEqual(requests.map(r => r.method), ['thread/items/list', 'thread/items/list']);
  assert.ok(requests.every(r => r.params.turnId === 'turn' && r.params.threadId === 'thread'));
});

test('image route requires a valid capability and validates file type, size and symlinks', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codeck-images-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4h8AAAAASUVORK5CYII=', 'base64');
  await fs.writeFile(path.join(dir, 'image.png'), png);
  await fs.writeFile(path.join(dir, 'fake.png'), '<html>not an image</html>');
  await fs.symlink(path.join(dir, 'image.png'), path.join(dir, 'link.png'));
  await fs.writeFile(path.join(dir, 'large.png'), Buffer.alloc(1025));
  const images = createAgentImages('test-secret', { maxBytes: 1024 });
  const app = express();
  app.get('/api/agent-images/:token', images.serve);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const url = name => images.decorate({ type: 'imageView', path: path.join(dir, name) }).codeckImages[0].url;
  const response = await fetch(origin + url('image.png'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
  for (const name of ['fake.png', 'link.png', 'large.png', 'missing.png']) assert.notEqual((await fetch(origin + url(name))).status, 200, name);
  assert.equal((await fetch(origin + url('image.png') + 'tampered')).status, 403);
});
