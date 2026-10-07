import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { MAX_ATTACHMENT_BYTES } from '../public/remote-attachments.js';

const EXTENSIONS = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
]);
const SIGNATURES = {
  'image/png': (content) => content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (content) => content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff,
  'image/webp': (content) => content.subarray(0, 4).toString() === 'RIFF' && content.subarray(8, 12).toString() === 'WEBP',
  'image/gif': (content) => ['GIF87a', 'GIF89a'].includes(content.subarray(0, 6).toString()),
};

export const uploadRoot = path.join(os.homedir(), '.codeck', 'uploads');

// Stream to a private sibling first: failed/aborted uploads never replace a file.
export async function saveUploadStream(request, { fileName, relativePath, contentType, root = uploadRoot, maxBytes = MAX_ATTACHMENT_BYTES } = {}) {
  const tooLarge = () => Object.assign(new Error('单个文件不能超过 10 GiB'), { status: 413 });
  if (Number(request.headers?.['content-length']) > maxBytes) throw tooLarge();
  if (request.headers?.['content-encoding'] && request.headers['content-encoding'] !== 'identity') {
    throw Object.assign(new Error('上传不支持压缩请求体'), { status: 415 });
  }
  if (contentType && !EXTENSIONS.has(contentType)) throw new Error('仅支持 PNG、JPEG、WebP 或 GIF 图片格式');
  const target = contentType
    ? resolveUploadPath('', `${Date.now()}-${crypto.randomUUID()}${EXTENSIONS.get(contentType)}`, root)
    : resolveUploadPath(relativePath, fileName, root);
  await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(target), `.upload-${crypto.randomUUID()}.part`);
  let size = 0, header = Buffer.alloc(0);
  const limiter = new Transform({ transform(chunk, _encoding, callback) {
    size += chunk.length;
    if (size > maxBytes) return callback(tooLarge());
    if (header.length < 12) header = Buffer.concat([header, chunk.subarray(0, 12 - header.length)]);
    callback(null, chunk);
  } });
  const abort = () => limiter.destroy(new Error('上传连接已中断'));
  const fail = error => limiter.destroy(error);
  request.once('aborted', abort);
  request.once('error', fail);
  try {
    // Do not put the HTTP request in pipeline: destroying it on a size error
    // would reset the socket before Express can return a useful 413 response.
    const saved = pipeline(limiter, fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
    if (request.destroyed || request.aborted) abort();
    else request.pipe(limiter);
    await saved;
    if (contentType && !size) throw new Error('图片内容为空');
    if (contentType && !SIGNATURES[contentType](header)) throw new Error('图片内容与格式不匹配');
    await fs.promises.rename(temporary, target);
    return target;
  } finally {
    request.unpipe(limiter);
    request.removeListener('aborted', abort);
    request.removeListener('error', fail);
    if (!request.destroyed) request.resume();
    await fs.promises.rm(temporary, { force: true });
  }
}

export function sanitizePathSegment(raw) {
  const normalized = (raw || '').normalize('NFKC').replace(/\r?\n/g, '_');
  const cleaned = normalized
    .replace(/[<>:"|?*\\\/]/g, '_')
    .replace(/[\u0000-\u001f]/g, '')
    .trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return 'item';
  return cleaned;
}

export function resolveUploadPath(relativePath, fileName, root = uploadRoot) {
  const rootDir = path.resolve(root);
  const directoryParts = String(relativePath || '').split(/[\\/]+/).filter(Boolean).map(sanitizePathSegment);
  const safeFileName = sanitizePathSegment(fileName || 'upload');
  const target = path.resolve(rootDir, ...directoryParts, safeFileName);
  const relation = path.relative(rootDir, target);
  if (relation.startsWith('..') || path.isAbsolute(relation)) {
    throw new Error('非法的上传路径');
  }
  return target;
}

export function resolveDownloadPath(rawPath, root = uploadRoot) {
  const rootDir = path.resolve(root);
  const normalized = String(rawPath || '').trim().replace(/^~\//, `${os.homedir()}/`);
  if (!normalized) throw new Error('下载路径不能为空');
  const target = path.isAbsolute(normalized) ? path.resolve(normalized) : path.resolve(rootDir, normalized);
  const relation = path.relative(rootDir, target);
  if (relation.startsWith('..') || relation === '..' || relation === '' && target !== rootDir) {
    throw new Error('非法下载路径');
  }
  if (path.isAbsolute(relation)) throw new Error('非法下载路径');
  return target;
}

export function saveFileUpload(content, fileName, relativePath, root = uploadRoot) {
  if (!Buffer.isBuffer(content)) throw new Error('上传内容必须是二进制数据');
  const target = resolveUploadPath(relativePath, fileName, root);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, content, { mode: 0o600 });
  return target;
}

export function saveImageUpload(content, contentType, root = uploadRoot) {
  const extension = EXTENSIONS.get(contentType);
  if (!extension) throw new Error('仅支持 PNG、JPEG、WebP 或 GIF 图片格式');
  if (!Buffer.isBuffer(content) || !content.length) throw new Error('图片内容为空');
  if (!SIGNATURES[contentType](content)) throw new Error('图片内容与格式不匹配');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const target = path.join(root, `${Date.now()}-${crypto.randomUUID()}${extension}`);
  fs.writeFileSync(target, content, { mode: 0o600 });
  return target;
}
