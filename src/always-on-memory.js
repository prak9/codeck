import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const BASELINE_FILES = new Set(['instructions.md', 'index.md', 'reported.md']);
const SUBDIRS = new Set(['notes', 'progress', 'archive']);
const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}\.md$/;
const LOCK_MARKER = '<!-- locked -->';
const DEFAULT_MAX_BASELINE_BYTES = 16 * 1024;
const MAX_REPORTED_ENTRIES = 40;

const DEFAULT_INSTRUCTIONS = `# 个人长期指令（User Instructions）

- 汇报以结果和可验证证据为主，不把本轮模型回复结束当作目标完成。
- 外部不可逆操作、公网分享或超预算执行前必须先请示确认。
- 凭据与密钥不得写入记忆、报告或页面。
`;

const DEFAULT_INDEX = `# 记忆索引（Memory Index）

## 活跃任务（progress/）
- 暂无记录

## 用户偏好与纠错（notes/）
- 暂无记录
`;

const DEFAULT_REPORTED = `# 已汇报记录（Reported）

`;

export function normalizeMemoryPath(relPath) {
  const clean = String(relPath || '').trim().replaceAll('\\', '/').replace(/^\/+/, '');
  if (!clean || clean.includes('..') || clean.includes('\0')) throw new Error('非法的记忆文件路径');
  if (BASELINE_FILES.has(clean)) return clean;
  const parts = clean.split('/');
  if (parts.length !== 2 || !SUBDIRS.has(parts[0]) || !SAFE_NAME.test(parts[1])) {
    throw new Error('记忆路径仅允许基线文件或 notes/、progress/、archive/ 下的 .md 文件');
  }
  return `${parts[0]}/${parts[1]}`;
}

async function atomicWrite(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, content, { mode: 0o600, encoding: 'utf8' });
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}

