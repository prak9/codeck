// Actual selection dialog/stylesheet/module with an isolated screen fixture.
// No credentials, live sessions or terminal input. Native OS selection handles still
// require physical-device verification; setSelectionRange tests exact copy semantics.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(process.env.CODECK_PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const artifacts = await fs.mkdtemp(path.join(os.tmpdir(), 'codeck-selection-smoke-'));
const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://fixture').pathname;
  let asset = path.resolve(root, 'public', pathname === '/' ? 'index.html' : pathname.slice(1));
  if (pathname.startsWith('/fonts/inter/')) asset = path.join(root, 'node_modules/@fontsource-variable/inter', pathname.slice(13));
  if (pathname.startsWith('/fonts/noto-sans-sc/')) asset = path.join(root, 'node_modules/@fontsource-variable/noto-sans-sc', pathname.slice(20));
  if (!asset.startsWith(`${root}/`) && !asset.startsWith(root)) return res.writeHead(403).end();
  try {
    let data = await fs.readFile(asset);
    if (pathname === '/') data = data.toString().replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link[^>]*vendor\/xterm.css[^>]*>/, '');
    res.setHeader('Content-Type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[path.extname(asset)] || 'application/octet-stream');
    res.end(data);
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true });
try {
  for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }, { width: 1365, height: 900 }]) {
    const context = await browser.newContext({ viewport, hasTouch: true, isMobile: viewport.width < 1000 });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.evaluate(async () => {
      const { bindTerminalTextSelection } = await import('/terminal-text-selection.js');
      const $ = id => document.getElementById(id);
      window.copied = [];
      window.snapshot = '构建结果：成功\n选择这部分文本\n路径 /data/code/codeck\n<script>仅作为文字展示</script>\n' + '中文及 long-output '.repeat(90);
      window.openSelection = bindTerminalTextSelection({ dialog: $('terminalSelectionDialog'), text: $('terminalSelectionText'), status: $('terminalSelectionStatus'), copy: $('copyTerminalSelection'), close: $('closeTerminalSelection'), getSnapshot: () => window.snapshot, clipboard: { writeText: async text => { window.copied.push(text); } } });
      window.openSelection();
    });
    await page.click('#copyTerminalSelection');
    assert.match(await page.textContent('#terminalSelectionStatus'), /请先/);
    await page.locator('#terminalSelectionText').evaluate(el => {
      el.focus();
      const start = el.value.indexOf('选择这部分文本');
      el.setSelectionRange(start, start + '选择这部分文本'.length);
    });
    await page.click('#copyTerminalSelection');
    assert.deepEqual(await page.evaluate(() => window.copied), ['选择这部分文本']);
    await page.evaluate(() => { window.snapshot = 'new output'; });
    assert.match(await page.inputValue('#terminalSelectionText'), /构建结果/);
    assert.equal(await page.locator('#terminalSelectionText').getAttribute('readonly'), '');
    assert.ok(await page.locator('#terminalSelectionDialog').evaluate(el => el.scrollWidth <= el.clientWidth));
    await page.locator('#copyTerminalSelection').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(artifacts, `${viewport.width}-selection.png`) });
    await page.click('#closeTerminalSelection');
    assert.equal(await page.inputValue('#terminalSelectionText'), '');
    await page.evaluate(() => window.openSelection());
    assert.equal(await page.inputValue('#terminalSelectionText'), 'new output');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#terminalSelectionDialog').evaluate(el => el.open), false);
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`PASS ${viewport.width}x${viewport.height}`);
  }
  console.log(`Artifacts: ${artifacts}`);
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
