import test from 'node:test';
import assert from 'node:assert/strict';
import { terminalImageUrl } from '../public/terminal-image-preview.js';

test('preview recognizes image URLs without losing queries or fragments', () => {
  for (const url of ['https://example.com/a.PNG?q=1#part', 'http://example.com/a.webp', 'https://example.com/a%2Ejpg']) {
    assert.equal(terminalImageUrl(url, 'https://codeck.test'), url);
  }
  assert.equal(terminalImageUrl('https://codeck.test/api/download?path=remote%2Fa.png', 'https://codeck.test'), 'https://codeck.test/api/download?path=remote%2Fa.png');
});

test('preview leaves documents, unsafe protocols and ambiguous URLs alone', () => {
  for (const url of ['javascript:alert(1)', 'file:///a.png', '/tmp/a.png', 'https://example.com/page?file=a.png', 'https://example.com/a.svg', 'https://user:password@example.com/a.png', 'https://example.com/%zz.png']) {
    assert.equal(terminalImageUrl(url, 'https://codeck.test'), null);
  }
  assert.equal(terminalImageUrl('https://other.test/api/download?path=a.png', 'https://codeck.test'), null);
});
