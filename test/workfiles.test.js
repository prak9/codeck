import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { createWorkfiles, mountWorkfiles, workfileIdentity, workfileDownloadAuthorized, isWorkfileDownloadRequest } from '../src/workfiles.js';
import { runCodeck } from '../src/codeck-client.js';
import { uploadWorkContext } from '../public/workfiles.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codeck-workfiles-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project'); await fs.mkdir(project);
  const session = { name: 'research', createdAt: 123, cwd: project, agent: { kind: 'codex', id: 'thread-1' } };
  return { root, project, session, store: createWorkfiles(path.join(root, 'data'), { uploadRoot: path.join(root, 'uploads') }) };
}

test('workfiles persist, isolate recreated sessions and retain immutable versions', async t => {
  const f = await fixture(t), file = path.join(f.project, 'report.md');
  await fs.writeFile(file, 'version one');
  const record = await f.store.put(f.session, { key: 'report', kind: 'result', title: '研究报告', path: file, group: 'APP' });
  await fs.writeFile(file, 'version two');
  const updated = await f.store.put(f.session, { key: 'report', kind: 'result', title: '研究报告', path: file, group: 'APP' });
  assert.equal(updated.versions.length, 2);
  assert.equal(await fs.readFile(await f.store.file(f.session, record.id, record.versions[0].id), 'utf8'), 'version one');
  const restarted = createWorkfiles(path.join(f.root, 'data'));
  assert.equal((await restarted.list(f.session)).length, 1);
  assert.deepEqual(await restarted.list({ ...f.session, createdAt: 456 }), []);
  assert.deepEqual(await restarted.list({ ...f.session, agent: { kind: 'codex', id: 'thread-2' } }), []);
});

test('duplicate registration is idempotent; invalid links and escaped files are rejected', async t => {
  const f = await fixture(t);
  const value = { key: 'filing', kind: 'source', title: '财报', url: 'https://example.com/report', date: '2026-11-15' };
  await Promise.all([f.store.put(f.session, value), f.store.put(f.session, value)]);
  assert.equal((await f.store.list(f.session))[0].versions.length, 1);
  for (const url of ['javascript:alert(1)', '//example.com', 'https://user:secret@example.com', '/api/sessions']) {
    await assert.rejects(f.store.put(f.session, { ...value, url }));
  }
  const outside = path.join(f.root, 'private'); await fs.writeFile(outside, 'secret');
  await fs.symlink(outside, path.join(f.project, 'escape'));
  await assert.rejects(f.store.put(f.session, { key: 'bad', kind: 'source', title: 'bad', path: outside }));
  await assert.rejects(f.store.put(f.session, { key: 'bad', kind: 'source', title: 'bad', path: path.join(f.project, 'escape') }));
  assert.notEqual(workfileIdentity(f.session), workfileIdentity({ ...f.session, createdAt: 999 }));
});

test('file verification is version-bound and source changes are not mistaken for snapshot updates', async t => {
  const f = await fixture(t), file = path.join(f.project, 'report.md');
  await fs.writeFile(file, '# Report');
  const evidence = { version: 'v1', summary: '核对数据', checks: [{ method: '财报对照', result: 'passed', reference: 'filing' }], limitations: ['估值未核验'] };
  const record = await f.store.put(f.session, { key: 'report', kind: 'result', title: '报告', path: file, revision: 'v1', evidence });
  assert.equal(record.versions[0].evidence.contentHash, record.versions[0].contentHash);
  assert.equal(await f.store.sourceState(record.versions[0]), 'unchanged');
  assert.equal((await f.store.put(f.session, { key: 'report', kind: 'result', title: '报告', path: file, revision: 'v1', evidence })).versions.length, 1);
  await fs.writeFile(file, '# A different report');
  assert.equal(await f.store.sourceState(record.versions[0]), 'changed');
  const next = await f.store.put(f.session, { key: 'report', kind: 'result', title: '报告', path: file, revision: 'v2' });
  assert.equal(next.versions[1].evidence, undefined, 'new contents do not inherit old verification');
  assert.equal(await fs.readFile(await f.store.file(f.session, record.id, record.versions[0].id), 'utf8'), '# Report');
  await fs.unlink(file); assert.equal(await f.store.sourceState(next.versions[1]), 'missing');
});