export function createMemoryStore({ directory, maxBaselineBytes = DEFAULT_MAX_BASELINE_BYTES }) {
  async function ensureInitialized() {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    for (const sub of SUBDIRS) {
      await fs.mkdir(path.join(directory, sub), { recursive: true, mode: 0o700 });
    }
    const defaults = [
      ['instructions.md', DEFAULT_INSTRUCTIONS],
      ['index.md', DEFAULT_INDEX],
      ['reported.md', DEFAULT_REPORTED],
    ];
    for (const [name, body] of defaults) {
      const full = path.join(directory, name);
      try { await fs.access(full); }
      catch (e) { if (e.code === 'ENOENT') await atomicWrite(full, body); else throw e; }
    }
  }

  async function readFile(relPath) {
    await ensureInitialized();
    const norm = normalizeMemoryPath(relPath);
    const full = path.join(directory, norm);
    const content = await fs.readFile(full, 'utf8');
    return {
      path: norm,
      content,
      bytes: Buffer.byteLength(content, 'utf8'),
      locked: content.includes(LOCK_MARKER),
    };
  }

  async function writeFile(relPath, content) {
    await ensureInitialized();
    const norm = normalizeMemoryPath(relPath);
    if (typeof content !== 'string') throw new Error('记忆内容必须为字符串');
    if (Buffer.byteLength(content, 'utf8') > 64 * 1024) throw new Error('单个记忆文件不能超过 64KB');
    const full = path.join(directory, norm);
    await atomicWrite(full, content);
    if (norm.startsWith('notes/') || norm.startsWith('progress/')) {
      await rebuildIndex();
    }
    return {
      path: norm,
      bytes: Buffer.byteLength(content, 'utf8'),
      locked: content.includes(LOCK_MARKER),
    };
  }

  async function deleteFile(relPath) {
    await ensureInitialized();
    const norm = normalizeMemoryPath(relPath);
    if (BASELINE_FILES.has(norm)) throw new Error('基线记忆文件不可删除');
    const full = path.join(directory, norm);
    try {
      await fs.unlink(full);
      await rebuildIndex();
      return true;
    } catch (e) {
      if (e.code === 'ENOENT') return false;
      throw e;
    }
  }

  async function listDirEntries(sub) {
    const dir = path.join(directory, sub);
    let entries = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    const items = [];
    for (const entry of entries) {
      if (!entry.isFile() || !SAFE_NAME.test(entry.name)) continue;
      const rel = `${sub}/${entry.name}`;
      const full = path.join(directory, rel);
      const stat = await fs.stat(full);
      const text = await fs.readFile(full, 'utf8');
      const firstHeading = text.split('\n').find(l => l.trim().startsWith('#'))?.replace(/^#+\s*/, '').trim() || entry.name;
      items.push({
        path: rel,
        group: sub,
        title: firstHeading,
        bytes: stat.size,
        updatedAt: stat.mtimeMs,
        locked: text.includes(LOCK_MARKER),
      });
    }
    items.sort((a, b) => a.path.localeCompare(b.path));
    return items;
  }

  async function listFiles() {
    await ensureInitialized();
    const baseline = [];
    let baselineBytes = 0;
    for (const name of ['instructions.md', 'index.md', 'reported.md']) {
      const full = path.join(directory, name);
      const stat = await fs.stat(full);
      const text = await fs.readFile(full, 'utf8');
      baselineBytes += stat.size;
      baseline.push({
        path: name,
        group: 'baseline',
        title: name,
        bytes: stat.size,
        updatedAt: stat.mtimeMs,
        locked: text.includes(LOCK_MARKER),
      });
    }
    const [notes, progress, archive] = await Promise.all([
      listDirEntries('notes'),
      listDirEntries('progress'),
      listDirEntries('archive'),
    ]);
    return {
      baseline,
      notes,
      progress,
      archive,
      baselineBytes,
      maxBaselineBytes,
      withinBudget: baselineBytes <= maxBaselineBytes,
    };
  }

  async function readBaseline() {
    await ensureInitialized();
    const [instructions, index, reported] = await Promise.all([
      fs.readFile(path.join(directory, 'instructions.md'), 'utf8'),
      fs.readFile(path.join(directory, 'index.md'), 'utf8'),
      fs.readFile(path.join(directory, 'reported.md'), 'utf8'),
    ]);
    const bytes = Buffer.byteLength(instructions + index + reported, 'utf8');
    return {
      instructions,
      index,
      reported,
      bytes,
      maxBaselineBytes,
      withinBudget: bytes <= maxBaselineBytes,
    };
  }

  async function rebuildIndex() {
    const [progress, notes] = await Promise.all([listDirEntries('progress'), listDirEntries('notes')]);
    const lines = ['# 记忆索引（Memory Index）', '', '## 活跃任务（progress/）'];
    if (!progress.length) lines.push('- 暂无记录');
    else for (const item of progress) lines.push(`- \`${item.path}\`: ${item.title}`);
    lines.push('', '## 用户偏好与纠错（notes/）');
    if (!notes.length) lines.push('- 暂无记录');
    else for (const item of notes) lines.push(`- \`${item.path}\`: ${item.title}${item.locked ? ' [locked]' : ''}`);
    lines.push('');
    await atomicWrite(path.join(directory, 'index.md'), lines.join('\n'));
    return { progressCount: progress.length, notesCount: notes.length };
  }

  async function appendReported({ title, summary, ref = '', at = new Date().toISOString() }) {
    await ensureInitialized();
    const full = path.join(directory, 'reported.md');
    const existing = await fs.readFile(full, 'utf8');
    const entryLine = `- [${at}] **${String(title || '').trim()}**: ${String(summary || '').trim()}${ref ? ` (${ref})` : ''}`;
    const existingLines = existing.split('\n').filter(l => l.startsWith('- '));
    // Deduplicate by title+summary suffix
    const signature = `**${String(title || '').trim()}**: ${String(summary || '').trim()}`;
    if (existingLines.some(l => l.includes(signature))) return { appended: false, count: existingLines.length };
    const kept = [...existingLines, entryLine].slice(-MAX_REPORTED_ENTRIES);
    await atomicWrite(full, `# 已汇报记录（Reported）\n\n${kept.join('\n')}\n`);
    return { appended: true, count: kept.length };
  }

  async function runDreaming({ now = Date.now() } = {}) {
    await ensureInitialized();
    const archived = [];
    const dedupedNotes = [];

    // 1. Archive completed progress files (unless locked)
    const progressItems = await listDirEntries('progress');
    for (const item of progressItems) {
      if (item.locked) continue;
      const text = await fs.readFile(path.join(directory, item.path), 'utf8');
      if (/^status:\s*(done|completed|完成)\s*$/im.test(text)) {
        const destRel = `archive/${path.basename(item.path)}`;
        await atomicWrite(path.join(directory, destRel), text);
        await fs.unlink(path.join(directory, item.path));
        archived.push({ from: item.path, to: destRel });
      }
    }

    // 2. Deduplicate identical bullet lines in unlocked notes
    const noteItems = await listDirEntries('notes');
    for (const item of noteItems) {
      if (item.locked) continue;
      const full = path.join(directory, item.path);
      const text = await fs.readFile(full, 'utf8');
      const seen = new Set();
      const out = [];
      let removed = 0;
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('- ')) {
          if (seen.has(trimmed)) { removed++; continue; }
          seen.add(trimmed);
        }
        out.push(line);
      }
      if (removed > 0) {
        await atomicWrite(full, out.join('\n'));
        dedupedNotes.push({ path: item.path, removed });
      }
    }

    // 3. Prune reported.md to latest MAX_REPORTED_ENTRIES
    const reportedFull = path.join(directory, 'reported.md');
    const reportedText = await fs.readFile(reportedFull, 'utf8');
    const reportedLines = reportedText.split('\n').filter(l => l.startsWith('- '));
    let prunedReported = 0;
    if (reportedLines.length > MAX_REPORTED_ENTRIES) {
      prunedReported = reportedLines.length - MAX_REPORTED_ENTRIES;
      const kept = reportedLines.slice(-MAX_REPORTED_ENTRIES);
      await atomicWrite(reportedFull, `# 已汇报记录（Reported）\n\n${kept.join('\n')}\n`);
    }

    const indexStats = await rebuildIndex();
    return {
      archived,
      dedupedNotes,
      prunedReported,
      ...indexStats,
      ranAt: now,
    };
  }

  return {
    directory,
    ensureInitialized,
    readBaseline,
    listFiles,
    readFile,
    writeFile,
    deleteFile,
    appendReported,
    rebuildIndex,
    runDreaming,
  };
}
