#!/usr/bin/env node
/**
 * Isolated dual-mode (普通模式 index.html + Remote 模式 remote.html) × dual-viewport (390px / 1365px)
 * Playwright browser smoke test for the Always-On Super Agent panel.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { AlwaysOnStore } from '../src/always-on-store.js';
import { createAlwaysOnRuntime } from '../src/always-on-runtime.js';
import { createMemoryStore } from '../src/always-on-memory.js';
import { createOutboxDispatcher } from '../src/always-on-outbox.js';
import { createButlerOrchestrator } from '../src/always-on-butler.js';
import { createApprovalGate, createCredentialProxy } from '../src/always-on-permissions.js';
import { mountAlwaysOnRoutes } from '../src/always-on-routes.js';

const playwrightModule = process.env.CODECK_PLAYWRIGHT_MODULE || '/data/tmp/codeck-playwright/node_modules/playwright/index.mjs';
const { chromium } = await import(playwrightModule);

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codeck-ao-browser-'));
const store = new AlwaysOnStore(':memory:');
const memory = createMemoryStore({ directory: path.join(dir, 'memory') });
const outboxDispatcher = createOutboxDispatcher({ store, memory });
const butler = createButlerOrchestrator({ store, memory, outboxDispatcher });
const runtime = createAlwaysOnRuntime({
  store,
  handleScope: async (scopeKey, batch, helpers) => (scopeKey === 'butler' ? butler.handleBatch(batch, helpers) : { status: 'done' }),
});
const approvalGate = createApprovalGate({ store, runtime });
const credentialProxy = createCredentialProxy({ secretsDir: path.join(dir, 'secrets') });

// Seed one pending deferred approval and one digest item
approvalGate.requestApproval({
  scopeKey: 'session:demo',
  sessionName: 'demo',
  summary: '分享演示报告页面',
  action: { kind: 'page_share', pageId: 'demo-1' },
});
store.enqueueOutbox({ scopeKey: 'butler', priority: 'digest', channel: 'web', title: '夜间巡检摘要', contentMd: '全部健康' });

const app = express();
app.use(express.json());
app.use('/api', (req, _res, next) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/, '');
  req.auth = { owner: token === 'owner-token', canWrite: token === 'owner-token' };
  next();
});
const ownerOnly = (req, res, next) => (req.auth.owner ? next() : res.status(403).json({ error: 'forbidden' }));
app.get('/api/sessions', (req, res) => {
  res.json({
    sessions: [{ name: 'demo', windows: 1, attached: 0, createdAt: Date.now(), activityAt: Date.now(), status: 'done', executionState: 'idle', agent: { kind: 'codex', id: 'thr-demo', name: 'Demo' } }],
    capabilities: { flexibleSize: true, canManage: req.auth.owner, canWrite: req.auth.canWrite, canSwitchSession: req.auth.owner, terminalSubmit: true },
  });
});
mountAlwaysOnRoutes(app, { store, runtime, memory, outboxDispatcher, butler, approvalGate, credentialProxy, ownerOnly });
app.use('/vendor', express.static(path.resolve('node_modules/@xterm/xterm/css')));
app.use('/vendor/xterm', express.static(path.resolve('node_modules/@xterm/xterm/lib')));
app.use('/vendor/fit', express.static(path.resolve('node_modules/@xterm/addon-fit/lib')));
app.use('/vendor/webgl', express.static(path.resolve('node_modules/@xterm/addon-webgl/lib')));
app.use('/vendor/web-links', express.static(path.resolve('node_modules/@xterm/addon-web-links/lib')));
app.use('/fonts/inter', express.static(path.resolve('node_modules/@fontsource-variable/inter')));
app.use('/fonts/noto-sans-sc', express.static(path.resolve('node_modules/@fontsource-variable/noto-sans-sc')));
app.use(express.static(path.resolve('public')));

const server = http.createServer(app);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const executablePath = process.env.CODECK_CHROMIUM_BIN || undefined;
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });

try {
  const checks = [];
  for (const mode of [{ name: 'normal', path: '/' }, { name: 'remote', path: '/remote.html' }]) {
    for (const vp of [{ name: 'mobile-390', width: 390, height: 844 }, { name: 'desktop-1365', width: 1365, height: 900 }]) {
      const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
      await context.addInitScript(() => {
        localStorage.setItem('codeck-token', 'owner-token');
        sessionStorage.setItem('codeck-token', 'owner-token');
      });
      const page = await context.newPage();
      const pageErrors = [];
      page.on('pageerror', err => pageErrors.push(err.message));

      await page.goto(`${baseUrl}${mode.path}`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(400);

      // Open drawer on mobile if needed
      if (vp.width === 390) {
        const menuBtn = page.locator(mode.name === 'normal' ? '#menuButton' : '#drawerButton');
        if (await menuBtn.isVisible()) await menuBtn.click();
        await page.waitForTimeout(200);
      }

      const btn = page.locator('#alwaysOnButton');
      await btn.waitFor({ state: 'visible', timeout: 5000 });
      await btn.click();

      const dialog = page.locator('dialog.always-on-dialog[open]');
      await dialog.waitFor({ state: 'visible', timeout: 5000 });

      // Check tabs: timers, memory, events
      await dialog.locator('[data-tab="timers"]').click();
      await dialog.locator('input[name="reason"]').waitFor({ state: 'visible', timeout: 3000 });
      await dialog.locator('[data-tab="memory"]').click();
      await dialog.locator('textarea').waitFor({ state: 'visible', timeout: 3000 });
      await dialog.locator('[data-tab="events"]').click();
      await dialog.locator('text=已注册 Credential Proxy').waitFor({ state: 'visible', timeout: 3000 });

      // Close cleanly
      await dialog.locator('[data-close]').click();
      await dialog.waitFor({ state: 'hidden', timeout: 3000 });

      assert.equal(pageErrors.length, 0, `${mode.name}/${vp.name} pageErrors: ${pageErrors.join('; ')}`);
      checks.push({ mode: mode.name, viewport: vp.name, ok: true });
      await context.close();
    }
  }
  console.log(JSON.stringify({ ok: true, checks }, null, 2));
} finally {
  await browser.close();
  runtime.close();
  store.close();
  await new Promise(resolve => server.close(resolve));
  await fs.rm(dir, { recursive: true, force: true });
}
