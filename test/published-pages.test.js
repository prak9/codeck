import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import { createPageStore, mountPublishedPages } from '../src/published-pages.js';
import { authenticateToken, createShareToken } from '../src/auth.js';

async function fixture(t, extra = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codeck-pages-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const app = express(); app.use(express.json({ limit: '20mb' }));
  const store = createPageStore(dir);
  mountPublishedPages(app, { store, ...extra,
    apiAuth(req, res, next) { req.auth = authenticateToken('owner-secret', req.headers.authorization?.slice(7)); if (!req.auth) return res.sendStatus(401); next(); },
    pageAuth(req, res, next) { if (req.headers.cookie === 'fixture-login=yes') return next(); return res.redirect('/login.html'); },
  });
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (url, method = 'GET', body, token = 'owner-secret') => fetch(base + url, { method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { dir, base, call, store };
}
test('owner publishes, lists, updates and deletes durable pages; session shares cannot publish or read', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('/api/pages', 'POST', { title: '报告', html: '<h1>hello</h1>' }, 'invalid')).status, 401);
  const share = createShareToken('owner-secret', 'research');
  assert.equal((await f.call('/api/pages', 'GET', null, share)).status, 403);
  const response = await f.call('/api/pages/demo', 'PUT', { title: '报告', html: '<h1>hello</h1>' });
  assert.equal(response.status, 200); assert.equal((await response.json()).url, '/pages/demo');
  assert.equal((await (await f.call('/api/pages')).json()).pages.length, 1);
  assert.equal((await createPageStore(f.dir).get('demo')).html, '<h1>hello</h1>');
  await f.call('/api/pages/demo', 'PUT', { title: '更新', html: '<p>updated</p>' });
  assert.equal((await (await f.call('/api/pages/demo')).json()).title, '更新');
  assert.equal((await f.call('/api/pages/demo', 'DELETE')).status, 204);
  assert.equal((await f.call('/api/pages/demo')).status, 404);
});
test('published content requires login and carries sandbox CSP; wrapper title cannot inject HTML', async t => {
  const f = await fixture(t);
  await f.call('/api/pages/demo', 'PUT', { title: '</title><script>bad()</script>', html: '<script>window.example=1</script>' });
  const unauth = await fetch(f.base + '/pages/demo', { redirect: 'manual' }); assert.equal(unauth.status, 302);
  const page = await fetch(f.base + '/pages/demo', { headers: { Cookie: 'fixture-login=yes' } });
  const html = await page.text(); assert.ok(!html.includes('<script>bad()')); assert.match(html, /sandbox="allow-scripts"/);
  const content = await fetch(f.base + '/pages/demo/content', { headers: { Cookie: 'fixture-login=yes' } });
  assert.match(content.headers.get('content-security-policy'), /sandbox allow-scripts/);
  assert.match(content.headers.get('content-security-policy'), /connect-src 'none'/);
  assert.equal(content.headers.get('cache-control'), 'no-store');
  assert.match(await content.text(), /window.example=1/);
});
test('page IDs cannot escape storage and larger HTML is accepted without the ordinary 16KB API limit', async t => {
  const f = await fixture(t);
  await assert.rejects(f.store.put('../escape', { title: 'bad', html: 'bad' }), /标识/);
  await assert.rejects(f.store.put('valid', { title: 'missing' }), /HTML/);
  const large = '<p>' + '内容'.repeat(12000) + '</p>';
  assert.equal((await f.call('/api/pages/large', 'PUT', { title: '长文', html: large })).status, 200);
  assert.equal((await f.store.get('large')).html, large);
});

test('page share is scoped, durable, revocable and survives content updates without granting API access', async t => {
  const f = await fixture(t);
  await f.store.put('demo', { title: '报告', html: '<h1>shared</h1>' });
  await f.store.put('other', { title: 'private', html: 'private' });
  const response = await f.call('/api/pages/demo/share', 'POST');
  assert.equal(response.status, 201);
  const { url } = await response.json();
  const token = new URL(url, f.base).searchParams.get('share');
  assert.ok(token?.length >= 40);
  const wrapper = await fetch(f.base + url);
  assert.equal(wrapper.status, 200);
  assert.equal(wrapper.headers.get('referrer-policy'), 'no-referrer');
  assert.match(await wrapper.text(), new RegExp(`/pages/demo/content\\?share=${token}`));
  const contentUrl = `/pages/demo/content?share=${token}`;
  assert.equal(await (await fetch(f.base + contentUrl)).text(), '<h1>shared</h1>');
  assert.equal((await fetch(f.base + `/pages/other?share=${token}`)).status, 404);
  assert.equal((await f.call('/api/pages', 'GET', null, token)).status, 401);
  assert.equal((await f.call('/api/pages/demo/share', 'DELETE', null, token)).status, 401);
  await f.store.put('demo', { title: '更新', html: 'updated' });
  assert.equal(await (await fetch(f.base + contentUrl)).text(), 'updated');
  assert.equal((await createPageStore(f.dir).readSharedPage('demo', token)).html, 'updated');
  const rotated = await (await f.call('/api/pages/demo/share', 'POST')).json();
  assert.equal((await fetch(f.base + url)).status, 404);
  assert.equal((await fetch(f.base + rotated.url)).status, 200);
  assert.equal((await f.call('/api/pages/demo/share', 'DELETE')).status, 204);
  assert.equal((await fetch(f.base + rotated.url)).status, 404);
  const last = await (await f.call('/api/pages/demo/share', 'POST')).json();
  await f.store.remove('demo');
  await f.store.put('demo', { title: '新页面', html: 'new' });
  assert.equal((await fetch(f.base + last.url)).status, 404);
});

