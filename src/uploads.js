import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
