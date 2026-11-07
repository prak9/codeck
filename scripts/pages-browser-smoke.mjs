import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { createPageStore, mountPublishedPages } from '../src/published-pages.js';
const { chromium } = await import(process.env.CODECK_PLAYWRIGHT_MODULE || 'playwright');
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codeck-pages-browser-'));
const app = express(); app.use(express.json());
let probes = 0;
app.get('/api/probe', (_req, res) => { probes++; res.json({ secret: true }); });
app.get('/login.html', (_req, res) => res.send('Login required'));
const store = createPageStore(path.join(directory, 'data'));
const feedbackSends = [];
mountPublishedPages(app, { store,
  resolveTarget: async () => ({ provider: 'codex', threadId: 'fixture', tmuxSession: 'research' }),
  sendFeedback: async (...args) => feedbackSends.push(args),
  apiAuth(req, res, next) { req.auth = { owner: req.headers.authorization === 'Bearer fixture' }; next(); },
  pageAuth(req, res, next) { if (req.headers.cookie?.includes('login=fixture')) return next(); res.redirect('/login.html'); },
});
const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
try {
  const response = await fetch(`${base}/api/pages/interactive`, { method: 'PUT', headers: { Authorization: 'Bearer fixture', 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '研究报告 · 交互验证', html: `<!doctype html><meta charset="utf-8"><style>body{font:16px system-ui;padding:24px}button{padding:12px}h1{font-size:24px}</style><h1>研究报告</h1><p>点击按钮查看交互结果。</p><button id="count" onclick="this.textContent='已验证'">运行验证</button><p id="isolation"></p><script>
      let blocked=0;try{parent.localStorage.getItem('codeck-token')}catch(e){blocked++}try{localStorage.setItem('x','x')}catch(e){blocked++}
      document.querySelector('#isolation').textContent='隔离检查：'+blocked;
      fetch('/api/probe',{credentials:'include'}).catch(()=>{});
      </script>` }) });
  assert.equal(response.status, 200);
  for (const width of [390, 1365]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    await page.goto(`${base}/pages/interactive`); assert.ok(page.url().endsWith('/login.html'));
    await context.addCookies([{ name: 'login', value: 'fixture', url: base }]);
    await page.goto(`${base}/pages/interactive`);
    const frame = page.frameLocator('iframe');
    await frame.locator('#count').click(); assert.equal(await frame.locator('#count').textContent(), '已验证');
    assert.equal(await frame.locator('#isolation').textContent(), '隔离检查：2');
    assert.equal(probes, 0);
    await page.screenshot({ path: path.join(directory, `${width}.png`) });
    await page.goto(`${base}/pages`); assert.equal(await page.getByRole('link', { name: '研究报告 · 交互验证' }).count(), 1);
    await page.goto(`${base}/pages/interactive`);
    await page.getByRole('button', { name: '分享', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('share-link').value.includes('?share='));
    const uiLink = await page.locator('#share-link').inputValue();
    assert.equal((await fetch(uiLink)).status, 200);
    await page.screenshot({ path: path.join(directory, `controls-${width}.png`) });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.reload();
    await page.getByRole('button', { name: '取消分享', exact: true }).click();
    await page.getByText('已取消分享', { exact: true }).waitFor();
    assert.equal((await fetch(uiLink)).status, 404);
    const report = await store.publish({ title: '研究结论', html: '<style>body{font:16px system-ui;padding:20px;line-height:1.6}</style><h1>研究结论</h1><p>增长来自新增客户，需要核对留存率。</p><p>估值判断需要分情景验证。</p>', source: { key: 'feedback', session: 'research', revision: 'v1' } });
    await page.goto(`${base}/pages/${report.id}`);
    await page.getByRole('button', { name: '批注', exact: true }).click();
    await page.frameLocator('iframe').getByText('增长来自新增客户，需要核对留存率。').click();
    await page.waitForFunction(() => document.querySelector('#feedback-quote').value.includes('增长'));
    await page.locator('#feedback-note').fill('请补充留存率证据');
    await page.getByRole('button', { name: '保存批注', exact: true }).click();
    await page.getByText('批注已保存', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(directory, `feedback-${width}.png`) });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const prior = feedbackSends.length;
    await page.getByRole('button', { name: '发送待处理批注', exact: true }).click();
    await page.getByText('已尝试发送到来源会话，请查看 Agent 回复。', { exact: true }).waitFor();
    assert.equal(feedbackSends.length, prior + 1);
    assert.match(feedbackSends.at(-1)[1], /请补充留存率证据/);
    await page.reload(); await page.getByRole('button', { name: '批注', exact: true }).click();
    await page.getByRole('button', { name: '发送待处理批注', exact: true }).click();
    await page.getByText('没有待发送批注', { exact: true }).waitFor();
    assert.equal(feedbackSends.length, prior + 1);
    await context.clearCookies();
    const shared = await (await fetch(`${base}/api/pages/interactive/share`, { method: 'POST', headers: { Authorization: 'Bearer fixture' } })).json();
    await page.goto(base + shared.url);
    await page.frameLocator('iframe').locator('#count').click();
    assert.equal(await page.frameLocator('iframe').locator('#count').textContent(), '已验证');
    assert.equal(await page.frameLocator('iframe').locator('#isolation').textContent(), '隔离检查：2');
    assert.equal(probes, 0);
    await fetch(`${base}/api/pages/interactive/share`, { method: 'DELETE', headers: { Authorization: 'Bearer fixture' } });
    assert.equal((await page.reload()).status(), 404);
    await context.close(); console.log(`PASS ${width}: auth, interactive HTML, storage/parent/API isolation, list`);
  }
  console.log(`Artifacts: ${directory}`);
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); await fs.rm(path.join(directory, 'data'), { recursive: true, force: true }); }
