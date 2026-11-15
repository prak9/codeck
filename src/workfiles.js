import fs from 'node:fs/promises';
import { createReadStream, constants } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { normalizeEvidence } from './page-evidence.js';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const downloadSecret = crypto.randomBytes(32);
const workfilesEpoch = crypto.randomUUID();
const downloadPath = /^\/sessions\/[a-zA-Z0-9_.-]+\/workfiles\/[a-f\d]{32}\/[a-f\d-]{36}$/u;
export const isWorkfileDownloadRequest = req => req.method === 'GET' && downloadPath.test(req.path)
  && typeof req.query.identity === 'string' && /^[a-f\d]{64}$/u.test(req.query.identity);
const signature = (pathname, identity, expires) => crypto.createHmac('sha256', downloadSecret).update(JSON.stringify([pathname, identity, expires])).digest('hex');
export function workfileDownloadAuthorized(req) {
  const { identity, expires, download } = req.query;
  if (![identity, expires, download].every(value => typeof value === 'string')
    || !isWorkfileDownloadRequest(req)
    || !/^[a-f\d]{64}$/u.test(download || '') || !/^\d{13}$/u.test(expires || '') || Number(expires) < Date.now()) return false;
  return crypto.timingSafeEqual(Buffer.from(download, 'hex'), Buffer.from(signature(req.path, identity, expires), 'hex'));
}
export const workfileIdentity = session => hash(JSON.stringify([session.name, session.createdAt, session.agent?.kind, session.agent?.id]));
const inside = (root, file) => { const relative = path.relative(root, file); return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
function text(value, label, max = 256) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw fail(`${label}格式无效`);
  return value.trim();
}
function safeUrl(value) {
  if (/^\/pages\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u.test(value)) return value;
  let url; try { url = new URL(value); } catch { throw fail('请提供完整的 HTTPS 地址'); }
  if (url.protocol !== 'https:' || url.username || url.password || /[\s\\]/u.test(value)) throw fail('仅支持不含凭据的 HTTPS 地址');
  return url.href;
}

