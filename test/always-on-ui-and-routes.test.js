import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { AlwaysOnStore } from '../src/always-on-store.js';
import { createAlwaysOnRuntime } from '../src/always-on-runtime.js';
import { createMemoryStore } from '../src/always-on-memory.js';
import { createOutboxDispatcher } from '../src/always-on-outbox.js';
import { createButlerOrchestrator } from '../src/always-on-butler.js';
import { createApprovalGate, createCredentialProxy } from '../src/always-on-permissions.js';
import { mountAlwaysOnRoutes } from '../src/always-on-routes.js';
import { runSnrEval } from '../scripts/always-on-snr-eval.mjs';

test('Both 普通模式 (index.html/app.js) and Remote 模式 (remote.html/remote.js) mount Always-On panel cleanly', async () => {
  const [indexHtml, remoteHtml, appJs, remoteJs, panelJs, panelCss] = await Promise.all([
    fs.readFile(path.resolve('public/index.html'), 'utf8'),
    fs.readFile(path.resolve('public/remote.html'), 'utf8'),
    fs.readFile(path.resolve('public/app.js'), 'utf8'),
    fs.readFile(path.resolve('public/remote.js'), 'utf8'),
    fs.readFile(path.resolve('public/always-on-panel.js'), 'utf8'),
    fs.readFile(path.resolve('public/always-on-panel.css'), 'utf8'),
  ]);

  for (const [name, html] of [['index.html', indexHtml], ['remote.html', remoteHtml]]) {
    assert.match(html, /always-on-panel\.css/, `${name} loads always-on-panel.css`);
    assert.match(html, /id="alwaysOnButton"[^>]*hidden/, `${name} hides alwaysOnButton by default for non-owner isolation`);
    assert.match(html, /id="alwaysOnBadge"/, `${name} includes alwaysOnBadge`);
  }
  assert.match(appJs, /bindAlwaysOnPanel/, 'app.js binds alwaysOnPanel');
  assert.match(appJs, /enabled:\s*\(\)\s*=>\s*state\.canManage/, 'app.js gates panel behind owner canManage');
  assert.match(remoteJs, /bindAlwaysOnPanel/, 'remote.js binds alwaysOnPanel');
  assert.match(panelJs, /data-butler-toggle/, 'panel exposes Scheme A Butler toggle');
  assert.match(panelJs, /approvals\/\$\{encodeURIComponent\(item\.id\)\}\/resolve/, 'panel supports deferred approval resolution');
  assert.match(panelCss, /@media\s*\(max-width:\s*640px\)/, 'panel includes mobile responsive rule for 390px viewport');
});

test('All /api/always-on/* routes enforce strict ownerOnly isolation and work end-to-end', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codeck-ao-e2e-'));
  const store = new AlwaysOnStore(':memory:');
  const memory = createMemoryStore({ directory: path.join(dir, 'memory') });
  const outboxDispatcher = createOutboxDispatcher({ store, memory });
  const butler = createButlerOrchestrator({ store, memory, outboxDispatcher });
  const runtime = createAlwaysOnRuntime({
    store,
    handleScope: async (scopeKey, batch, helpers) => {
      if (scopeKey === 'butler') return butler.handleBatch(batch, helpers);
      return { status: 'done' };
    },
  });
  const approvalGate = createApprovalGate({ store, runtime });
  const credentialProxy = createCredentialProxy({ secretsDir: path.join(dir, 'secrets') });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.auth = { owner: req.headers['x-owner'] === '1' }; next(); });
  const ownerOnly = (req, res, next) => (req.auth.owner ? next() : res.status(403).json({ error: 'forbidden' }));
  mountAlwaysOnRoutes(app, { store, runtime, memory, outboxDispatcher, butler, approvalGate, credentialProxy, ownerOnly });

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    // 1. Share token (x-owner: 0) MUST be rejected across all endpoints
    const shareEndpoints = [
      ['GET', '/api/always-on/overview'],
      ['GET', '/api/always-on/events'],
      ['GET', '/api/always-on/timers'],
      ['GET', '/api/always-on/outbox'],
      ['GET', '/api/always-on/memory'],
      ['GET', '/api/always-on/approvals'],
      ['GET', '/api/always-on/proxy/services'],
      ['POST', '/api/always-on/butler/toggle'],
    ];
    for (const [method, url] of shareEndpoints) {
      const res = await fetch(`${baseUrl}${url}`, {
        method,
        headers: { 'x-owner': '0', 'content-type': 'application/json' },
        ...(method === 'POST' ? { body: JSON.stringify({ enabled: false }) } : {}),
      });
      assert.equal(res.status, 403, `${method} ${url} must reject non-owner`);
    }

    // 2. Owner flow: toggle Butler, create & resolve deferred approval, read/write memory, run Dreaming
    const ownerHeaders = { 'x-owner': '1', 'content-type': 'application/json' };
    const toggled = await (await fetch(`${baseUrl}/api/always-on/butler/toggle`, { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ enabled: false }) })).json();
    assert.equal(toggled.enabled, false);
    await fetch(`${baseUrl}/api/always-on/butler/toggle`, { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ enabled: true }) });

    const apr = await (await fetch(`${baseUrl}/api/always-on/approvals`, {
      method: 'POST',
      headers: ownerHeaders,
      body: JSON.stringify({ scopeKey: 'butler', summary: '发布公开链接', action: { kind: 'page_share' } }),
    })).json();
    assert.equal(apr.deferred, true);

    const resolved = await (await fetch(`${baseUrl}/api/always-on/approvals/${apr.approval.id}/resolve`, {
      method: 'POST',
      headers: ownerHeaders,
      body: JSON.stringify({ decision: 'approved', note: 'OK' }),
    })).json();
    assert.equal(resolved.approval.status, 'approved');

    const memRes = await (await fetch(`${baseUrl}/api/always-on/memory`, { headers: ownerHeaders })).json();
    assert.equal(memRes.withinBudget, true);
    const dreamRes = await (await fetch(`${baseUrl}/api/always-on/memory/dream`, { method: 'POST', headers: ownerHeaders })).json();
    assert.equal(typeof dreamRes.ranAt, 'number');
  } finally {
    runtime.close();
    store.close();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('Outbox SNR offline replay eval achieves noise reduction and duplicate suppression', async () => {
  const result = await runSnrEval();
  assert.equal(result.totalEvents, 6);
  assert.equal(result.silentCount, 2); // 1 explicit silent + 1 duplicate suppressed via reported.md
  assert.equal(result.digestItemsCompiled, 2);
  assert.equal(result.outboundPushCalls, 1); // 2 notify items merged into 1 push call
  assert.ok(result.noiseReductionRatio >= 0.8);
});