test('owner API validates identity, scopes download tickets, and filters published pages', async t => {
  const f = await fixture(t), file = path.join(f.project, 'report.md');
  await fs.writeFile(file, 'immutable report');
  let session = f.session;
  const pages = { list: async () => [
    { id: 'correct', source: { session: 'research', provider: 'codex', threadId: 'thread-1' } },
    { id: 'other', source: { session: 'research', provider: 'codex', threadId: 'other' } },
  ] };
  const app = express(); app.use(express.json());
  app.use('/api', (req, res, next) => {
    req.auth = { owner: req.headers.authorization === 'Bearer owner' || workfileDownloadAuthorized(req)
      || (req.headers.cookie === 'owner-session' && isWorkfileDownloadRequest(req)) };
    next();
  });
  mountWorkfiles(app, { store: f.store, pages, sessions: async () => [session], ownerOnly: (req, res, next) => req.auth.owner ? next() : res.sendStatus(403) });
  app.use((error, req, res, next) => res.status(error.status || 500).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const url = `${base}/api/sessions/research/workfiles`, headers = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' };
  assert.equal((await fetch(url)).status, 403);
  const initial = await (await fetch(url, { headers })).json();
  const revision = (await fetch(url, { headers })).headers.get('etag');
  assert.equal((await fetch(url, { headers: { ...headers, 'If-None-Match': revision } })).status, 304);
  assert.equal((await fetch(url + '?workThread=other', { headers })).status, 409);
  assert.deepEqual(initial.pages.map(page => page.id), ['correct']);
  assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify({}) })).status, 409);
  const value = { identity: initial.identity, key: 'report', title: 'Report', kind: 'result', path: file };
  assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify(value) })).status, 201);
  assert.equal((await fetch(url, { headers: { ...headers, 'If-None-Match': revision } })).status, 200);
  let current = await (await fetch(url, { headers })).json();
  const download = current.items[0].versions[0].downloadUrl;
  assert.equal(await (await fetch(base + download)).text(), 'immutable report');
  const preview = await fetch(base + download + '&preview=1');
  assert.match(preview.headers.get('content-type'), /text\/plain/);
  assert.match(preview.headers.get('content-security-policy'), /sandbox/);
  assert.equal((await fetch(url + '?' + download.split('?')[1])).status, 403, 'file ticket cannot authorize the list');
  const withoutTicket = new URL(base + download); withoutTicket.searchParams.delete('download'); withoutTicket.searchParams.delete('expires');
  assert.equal((await fetch(withoutTicket, { headers: { Cookie: 'owner-session' } })).status, 200, 'authenticated PDF range reads need not expire with a ticket');
  assert.equal((await fetch(url, { headers: { Cookie: 'owner-session' } })).status, 403, 'cookie exception is confined to exact file reads');
  assert.equal((await fetch(base + download.replace('research', 'other'))).status, 403);
  assert.equal((await fetch(base + download.replace(/expires=\d+/, 'expires=1000000000000'))).status, 403);
  await fs.writeFile(file, 'changed source file');
  assert.equal((await (await fetch(url, { headers })).json()).items[0].versions[0].sourceState, 'changed');
  const signed = new URL(base + download);
  assert.equal(workfileDownloadAuthorized({ method: 'GET', path: signed.pathname.slice(4), query: {
    ...Object.fromEntries(signed.searchParams), download: [signed.searchParams.get('download')],
  } }), false);
  const record = current.items[0];
  assert.equal((await fetch(`${url}/${record.id}`, { method: 'PATCH', headers, body: JSON.stringify({ identity: initial.identity, title: 'Updated', group: 'APP' }) })).status, 200);
  current = await (await fetch(url, { headers })).json();
  assert.equal(current.items[0].group, 'APP'); assert.equal(current.items[0].versions.length, 1);
  session = { ...session, createdAt: 999 };
  assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify(value) })).status, 409);
  assert.equal(await (await fetch(base + download)).text(), 'immutable report');
  const archived = await (await fetch(`${url}?archive=${initial.identity}`, { headers })).json();
  assert.equal(archived.items[0].title, 'Updated');
  session = null;
  assert.equal((await fetch(`${url}?archive=${initial.identity}`, { headers })).status, 200, 'archive remains readable without a live session');
  session = { ...f.session, createdAt: 999 };
  assert.deepEqual((await (await fetch(url, { headers })).json()).items, []);
});

test('CLI and upload context bind registration to the captured session', async t => {
  const f = await fixture(t), record = path.join(f.root, 'source.json');
  await fs.writeFile(record, JSON.stringify({ kind: 'source', key: 'filing', title: '财报', url: 'https://example.com' }));
  const calls = [];
  const result = await runCodeck(['workfiles', 'add', 'research', '--record', record], {}, { request: async (_, endpoint, method, body) => {
    calls.push({ endpoint, method, body }); return method === 'POST' ? body : { identity: 'captured' };
  } });
  assert.equal(result.identity, 'captured'); assert.equal(calls.length, 2);
  const query = uploadWorkContext(new URLSearchParams(), f.session);
  assert.equal(query.get('workSession'), 'research'); assert.equal(query.get('workThread'), 'thread-1');
});