export function createWorkfiles(directory, { uploadRoot } = {}) {
  directory = path.resolve(directory);
  const queues = new Map();
  const fileFor = session => path.join(directory, `${workfileIdentity(session)}.json`);
  const sessionInfo = session => ({ name: session.name, createdAt: session.createdAt,
    agent: session.agent ? { kind: session.agent.kind, id: session.agent.id } : null });
  async function save(session, records) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${fileFor(session)}.${crypto.randomUUID()}.tmp`;
    try { await fs.writeFile(temporary, JSON.stringify({ session: sessionInfo(session), items: records }), { mode: 0o600 }); await fs.rename(temporary, fileFor(session)); }
    finally { await fs.rm(temporary, { force: true }); }
  }
  async function list(session) {
    try { return JSON.parse(await fs.readFile(fileFor(session), 'utf8')).items; }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  function put(session, value) {
    const scope = workfileIdentity(session);
    const operation = (queues.get(scope) || Promise.resolve()).catch(() => {}).then(async () => {
      const key = text(value.key, '标识', 1000), title = text(value.title, '标题');
      if (!['source', 'result'].includes(value.kind)) throw fail('请选择资料或成果');
      if (Boolean(value.url) === Boolean(value.path)) throw fail('请提供一个链接或文件路径');
      const group = value.group ? text(value.group, '工作主题') : '当前工作';
      const revision = value.revision ? text(value.revision, '版本') : '';
      const date = value.date ? text(value.date, '资料日期', 64) : '';
      const version = { id: crypto.randomUUID(), at: new Date().toISOString(), revision, date };
      const records = await list(session), id = hash(`${value.kind}:${key}`).slice(0, 32);
      const prior = records.find(item => item.id === id);
      let blob;
      try {
        if (value.url) version.url = safeUrl(text(value.url, '链接', 4000));
        else {
          const inputPath = text(value.path, '文件路径', 4000);
          if (!path.isAbsolute(inputPath)) throw fail('文件路径必须是绝对路径');
          const source = await fs.realpath(inputPath);
          const roots = await Promise.all([session.agent?.cwd || session.cwd, uploadRoot].filter(Boolean).map(root => fs.realpath(root).catch(error => {
            if (error.code === 'ENOENT') return null; throw error;
          })));
          if (!roots.some(root => root && inside(root, source))) throw fail('文件必须在当前项目或上传目录内', 403);
          const before = await fs.stat(source);
          if (!before.isFile()) throw fail('只能登记文件');
          await fs.mkdir(path.join(directory, 'files'), { recursive: true, mode: 0o700 });
          blob = path.join(directory, 'files', version.id);
          await fs.copyFile(source, blob, constants.COPYFILE_FICLONE);
          await fs.chmod(blob, 0o600);
          const after = await fs.stat(source);
          if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) throw fail('文件正在变化，请写入完成后重新登记', 409);
          const digest = crypto.createHash('sha256');
          for await (const chunk of createReadStream(blob)) digest.update(chunk);
          version.contentHash = digest.digest('hex');
          version.fileName = path.basename(source); version.sourcePath = source; version.size = before.size;
          version.sourceStat = { size: before.size, mtimeMs: before.mtimeMs, ino: before.ino };
        }
        if (value.evidence !== undefined) version.evidence = normalizeEvidence(value.evidence, version.contentHash);
        const previous = prior?.versions.at(-1);
        const evidenceKey = evidence => evidence && JSON.stringify([evidence.version, evidence.summary, evidence.checks, evidence.limitations]);
        const same = previous && previous.url === version.url && previous.contentHash === version.contentHash
          && previous.sourcePath === version.sourcePath && previous.fileName === version.fileName
          && previous.revision === revision && previous.date === date
          && (value.evidence === undefined || evidenceKey(previous.evidence) === evidenceKey(version.evidence));
        if (same && version.sourceStat) previous.sourceStat = version.sourceStat;
        const record = { id, key, kind: value.kind, title, group, updatedAt: version.at,
          versions: same ? prior.versions : [...(prior?.versions || []), version] };
        const next = records.filter(item => item.id !== id); next.unshift(record);
        await save(session, next);
        if (same && blob) await fs.rm(blob, { force: true });
        return record;
      } catch (error) { if (blob) await fs.rm(blob, { force: true }); throw error; }
    });
    queues.set(scope, operation);
    return operation.finally(() => { if (queues.get(scope) === operation) queues.delete(scope); });
  }
  return { list, put, async sourceState(version) {
    if (!version.sourcePath || !version.sourceStat) return 'unknown';
    try {
      const stat = await fs.stat(version.sourcePath), baseline = version.sourceStat;
      return stat.isFile() && stat.size === baseline.size && stat.mtimeMs === baseline.mtimeMs && stat.ino === baseline.ino ? 'unchanged' : 'changed';
    } catch (error) { return error.code === 'ENOENT' ? 'missing' : 'unavailable'; }
  }, async archived(name, identity) {
    if (!/^[a-f\d]{64}$/u.test(identity || '')) throw fail('归档标识无效');
    let value;
    try { value = JSON.parse(await fs.readFile(path.join(directory, `${identity}.json`), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') throw fail('归档不存在', 404); throw error; }
    if (value.session.name !== name || workfileIdentity(value.session) !== identity) throw fail('归档不属于此会话', 404);
    return value.session;
  }, async archives(name) {
    let files; try { files = await fs.readdir(directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const entries = [];
    for (const file of files) if (/^[a-f\d]{64}\.json$/u.test(file)) {
      const value = JSON.parse(await fs.readFile(path.join(directory, file), 'utf8'));
      if (value.session.name === name) entries.push({ identity: file.slice(0, -5), at: value.items[0]?.updatedAt, session: value.session });
    }
    return entries.sort((a, b) => (b.at || '').localeCompare(a.at || ''));
  }, edit(session, id, value) {
    const scope = workfileIdentity(session);
    const operation = (queues.get(scope) || Promise.resolve()).catch(() => {}).then(async () => {
      const records = await list(session), record = records.find(item => item.id === id);
      if (!record) throw fail('记录不存在', 404);
      record.title = text(value.title, '标题'); record.group = text(value.group, '工作主题');
      await save(session, records);
      return record;
    });
    queues.set(scope, operation);
    return operation.finally(() => { if (queues.get(scope) === operation) queues.delete(scope); });
  }, async file(session, id, versionId) {
    const record = (await list(session)).find(item => item.id === id);
    const version = record?.versions.find(item => item.id === versionId);
    if (!version?.fileName || !/^[a-f\d-]{36}$/u.test(version.id)) throw fail('文件版本不存在', 404);
    return path.join(directory, 'files', version.id);
  } };
}

export function mountWorkfiles(app, { store, pages, sessions, ownerOnly }) {
  const route = '/api/sessions/:name/workfiles';
  async function resolve(req) {
    if (req.method === 'GET' && req.query.archive) return store.archived(req.params.name, req.query.archive);
    const session = (await sessions()).find(item => item.name === req.params.name);
    if (!session) throw fail('会话不存在', 404);
    if ((req.query.workCreated !== undefined && String(session.createdAt) !== req.query.workCreated)
      || (req.query.workThread !== undefined && (session.agent?.id || '') !== req.query.workThread)
      || (req.query.workProvider !== undefined && (session.agent?.kind || '') !== req.query.workProvider)) {
      throw fail('会话身份已变化，请重新打开工作文件', 409);
    }
    const expected = req.method === 'GET' ? req.query.identity : req.body?.identity;
    if (expected && expected !== workfileIdentity(session)) throw fail('会话身份已变化，请重新打开工作文件', 409);
    return session;
  }
  app.get(route, ownerOnly, async (req, res, next) => {
    try {
      const session = await resolve(req);
      const items = await store.list(session);
      const states = new Map();
      for (const item of items) for (const version of item.versions) if (version.sourcePath) {
        const key = JSON.stringify([version.sourcePath, version.sourceStat]);
        if (!states.has(key)) states.set(key, store.sourceState(version));
        version.sourceState = await states.get(key);
      }
      const published = (session.agent?.id ? await pages.list({ includeEvidence: true }) : []).filter(page => page.source?.session === session.name
        && page.source?.provider === session.agent?.kind && page.source?.threadId === session.agent?.id);
      const archives = await store.archives(session.name);
      const etag = `"${hash(JSON.stringify([workfilesEpoch, workfileIdentity(session), items, published, archives]))}"`;
      res.set({ 'Cache-Control': 'private, no-store', ETag: etag });
      if (req.get('If-None-Match') === etag) return res.status(304).end();
      const identity = workfileIdentity(session), expires = String(Date.now() + 5 * 60_000);
      for (const item of items) for (const version of item.versions) if (version.fileName) {
        const pathname = `/sessions/${encodeURIComponent(session.name)}/workfiles/${item.id}/${version.id}`;
        version.downloadUrl = `/api${pathname}?${new URLSearchParams({ identity, expires, download: signature(pathname, identity, expires) })}`;
      }
      res.json({ identity, items, pages: published, archives });
    } catch (error) { next(error); }
  });
  app.post(route, ownerOnly, async (req, res, next) => {
    try {
      if (!req.body?.identity) throw fail('缺少会话身份，请重新打开工作文件', 409);
      const session = await resolve(req);
      res.status(201).json(await store.put(session, req.body));
    } catch (error) { next(error); }
  });
  app.patch(`${route}/:id`, ownerOnly, async (req, res, next) => {
    try {
      if (!req.body?.identity) throw fail('缺少会话身份', 409);
      res.json(await store.edit(await resolve(req), req.params.id, req.body));
    } catch (error) { next(error); }
  });
  app.get(`${route}/:id/:version`, ownerOnly, async (req, res, next) => {
    try {
      if (!req.query.identity) throw fail('缺少会话身份', 409);
      // Version links retain their explicit old identity after session recreation.
      const session = await store.archived(req.params.name, req.query.identity);
      const record = (await store.list(session)).find(item => item.id === req.params.id);
      const version = record?.versions.find(item => item.id === req.params.version);
      const file = await store.file(session, req.params.id, req.params.version);
      res.set('Cache-Control', 'private, no-store');
      if (req.query.preview === '1') {
        const types = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf' };
        const type = types[path.extname(version.fileName).toLowerCase()] || 'text/plain';
        res.set('Content-Security-Policy', type === 'application/pdf'
          ? "default-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'" : "sandbox; default-src 'none'");
        if (type === 'application/pdf') res.set('X-Frame-Options', 'SAMEORIGIN');
        res.type(type);
        return res.sendFile(file);
      }
      res.download(file, version.fileName);
    } catch (error) { next(error); }
  });
}
