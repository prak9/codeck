import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const IMAGE_EXTENSION = /\.(?:png|jpe?g|gif|webp)$/iu;

function imagePath(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u001f]/u.test(value)) return null;
  if (/^https?:\/\//iu.test(value)) {
    try {
      const url = new URL(value);
      return !url.username && !url.password && IMAGE_EXTENSION.test(url.pathname) ? url.href : null;
    } catch { return null; }
  }
  const local = value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
  return local.startsWith('/') && !local.startsWith('//') && IMAGE_EXTENSION.test(local) ? path.resolve(local) : null;
}

export function imageReferences(item) {
  const images = [];
  const seen = new Set();
  const add = (value, alt = '', span = {}) => {
    const file = imagePath(value);
    if (!file || seen.has(file) || images.length >= 32) return;
    seen.add(file);
    images.push({ path: file, alt: alt || file.split('/').at(-1), ...span });
  };
  if (item?.type === 'imageView') add(item.path);
  if (['dynamicToolCall', 'mcpToolCall'].includes(item?.type)
    && /(?:^|[._])view_image$/u.test(item.tool || item.name || '')) {
    let args = item.arguments || item.input;
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = null; } }
    add(args?.path);
  }
  if (item?.type === 'userMessage') {
    for (const part of Array.isArray(item.content) ? item.content : []) {
      if (part?.type === 'localImage') add(part.path);
      if (part?.type === 'image') add(part.url || part.image_url);
    }
  }
  if (!['agentMessage', 'userMessage'].includes(item?.type)) return images;
  const text = typeof item.text === 'string' ? item.text
    : typeof item.content === 'string' ? item.content
    : (Array.isArray(item.content) ? item.content : []).map(part => part?.text || '').join('\n');
  // Do not turn code examples into filesystem reads. Keep offsets in the original
  // message so the client can insert previews without interpreting arbitrary HTML.
  const searchable = text.replace(/```[^]*?(?:```|$)|~~~[^]*?(?:~~~|$)|`[^`\n]*`/gu, match => ' '.repeat(match.length));
  for (const match of searchable.matchAll(/!?\[([^\[\]\n]*)\]\((?:<([^<>\[\]\n]+)>|([^\s()[\]]+))(?:\s+"[^"\n]*")?\)/gu)) {
    let target = match[2] || match[3];
    try { target = decodeURI(target); } catch { /* Preserve literal file names. */ }
    add(target, match[1], { start: match.index, end: match.index + match[0].length });
  }
  // A standalone local image path also counts as an explicit reference.
  for (const match of searchable.matchAll(/^(?:[ \t]*)(\/(?!\/)[^\n]+\.(?:png|jpe?g|gif|webp))[ \t]*$/gimu)) add(match[1]);
  return images;
}

function imageMime(header) {
  if (header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (header[0] === 255 && header[1] === 216 && header[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(header.subarray(0, 6).toString())) return 'image/gif';
  if (header.subarray(0, 4).toString() === 'RIFF' && header.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}

export function createAgentImages(secret, { maxBytes = 20 * 1024 * 1024 } = {}) {
  const sign = encoded => crypto.createHmac('sha256', secret).update(`codeck-image-v1:${encoded}`).digest('base64url');
  const describe = refs => refs.map(ref => {
    if (/^https?:\/\//u.test(ref.path)) return { ...ref, url: ref.path };
    const encoded = Buffer.from(ref.path).toString('base64url');
    return { ...ref, url: `/api/agent-images/${encoded}.${sign(encoded)}` };
  });
  const decorate = value => {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(decorate);
    let result = value;
    const refs = imageReferences(value);
    if (refs.length) result = { ...result, codeckImages: describe(refs) };
    // Protocol containers only: never walk arbitrary tool arguments/results.
    for (const key of ['thread', 'turn', 'turns', 'items', 'item', 'params']) {
      if (value[key] && typeof value[key] === 'object') {
        const child = decorate(value[key]);
        if (child !== value[key]) result = { ...result, [key]: child };
      }
    }
    return result;
  };
  const serve = async (req, res) => {
    let handle;
    try {
      const token = String(req.params.token || '');
      const [encoded, signature, extra] = token.split('.');
      const expected = sign(encoded || '');
      if (extra || !signature || signature.length !== expected.length
        || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
        return res.status(403).json({ error: '图片访问凭证无效' });
      }
      const file = Buffer.from(encoded, 'base64url').toString();
      if (imagePath(file) !== file || !path.isAbsolute(file)) return res.status(403).json({ error: '图片路径无效' });
      // Never follow a substituted final symlink, serve SVG/HTML, or read an
      // unbounded file. The capability grants one explicit image, not a directory.
      handle = await fsp.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size < 12 || stat.size > maxBytes) return res.status(413).json({ error: '图片过大或不是普通图片文件' });
      const header = Buffer.alloc(16);
      await handle.read(header, 0, header.length, 0);
      const mime = imageMime(header);
      if (!mime) return res.status(415).json({ error: '不支持的图片格式' });
      res.set({ 'Content-Type': mime, 'Content-Length': String(stat.size), 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
      const stream = handle.createReadStream({ start: 0, end: stat.size - 1 });
      handle = null; // The stream now owns/ closes this descriptor.
      res.on('close', () => stream.destroy());
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    } catch (error) {
      if (!res.headersSent) res.status(error.code === 'ENOENT' ? 404 : 403).json({ error: '图片不存在或无法读取' });
      else res.destroy();
    } finally { await handle?.close(); }
  };
  return { decorate, describe, serve };
}