test('concurrent content update cannot restore revoked sharing', async t => {
  const f = await fixture(t);
  await f.store.put('demo', { title: 'before', html: 'before' });
  const { url } = await f.store.createShare('demo');
  await Promise.all([
    f.store.put('demo', { title: 'after', html: 'after' }),
    f.store.revokeShare('demo'),
  ]);
  assert.equal((await f.store.get('demo')).html, 'after');
  assert.equal((await fetch(f.base + url)).status, 404);
});

test('owner page has share controls; cookie mutation requires explicit header and rejects share visitors', async t => {
  const f = await fixture(t);
  await f.store.put('demo', { title: '报告', html: 'hello' });
  const ownerPage = await fetch(f.base + '/pages/demo', { headers: { Cookie: 'fixture-login=yes' } });
  assert.match(await ownerPage.text(), /id="share-page"/);
  const request = (headers, method = 'POST', suffix = '') => fetch(f.base + '/pages/demo/share' + suffix, { method, headers, redirect: 'manual' });
  assert.equal((await request({ Cookie: 'fixture-login=yes' })).status, 403);
  const headers = { Cookie: 'fixture-login=yes', 'X-Codeck-Page-Action': 'share' };
  const response = await request(headers);
  assert.equal(response.status, 201);
  const { url } = await response.json();
  assert.doesNotMatch(await (await fetch(f.base + url)).text(), /id="share-page"/);
  assert.equal((await request({ 'X-Codeck-Page-Action': 'share' }, 'DELETE')).status, 302);
  assert.equal((await request(headers, 'DELETE', '?' + url.split('?')[1])).status, 404);
  assert.equal((await request(headers, 'DELETE')).status, 204);
  assert.equal((await fetch(f.base + url)).status, 404);
});

test('publishing the same source concurrently or after restart updates one page and retains sharing', async t => {
  const f = await fixture(t);
  const source = { key: '/project:reports/research.html', session: 'research', revision: 'abc123' };
  const publish = html => f.call('/api/pages/publish', 'POST', { title: '研究', html, source });
  const responses = await Promise.all([publish('first'), publish('second')]);
  assert.deepEqual(responses.map(r => r.status), [200, 200]);
  const [a, b] = await Promise.all(responses.map(r => r.json()));
  assert.equal(a.id, b.id);
  assert.equal((await f.store.list()).length, 1);
  const shared = await f.store.createShare(a.id);
  const restarted = createPageStore(f.dir);
  const updated = await restarted.publish({ title: '更新', html: 'third', source: { ...source, revision: 'def456' } });
  assert.equal(updated.id, a.id);
  assert.equal(updated.source.revision, 'def456');
  assert.equal(updated.contentHash.length, 64);
  assert.equal((await fetch(f.base + shared.url)).status, 200);
  await assert.rejects(restarted.put(a.id, { title: 'bad', html: 'bad', source: { key: 'different' } }), /来源/);
});

test('paragraph feedback is versioned, durable, batched once; unknown delivery is never replayed', async t => {
  const f = await fixture(t);
  const page = await f.store.publish({ title: '报告', html: '<p>原结论</p>', source: { key: 'report', session: 'research' } });
  const target = { tmuxSession: 'research', provider: 'codex', threadId: 'thread1' };
  const comment = await f.store.addComment(page.id, { contentHash: page.contentHash, quote: '原结论', text: '请补证据', paragraph: 0 }, target);
  await f.store.publish({ title: '报告', html: '<p>新结论</p>', source: { key: 'report', session: 'research' } });
  assert.equal((await f.store.get(page.id)).comments[0].contentHash, page.contentHash);
  let calls=0;
  const send=async (_target, text) => { calls++; assert.match(text,/原结论/); throw new Error('lost ack'); };
  await Promise.all([f.store.sendComments(page.id,[comment.id],send), f.store.sendComments(page.id,[comment.id],send)]);
  assert.equal(calls,1);
  const restarted=createPageStore(f.dir);
  await restarted.sendComments(page.id,[comment.id],send); assert.equal(calls,1);
  assert.equal((await restarted.get(page.id)).comments[0].delivery.status,'unknown');
});


test('feedback HTTP requires owner action, refuses stale versions and cannot target a replacement source session', async t => {
  let target = { provider: 'codex', threadId: 'old', tmuxSession: 'research' }, sends = 0;
  const f = await fixture(t, { resolveTarget: async () => target, sendFeedback: async () => { sends++; } });
  const page = await (await f.call('/api/pages/publish', 'POST', { title: 'report', html: '<p>hello</p>', source: { key: 'source', session: 'research' } })).json();
  const body = { contentHash: page.contentHash, quote: 'hello', text: 'verify' };
  const url = `/pages/${page.id}/comments`;
  assert.equal((await fetch(f.base + url, { method: 'POST', headers: { Cookie: 'fixture-login=yes', 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).status, 403);
  const headers = { Cookie: 'fixture-login=yes', 'Content-Type': 'application/json', 'X-Codeck-Page-Action': 'feedback' };
  const comment = await (await fetch(f.base + url, { method: 'POST', headers, body: JSON.stringify(body) })).json();
  assert.ok(comment.id);
  assert.equal((await f.call(`/api/pages/${page.id}/comments`, 'POST', { ...body, contentHash: 'stale' })).status, 409);
  const share = await f.store.createShare(page.id);
  assert.equal((await fetch(f.base + url + '?' + share.url.split('?')[1])).status, 404);
  target = { ...target, threadId: 'new' };
  assert.equal((await f.call(`/api/pages/${page.id}/comments`, 'POST', body)).status, 409);
  assert.equal(sends, 0);
});
