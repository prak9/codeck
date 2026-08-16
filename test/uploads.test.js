import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveUploadPath,
  sanitizePathSegment,
  saveFileUpload,
  saveImageUpload,
} from '../src/uploads.js';

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

test('stores arbitrary files with optional relative path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeck-upload-'));
  try {
    const content = Buffer.from('hello file');
    const target = saveFileUpload(content, 'notes.txt', 'dir/sub', root);
    assert.equal(path.basename(target), 'notes.txt');
    assert.equal(fs.readFileSync(target).toString(), 'hello file');
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  } finally { fs.rmSync(root, { recursive: true }); }
});

test('sanitizes file path segments and blocks traversal', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeck-upload-'));
  try {
    const target = saveFileUpload(Buffer.from('safe'), 'a..\\..\\evil?.txt', '..\\windows\\..\\tmp', root);
    assert.equal(path.dirname(path.relative(root, target)).split(path.sep).includes('..'), false);
    assert.ok(target.includes('evil_.txt') || target.includes('a.._.._evil_.txt'));
  } finally { fs.rmSync(root, { recursive: true }); }
});

test('path helpers sanitize and normalize segments', () => {
  assert.equal(sanitizePathSegment('a/b\\c:*?'), 'a_b_c___');
  assert.equal(resolveUploadPath('../outside/../', 'a.txt', '/tmp/root').includes('root'), true);
});

test('rejects empty and unsupported image payloads', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeck-upload-'));
  try {
    assert.throws(() => saveImageUpload(Buffer.alloc(0), 'image/png', root), /图片内容为空/);
    assert.throws(() => saveImageUpload(Buffer.from('svg'), 'image/svg+xml', root), /图片格式/);
    assert.throws(() => saveImageUpload(Buffer.from('not-png'), 'image/png', root), /内容与格式不匹配/);
  } finally { fs.rmSync(root, { recursive: true }); }
});
