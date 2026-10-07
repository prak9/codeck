import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  resolveDownloadPath,
  resolveUploadPath,
  sanitizePathSegment,
  saveFileUpload,
  saveImageUpload,
  saveUploadStream,
} from '../src/uploads.js';

test('streaming upload accepts the limit and removes oversized/aborted partial files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeck-stream-upload-'));
  try {
    const target = await saveUploadStream(Readable.from([Buffer.alloc(8), Buffer.alloc(8)]), { root, fileName: 'data.bin', maxBytes: 16 });
    assert.equal(fs.statSync(target).size, 16);
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
    await assert.rejects(saveUploadStream(Readable.from([Buffer.alloc(8), Buffer.alloc(9)]), { root, fileName: 'data.bin', maxBytes: 16 }), { status: 413 });
    const broken = Readable.from((async function* () { yield Buffer.alloc(4); throw new Error('connection lost'); })());
    await assert.rejects(saveUploadStream(broken, { root, fileName: 'data.bin' }), /connection lost/);
    assert.equal(fs.statSync(target).size, 16, 'failed upload preserves the previous complete file');
    assert.deepEqual(fs.readdirSync(root), ['data.bin']);
  } finally { fs.rmSync(root, { recursive: true }); }
});

test('streaming image signatures work across chunks and reject invalid images without residue', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeck-stream-image-'));
  try {
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const target = await saveUploadStream(Readable.from([...png].map(byte => Buffer.from([byte]))), { root, contentType: 'image/png' });
    assert.deepEqual(fs.readFileSync(target), png);
    for (const content of [Buffer.alloc(0), Buffer.from('not an image')]) {
      await assert.rejects(saveUploadStream(Readable.from([content]), { root, contentType: 'image/png' }), /图片内容/);
    }
    assert.equal(fs.readdirSync(root).length, 1);
    const request = Readable.from([]); request.headers = { 'content-length': String(10 * 1024 ** 3 + 1) };
    await assert.rejects(saveUploadStream(request, { root, fileName: 'large' }), { status: 413 });
    assert.equal(fs.readdirSync(root).length, 1);
  } finally { fs.rmSync(root, { recursive: true }); }
});

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

test('download path resolver keeps access inside upload root', () => {
  const root = `${os.homedir()}/.codeck/uploads`;
  assert.equal(resolveDownloadPath(`${root}/a.txt`, root), `${root}/a.txt`);
  assert.throws(() => resolveDownloadPath('/tmp/other/a.txt', root), /非法下载路径/);
  assert.equal(resolveDownloadPath('a.txt', root), `${root}/a.txt`);
  assert.equal(resolveDownloadPath('~/.codeck/uploads/b.txt', root), `${os.homedir()}/.codeck/uploads/b.txt`);
  assert.throws(() => resolveDownloadPath('../outside.txt', root), /非法下载路径/);
});

test('rejects empty and unsupported image payloads', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeck-upload-'));
  try {
    assert.throws(() => saveImageUpload(Buffer.alloc(0), 'image/png', root), /图片内容为空/);
    assert.throws(() => saveImageUpload(Buffer.from('svg'), 'image/svg+xml', root), /图片格式/);
    assert.throws(() => saveImageUpload(Buffer.from('not-png'), 'image/png', root), /内容与格式不匹配/);
  } finally { fs.rmSync(root, { recursive: true }); }
});
