// Real page, theme and styles; fixture content only. No live CLI connection.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.CODECK_PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const artifacts = await fs.mkdtemp(path.join(os.tmpdir(), 'codeck-theme-'));
const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://fixture').pathname;
  let asset = path.join(root, 'public', pathname === '/' ? 'index.html' : pathname);
  if (pathname.startsWith('/fonts/inter/')) asset = path.join(root, 'node_modules/@fontsource-variable/inter', pathname.slice(13));
  if (pathname.startsWith('/fonts/noto-sans-sc/')) asset = path.join(root, 'node_modules/@fontsource-variable/noto-sans-sc', pathname.slice(20));
  if (pathname === '/vendor/xterm/xterm.js') asset = path.join(root, 'node_modules/@xterm/xterm/lib/xterm.js');
  else if (pathname === '/vendor/xterm.css') asset = path.join(root, 'node_modules/@xterm/xterm/css/xterm.css');
  else if (pathname.startsWith('/vendor/') || pathname === '/app.js') { res.setHeader('Content-Type', pathname.endsWith('.css') ? 'text/css' : 'text/javascript'); return res.end(''); }
  try { res.setHeader('Content-Type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[path.extname(asset)] || 'application/octet-stream'); res.end(await fs.readFile(asset)); }
  catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [1365, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage(); const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    assert.equal(await page.getAttribute('html', 'data-terminal-theme'), 'classic');
    await page.evaluate(() => document.querySelector('#settingsDialog').showModal());
    await page.selectOption('#terminalThemeSelect', 'mac');
    assert.equal(await page.getAttribute('html', 'data-terminal-theme'), 'mac');
    assert.equal(await page.locator('#settingsDialog').evaluate(el => getComputedStyle(el).backdropFilter), 'none');
    await page.screenshot({ path: path.join(artifacts, `${width}-settings.png`) });
    await page.reload();
    assert.equal(await page.getAttribute('html', 'data-terminal-theme'), 'mac');
    await page.evaluate(async () => {
      document.querySelector('#emptyState').hidden = true;
      document.querySelector('#terminalView').hidden = false;
      document.querySelector('#sessionList').innerHTML = ['research', 'codeck', '量化特征与创新', '理解无相概念', 'report'].map((name, i) => `<button class="session-row ${i === 1 ? 'active' : ''}"><span class="session-index">${i + 1}</span><span class="session-icon">C›</span><span class="session-copy"><b>${name}</b><small>已就绪 · 刚刚</small></span><span class="presence done"></span></button>`).join('');
      const { bindTerminalPalette } = await import('/terminal-palette.js');
      window.fixtureTerminal = new Terminal({ cols: innerWidth < 720 ? 34 : 100, rows: 24, fontSize: 16 });
      bindTerminalPalette(window.fixtureTerminal);
      window.fixtureTerminal.open(document.querySelector('#terminal'));
      await new Promise(resolve => window.fixtureTerminal.write('$ npm test\r\n\r\n\x1b[32m✔ Session search\x1b[0m\r\n\x1b[34m✔ Terminal copy\x1b[0m\r\n\x1b[33m✔ Theme preference\x1b[0m\r\n\r\nAll tests passed.\r\n\r\n› Continue your work', resolve));
      window.fixtureTerminal.select(0, 0, 5);
      document.querySelector('#terminalVoiceComposer').hidden = false;
      document.querySelector('#terminalVoiceDraft').value = '尚未发送的草稿';
    });
    const geometry = await page.locator('#terminal').boundingBox();
    assert.equal(await page.locator('.session-copy b').first().evaluate(el => getComputedStyle(el).fontSize), '15px');
    assert.equal(await page.locator('#sidebar').evaluate(el => getComputedStyle(el).borderRightColor), 'rgb(230, 230, 230)');
    assert.equal(await page.locator('.terminal-voice-composer textarea').evaluate(el => getComputedStyle(el).color), 'rgb(32, 32, 32)');
    assert.equal(await page.evaluate(() => window.fixtureTerminal.options.theme.background), '#ffffff');
    await page.screenshot({ path: path.join(artifacts, `${width}-terminal.png`) });
    if (width === 390) {
      await page.evaluate(() => document.querySelector('#sidebar').classList.add('open'));
      await page.locator('#sessionSearch').click();
      await page.screenshot({ path: path.join(artifacts, `${width}-sidebar.png`) });
    }
    await page.evaluate(() => document.querySelector('#settingsDialog').showModal());
    await page.selectOption('#terminalThemeSelect', 'classic');
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => window.fixtureTerminal.options.theme.background), '#2e3436');
    assert.equal(await page.evaluate(() => window.fixtureTerminal.getSelection()), '$ npm');
    assert.equal(await page.evaluate(() => window.fixtureTerminal.buffer.active.getLine(0).translateToString(true)), '$ npm test');
    assert.equal(await page.inputValue('#terminalVoiceDraft'), '尚未发送的草稿');
    assert.deepEqual(await page.locator('#terminal').boundingBox(), geometry);
    await page.reload();
    assert.equal(await page.getAttribute('html', 'data-terminal-theme'), 'classic');
    assert.deepEqual(errors, []);
    console.log(`PASS ${width}: theme, persistence, draft, geometry`);
    await context.close();
  }
  console.log(`Artifacts: ${artifacts}`);
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
