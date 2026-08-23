import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const html = fs.readFileSync(new URL('../public/remote.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../public/remote.css', import.meta.url), 'utf8');
const remoteJs = fs.readFileSync(new URL('../public/remote.js', import.meta.url), 'utf8');
const appCss = fs.readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
const rootCss = css.match(/^:root\s*\{([\s\S]*?)^\}/m)?.[1] || '';

function rootBreakpoint(cssText, width) {
  const match = cssText.match(new RegExp(`@media \\(min-width: ${width}px\\) \\{\\s*:root \\{([^}]*)\\}`));
  return match?.[1] || '';
}

test('remote uses Courier New for English with Noto Sans SC as its CJK fallback', () => {
  assert.doesNotMatch(html, /\/fonts\/inter\/wght\.css/);
  assert.match(html, /\/fonts\/noto-sans-sc\/wght\.css/);
  assert.match(rootCss, /font-family:\s*"Courier New",\s*Courier,\s*"Noto Sans SC Variable",\s*monospace/);
  assert.match(css, /\.terminal-live-output[^}]+"Courier New"/s);
});

test('remote desktop uses the normal workspace width and sidebar breakpoints', () => {
  assert.match(css, /--content:\s*100%/);

  for (const [width, drawer, gutter] of [[1800, 310, 24], [3000, 350, 32], [4500, 390, 42]]) {
    assert.match(rootBreakpoint(appCss, width), new RegExp(`--sidebar-width:\\s*${drawer}px`));
    assert.match(rootBreakpoint(css, width), new RegExp(`--drawer:\\s*${drawer}px`));
    assert.match(rootBreakpoint(css, width), new RegExp(`--workspace-gutter:\\s*${gutter}px`));
  }

  assert.match(css, /\.assistant-message\s*\{[^}]*max-width:\s*78ch/s);
  assert.match(css, /@media \(min-width: 1800px\)\s*\{[^}]*\}[^}]*\.assistant-message\s*\{[^}]*max-width:\s*100%/s);
  assert.match(css, /\.user-message\s*\{[^}]*620px/s);
  assert.match(css, /grid-template-columns:\s*92px minmax\(0, 1fr\) 92px/);
});

test('completed model turns expose a touch-accessible copy action', () => {
  assert.match(remoteJs, /agentOutputText\(turn\)/);
  assert.match(remoteJs, /setAttribute\('aria-label', '复制本轮模型输出'\)/);
  assert.match(css, /\.message-copy-button\s*\{[^}]*min-height:\s*34px/s);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.message-copy-button\s*\{[^}]*min-height:\s*44px/s);
});
