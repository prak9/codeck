import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveImageUpload } from '../src/uploads.js';

test('stores an authenticated image payload with a safe extension', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeck-upload-'));
  try {
    const content = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
    const target = saveImageUpload(content, 'image/png', root);
    assert.equal(path.extname(target), '.png');
    assert.deepEqual(fs.readFileSync(target), content);
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  } finally { fs.rmSync(root, { recursive: true }); }
});

test('rejects empty and unsupported image payloads', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeck-upload-'));
  try {
    assert.throws(() => saveImageUpload(Buffer.alloc(0), 'image/png', root), /图片内容为空/);
    assert.throws(() => saveImageUpload(Buffer.from('svg'), 'image/svg+xml', root), /图片格式/);
    assert.throws(() => saveImageUpload(Buffer.from('not-png'), 'image/png', root), /内容与格式不匹配/);
  } finally { fs.rmSync(root, { recursive: true }); }
});
