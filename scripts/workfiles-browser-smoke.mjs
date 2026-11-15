// Actual shared panel, API and persisted snapshots; all sessions/files are fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { createWorkfiles, mountWorkfiles, workfileDownloadAuthorized } from '../src/workfiles.js';
import { createPageStore } from '../src/published-pages.js';
import { saveUploadStream } from '../src/uploads.js';
const { chromium } = await import(process.env.CODECK_PLAYWRIGHT_MODULE || 'playwright');
const artifacts = await fs.mkdtemp(path.join(os.tmpdir(), 'codeck-workfiles-browser-'));
const session = { name: 'research', createdAt: 123, agent: { kind: 'codex', id: 'fixture', cwd: artifacts } };
const store = createWorkfiles(path.join(artifacts, 'data'), { uploadRoot: path.join(artifacts, 'uploads') });
const pages = createPageStore(path.join(artifacts, 'pages'));
await store.put(session, { key: 'filing', kind: 'source', title: 'APP 最新季度财报', group: 'APP 财报更新', date: '2026-11-05', url: 'https://example.com/filing' });
const file = path.join(artifacts, 'report.md'); await fs.writeFile(file, '# 已验证的研究报告\n版本一');
await store.put(session, { key: 'report', kind: 'result', title: 'APP 投资研究报告', group: 'APP 财报更新', path: file, revision: 'v1' });
await fs.writeFile(file, '# 已验证的研究报告\n版本二\n\n| 项目 | 结果 |\n| --- | --- |\n| 收入 | 增长 |\n\n<script>window.previewExecuted=true</script>\n[unsafe](javascript:alert(1))');
await store.put(session, { key: 'report', kind: 'result', title: 'APP 投资研究报告', group: 'APP 财报更新', path: file, revision: 'v2', evidence: { version: 'v2', summary: '核对财报数据', checks: [{ method: '数据对照', result: 'passed', reference: 'fixture/filing' }], limitations: ['估值假设尚未核验'] } });
const image = path.join(artifacts, 'chart.png');
await fs.writeFile(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5mQAAAAASUVORK5CYII=', 'base64'));
await store.put(session, { key: 'image', kind: 'result', title: '图片示例', group: 'APP 财报更新', path: image });
const pdfFile = path.join(artifacts, 'filing.pdf');
const stream = 'BT /F1 22 Tf 50 750 Td (PDF preview fixture) Tj ET';
const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
let pdf = '%PDF-1.4\n'; const offsets = [0];
for (const [i, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; }
const xref = Buffer.byteLength(pdf);
pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
await fs.writeFile(pdfFile, pdf);
await store.put(session, { key: 'pdf', kind: 'result', title: 'PDF 示例', group: 'APP 财报更新', path: pdfFile });
const large = path.join(artifacts, 'large.txt'); await fs.writeFile(large, '字'.repeat(100000));
await store.put(session, { key: 'large', kind: 'result', title: '长文示例', group: 'APP 财报更新', path: large });
await pages.publish({ title: '估值敏感性分析', html: '<h1>估值敏感性分析</h1>', source: { key: 'valuation', session: 'research', provider: 'codex', threadId: 'fixture' } });
const app = express(); app.use(express.json());
app.use('/api', (req, res, next) => { req.auth = { owner: req.headers.authorization === 'Bearer fixture' || workfileDownloadAuthorized(req) }; next(); });
const ownerOnly = (req, res, next) => req.auth.owner ? next() : res.sendStatus(403);
mountWorkfiles(app, { store, pages, sessions: async () => [session], ownerOnly });
app.post('/api/uploads/files', ownerOnly, async (req, res, next) => {
  try {
    assert.equal(req.query.workSession, 'research');
    const file = await saveUploadStream(req, { fileName: req.query.name, root: path.join(artifacts, 'uploads') });
    await store.put(session, { key: file, kind: 'source', title: path.basename(file), path: file }); res.json({ path: file });
  } catch (error) { next(error); }
});
app.get('/', (req, res) => res.send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/remote.css"><link rel="stylesheet" href="/workfiles.css"><style>body{padding:24px}header{display:flex;align-items:center;justify-content:space-between}#canvas{height:75vh;background:var(--terminal);margin-top:20px;padding:20px}</style><header><b>research</b><button id="workfilesButton" class="header-button workfiles-button" aria-label="工作文件"><svg viewBox="0 0 24 24"><path d="M3 7h7l2-3h9v16H3z"/></svg></button></header><div id="canvas">原有对话 / 终端</div><script type="module">import {bindWorkfiles} from '/workfiles.js';window.target=${JSON.stringify(session)};window.panel=bindWorkfiles({button:document.querySelector('#workfilesButton'),token:()=> 'fixture',getTarget:()=>window.target,refreshIntervalMs:200});window.panel.sync();</script>`));
app.use(express.static('public'));
app.use((error, req, res, next) => res.status(error.status || 500).json({ error: error.message }));
const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
const browser = await chromium.launch({ headless: true, ...(process.env.CODECK_BROWSER_EXECUTABLE ? { executablePath: process.env.CODECK_BROWSER_EXECUTABLE } : {}) });
try {
  for (const width of [390, 1365]) for (const theme of ['dark', 'light']) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    const before = await page.locator('#canvas').boundingBox();
    await page.getByRole('button', { name: '工作文件', exact: true }).click();
    const dialog = page.getByRole('dialog');
    const reveal = async title => {
      const group = dialog.locator('.workfiles-group').filter({ has: page.getByRole('heading', { name: title, includeHidden: true }) });
      if (!await group.evaluate(el => el.open)) await group.locator('summary').first().click();
    };
    await dialog.getByRole('heading', { name: 'APP 最新季度财报', includeHidden: true }).waitFor({ state: 'attached' });
    await reveal('APP 最新季度财报');
    assert.ok(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth));
    await page.screenshot({ path: path.join(artifacts, `${width}-${theme}-sources.png`) });
    await dialog.getByRole('button', { name: '成果', exact: true }).click();
    await reveal('APP 投资研究报告');
    await dialog.getByRole('heading', { name: 'APP 投资研究报告' }).waitFor();
    await dialog.getByText('版本 · 2', { exact: true }).click();
    await dialog.getByRole('button', { name: 'v1', exact: true }).scrollIntoViewIfNeeded();
    const listScroll = await dialog.evaluate(node => node.scrollTop);
    await dialog.getByRole('button', { name: 'v1', exact: true }).click();
    await dialog.locator('.workfiles-preview-content').getByText('版本一', { exact: true }).waitFor();
    assert.ok((await dialog.locator('[data-preview-version]').textContent()).includes('历史快照'));
    await page.keyboard.press('Escape');
    assert.equal(await dialog.evaluate(node => node.open), true, 'Escape returns to list first');
    assert.equal(await dialog.evaluate(node => node.scrollTop), listScroll);
    assert.equal(await dialog.getByRole('button', { name: 'v1', exact: true }).evaluate(node => document.activeElement === node), true);
    await dialog.getByText('版本 · 2', { exact: true }).click();
    const article = dialog.locator('article').filter({ has: page.getByRole('heading', { name: 'APP 投资研究报告' }) });
    await article.getByRole('button', { name: '预览', exact: true }).click();
    await dialog.locator('.workfiles-preview-content table').waitFor();
    if (width === 390 && theme === 'dark') {
      let previewReads = 0; const observe = request => { if (request.url().includes('/workfiles?')) previewReads++; };
      page.on('request', observe); await new Promise(resolve => setTimeout(resolve, 600));
      assert.equal(previewReads, 0, 'reading a snapshot pauses automatic list refresh'); page.off('request', observe);
    }
    assert.equal(await dialog.locator('.workfiles-preview-content script').count(), 0);
    assert.equal(await dialog.locator('.workfiles-preview-content a[href^="javascript:"]').count(), 0);
    assert.equal(await page.evaluate(() => window.previewExecuted), undefined);
    await dialog.locator('.workfiles-verification summary').click();
    await dialog.getByText('估值假设尚未核验', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(artifacts, `${width}-${theme}-preview.png`) });
    await dialog.getByRole('button', { name: '← 返回列表', exact: true }).click();
    await article.getByRole('button', { name: '编辑', exact: true }).click();
    await article.getByLabel('标题', { exact: true }).fill('APP 投资研究报告');
    await article.getByLabel('工作主题', { exact: true }).fill('APP 财报更新');
    await article.getByRole('button', { name: '保存', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.workfiles-editor'));
    await reveal('APP 投资研究报告');
    await dialog.getByRole('heading', { name: 'APP 投资研究报告' }).waitFor();
    await page.screenshot({ path: path.join(artifacts, `${width}-${theme}-results.png`) });
    if (width === 390 && theme === 'dark') {
      const imageItem = dialog.locator('article').filter({ has: page.getByRole('heading', { name: '图片示例' }) });
      await imageItem.getByRole('button', { name: '预览', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.workfiles-preview-content img')?.naturalWidth > 0);
      await page.screenshot({ path: path.join(artifacts, 'inline-image.png') });
      await dialog.getByRole('button', { name: '← 返回列表', exact: true }).click();
      const pdfResponse = page.waitForResponse(response => response.headers()['content-type'] === 'application/pdf');
      await dialog.locator('article').filter({ has: page.getByRole('heading', { name: 'PDF 示例' }) }).getByRole('button', { name: '预览', exact: true }).click();
      assert.equal((await pdfResponse).status(), 200);
      await dialog.locator('.workfiles-preview iframe').waitFor();
      await new Promise(resolve => setTimeout(resolve, 1000));
      await page.screenshot({ path: path.join(artifacts, 'inline-pdf.png') });
      await dialog.getByRole('button', { name: '← 返回列表', exact: true }).click();
      await dialog.locator('article').filter({ has: page.getByRole('heading', { name: '长文示例' }) }).getByRole('button', { name: '预览', exact: true }).click();
      await dialog.getByText('仅预览前 256 KiB，完整内容请下载。', { exact: true }).waitFor();
      const textPreview = await dialog.locator('.workfiles-preview-content pre').textContent();
      assert.ok(textPreview.length < 100000 && !textPreview.includes('�'));
      await dialog.getByRole('button', { name: '← 返回列表', exact: true }).click();
      await dialog.getByRole('button', { name: '成果', exact: true }).focus();
      await page.waitForResponse(response => response.url().includes('/workfiles?') && response.status() === 304);
      const stable = await article.elementHandle();
      await page.waitForResponse(response => response.url().includes('/workfiles?') && response.status() === 304);
      assert.equal(await stable.evaluate(node => node.isConnected), true, 'unchanged data does not repaint');
      await pages.publish({ title: '自动更新的估值分析', html: '<h1>新结果</h1>', source: { key: 'valuation', session: 'research', provider: 'codex', threadId: 'fixture' } });
      await dialog.getByRole('heading', { name: '自动更新的估值分析' }).waitFor();
      await article.getByRole('button', { name: '编辑', exact: true }).click();
      await article.getByLabel('标题', { exact: true }).fill('保留尚未保存的标题');
      await pages.publish({ title: '编辑期间发布的结果', html: '<h1>编辑期间的新结果</h1>', source: { key: 'valuation', session: 'research', provider: 'codex', threadId: 'fixture' } });
      await new Promise(resolve => setTimeout(resolve, 600));
      assert.equal(await article.getByLabel('标题', { exact: true }).inputValue(), '保留尚未保存的标题');
      await article.getByRole('button', { name: '取消', exact: true }).click();
      await dialog.getByRole('heading', { name: '编辑期间发布的结果' }).waitFor();
      await dialog.getByRole('button', { name: '资料', exact: true }).click();
      await store.put(session, { key: 'external-update', kind: 'source', title: 'Agent 新登记的资料', group: 'APP 财报更新', url: 'https://example.com/new' });
      await dialog.getByRole('heading', { name: 'Agent 新登记的资料' }).waitFor();
      let failOnce = true;
      await page.route('**/api/sessions/research/workfiles?*', route => {
        if (failOnce) { failOnce = false; return route.fulfill({ status: 503, json: { error: 'fixture outage' } }); }
        return route.continue();
      });
      await dialog.getByText('自动刷新暂不可用，将继续重试。也可点击右上角刷新。', { exact: true }).waitFor();
      assert.equal(await dialog.getByRole('heading', { name: 'Agent 新登记的资料' }).count(), 1, 'outage preserves existing data');
      await page.waitForFunction(() => document.querySelector('.workfiles-status').textContent === '');
      await page.unroute('**/api/sessions/research/workfiles?*');
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      let hiddenReads = 0; const observeHidden = request => { if (request.url().includes('/workfiles?')) hiddenReads++; };
      page.on('request', observeHidden); await new Promise(resolve => setTimeout(resolve, 600));
      assert.equal(hiddenReads, 0, 'hidden page pauses refreshing'); page.off('request', observeHidden);
      await store.put(session, { key: 'visible-update', kind: 'source', title: '返回页面后的新资料', group: 'APP 财报更新', url: 'https://example.com/visible' });
      await page.evaluate(() => {
        delete document.hidden; document.dispatchEvent(new Event('visibilitychange'));
      });
      await dialog.getByRole('heading', { name: '返回页面后的新资料' }).waitFor();
      await page.screenshot({ path: path.join(artifacts, 'auto-refresh.png') });
    }
    await page.keyboard.press('Escape');
    assert.deepEqual(await page.locator('#canvas').boundingBox(), before, 'panel never resizes the terminal');
    await page.getByRole('button', { name: '工作文件', exact: true }).click();
    await dialog.getByRole('button', { name: '资料', exact: true }).click();
    await dialog.locator('.workfiles-add summary').click();
    await dialog.getByLabel('标题', { exact: true }).fill('补充材料');
    await dialog.getByLabel('链接', { exact: true }).fill('https://example.com/extra');
    await dialog.getByRole('button', { name: '添加', exact: true }).click();
    await dialog.getByRole('heading', { name: '补充材料' }).waitFor();
    const filename = `notes-${width}-${theme}.txt`;
    await dialog.locator('input[type=file]').setInputFiles({ name: filename, mimeType: 'text/plain', buffer: Buffer.from('研究笔记') });
    await dialog.getByRole('heading', { name: new RegExp(filename.replace('.', '\\.')) }).waitFor();
    await dialog.locator('article').filter({ has: page.getByRole('heading', { name: new RegExp(filename.replace('.', '\\.')) }) }).getByRole('button', { name: '预览', exact: true }).click();
    await dialog.getByText('研究笔记', { exact: true }).waitFor();
    await page.evaluate(() => { window.target = { ...window.target, createdAt: 999 }; window.panel.sync(); });
    assert.equal(await dialog.isVisible(), false, 'session replacement closes the old panel');
    assert.equal(await page.locator('.workfiles-preview-content').evaluate(node => node.childElementCount), 0, 'session switch releases the previous preview');
    if (width === 390 && theme === 'dark') {
      let reads = 0; const observe = request => { if (request.url().includes('/workfiles?')) reads++; };
      page.on('request', observe); await new Promise(resolve => setTimeout(resolve, 600));
      assert.equal(reads, 0, 'closed panel stops refreshing'); page.off('request', observe);
    }
    assert.deepEqual(errors, []); await context.close();
    console.log(`PASS ${width}/${theme}: sources, results, versions, edit, upload, no resize/overflow, identity replacement`);
  }
  console.log(`Artifacts: ${artifacts}`);
} finally {
  await browser.close(); await new Promise(resolve => server.close(resolve));
}
