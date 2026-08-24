import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const html = fs.readFileSync(new URL('../public/login.html', import.meta.url), 'utf8');

test('persistent login is a self-contained accessible mobile form', () => {
  assert.match(html, /<html lang="zh-CN">/);
  assert.match(html, /name="viewport"[^>]*viewport-fit=cover/);
  assert.match(html, /<form[^>]*id="webLoginForm"/);
  assert.match(html, /<label for="webTokenInput">访问令牌<\/label>/);
  assert.match(html, /id="webTokenInput"[^>]*type="password"[^>]*autocomplete="current-password"[^>]*required/);
  assert.match(html, /id="webLoginError"[^>]*role="alert"[^>]*aria-live="polite"/);
  assert.match(html, /fetch\('\/api\/web-login'/);
  assert.match(html, /response\.status === 429/);
  assert.match(html, /尝试次数过多，请稍后再试/);
  assert.match(html, /localStorage\.setItem\('codeck-token'/);
  assert.doesNotMatch(html, /<(?:link|script)[^>]+(?:href|src)=/);
});

test('persistent login preserves touch sizing, focus visibility and safe areas', () => {
  assert.match(html, /font-size:\s*16px/);
  assert.match(html, /min-height:\s*48px/);
  assert.match(html, /button\s*\{[^}]*font-family:\s*inherit/s);
  assert.match(html, /:focus-visible/);
  assert.match(html, /env\(safe-area-inset-/);
  assert.match(html, /prefers-reduced-motion/);
});
