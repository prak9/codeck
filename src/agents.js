import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const LOG_SCAN_TTL_MS = 5_000;
let codexCache = { expires: 0, names: new Map(), starts: [] };
const logFileCache = new Map();
const agentActivityCache = new Map();
const HOME_CACHE_TTL_MS = 5_000;

export function parseCodexSessionIndex(content) {
  const names = new Map();
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line);
      if (item.id && item.thread_name) names.set(item.id, item.thread_name);
    } catch { /* Ignore a partially written final line. */ }
  }
  return names;
}

export function parseRolloutFilename(filename) {
  const match = filename.match(new RegExp(`rollout-(\\d{4}-\\d{2}-\\d{2}T\\d{2})-(\\d{2})-(\\d{2})-(${UUID})\\.jsonl$`));
  if (!match) return null;
  return { id: match[4], startedAt: new Date(`${match[1]}:${match[2]}:${match[3]}`).getTime() };
}

export function parseProcessList(output, now = Date.now()) {
  return output.trim().split('\n').flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), startedAt: now - Number(match[3]) * 1000, command: match[4] }] : [];
  });
}

export function agentKindFromCommand(command) {
  if (/(?:^|[ /])codex(?:\s|$)/i.test(command) && !/app-server/.test(command)) return 'codex';
  if (/(?:^|[ /])claude(?:\s|$)/i.test(command)) return 'claude';
  if (/(?:^|[ /])qodercli(?:\s|$)/i.test(command)) return 'qodercli';
  return null;
}

export function parseCodexRename(output) {
  const matches = [...output.matchAll(new RegExp(`Session renamed to (.+?)\\. To resume this session[\\s\\S]*?\\((${UUID})\\)`, 'g'))];
  return matches.length ? { name: matches.at(-1)[1].trim(), id: matches.at(-1)[2] } : null;
}

function walkFiles(root, accept, results = []) {
  if (!fs.existsSync(root)) return results;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) walkFiles(target, accept, results);
    else if (accept(entry.name)) results.push(target);
  }
  return results;
}

function isLogFile(name) {
  return name.endsWith('.jsonl') || name.endsWith('.json');
}

function getLoggedFileList(homeRoot, now = Date.now()) {
  const key = String(homeRoot);
  const cached = logFileCache.get(key);
  if (cached && cached.expires > now) return cached.files;

  const files = walkFiles(homeRoot, isLogFile)
    .map((file) => {
      try {
        const stat = fs.statSync(file);
        return { path: file, mtime: Number(stat.mtimeMs) };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);

  const next = { expires: now + HOME_CACHE_TTL_MS, files };
  logFileCache.set(key, next);
  return files;
}

function fileContainsAny(filePath, needles, chunkSize = 128 * 1024) {
  const normalized = (needles || []).map((item) => String(item)).filter(Boolean);
  if (!normalized.length) return false;
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    const size = Number(stat.size);
    if (!Number.isFinite(size) || size <= 0) return false;
    const buffer = Buffer.alloc(Math.min(chunkSize, size));
    let offset = 0;
    let carry = '';
    while (offset < size) {
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, offset);
      if (!bytes) break;
      const chunk = carry + buffer.toString('utf8', 0, bytes);
      for (const needle of normalized) {
        if (chunk.includes(needle)) return true;
      }
      const maxNeedle = normalized.reduce((max, item) => Math.max(max, item.length), 0);
      carry = maxNeedle > 1 ? chunk.slice(-maxNeedle + 1) : '';
      offset += bytes;
    }
    return false;
  } catch {
    return false;
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch { /* Ignore. */ }
  }
}

function isCandidateTokenMatch(filePath, token) {
  if (!token) return false;
  const fileName = path.basename(filePath);
  const tokenString = String(token);
  if (fileName.includes(tokenString)) return true;
  const slash = path.sep;
  const escaped = tokenString
    .replaceAll('\\', '/')
    .replaceAll('.', '\\.')
    .replaceAll('+', '\\+')
    .replaceAll('?', '\\?')
    .replaceAll('*', '\\*')
    .replaceAll('(', '\\(')
    .replaceAll(')', '\\)')
    .replaceAll('[', '\\[')
    .replaceAll(']', '\\]')
    .replaceAll('{', '\\{')
    .replaceAll('}', '\\}')
    .replaceAll('$', '\\$')
    .replaceAll('^', '\\^');
  const tokenPath = `${slash}${escaped}${slash}`;
  return filePath.includes(tokenPath) || filePath.includes(tokenString);
}

function latestActivityMtimeForThreadId(homeRoot, threadId, now = Date.now()) {
  const id = String(threadId || '').trim();
  if (!id) return null;
  const cacheKey = `${homeRoot}|${id}`;
  const cached = agentActivityCache.get(cacheKey);
  if (cached && cached.expires > now) return cached.mtime;

  const files = getLoggedFileList(homeRoot, now);
  let latest = null;
  for (const item of files) {
    if (isCandidateTokenMatch(item.path, id)) {
      latest = Math.max(latest ?? -Infinity, item.mtime);
      break;
    }
  }

  if (latest == null) {
    for (const item of files) {
      if (fileContainsAny(item.path, [`\"thread_id\":\"${id}\"`, `\"parent_thread_id\":\"${id}\"`, `\"session_id\":\"${id}\"`, id])) {
        latest = Math.max(latest ?? -Infinity, item.mtime);
        break;
      }
    }
  }

  if (latest === null || !Number.isFinite(latest)) {
    latest = null;
  }
  agentActivityCache.set(cacheKey, { expires: now + LOG_SCAN_TTL_MS, mtime: latest });
  return latest;
}

function loadCodexSessions(codexHome) {
  if (codexCache.expires > Date.now()) return codexCache;
  let names = new Map();
  try { names = parseCodexSessionIndex(fs.readFileSync(path.join(codexHome, 'session_index.jsonl'), 'utf8')); } catch { /* No index yet. */ }
  const starts = walkFiles(path.join(codexHome, 'sessions'), (name) => name.startsWith('rollout-') && name.endsWith('.jsonl'))
    .map(parseRolloutFilename).filter(Boolean);
  codexCache = { expires: Date.now() + 15_000, names, starts };
  return codexCache;
}

function descendants(rootPid, processes) {
  const result = [];
  const queue = [rootPid];
  while (queue.length) {
    const parent = queue.shift();
    for (const process of processes) {
      if (process.ppid === parent) {
        result.push(process);
        queue.push(process.pid);
      }
    }
  }
  return result;
}

function nearestCodexId(startedAt, starts) {
  const candidate = starts.reduce((best, item) => {
    const distance = Math.abs(item.startedAt - startedAt);
    return !best || distance < best.distance ? { id: item.id, distance } : best;
  }, null);
  return candidate?.distance <= 120_000 ? candidate.id : null;
}

function findClaudeSlug(sessionId, claudeHome) {
  if (!sessionId) return null;
  const file = walkFiles(path.join(claudeHome, 'projects'), (name) => name === `${sessionId}.jsonl`)[0];
  if (!file) return null;
  const size = fs.statSync(file).size;
  const length = Math.min(size, 128 * 1024);
  const buffer = Buffer.alloc(length);
  const descriptor = fs.openSync(file, 'r');
  try { fs.readSync(descriptor, buffer, 0, length, size - length); } finally { fs.closeSync(descriptor); }
  const slugs = [...buffer.toString('utf8').matchAll(/"slug"\s*:\s*"([^"]+)"/g)];
  return slugs.at(-1)?.[1] || null;
}

async function readCodexPaneIdentity(session) {
  try {
    const { stdout } = await exec('tmux', ['capture-pane', '-p', '-t', `${session}:`, '-S', '-500']);
    return parseCodexRename(stdout);
  } catch { return null; }
}

export function resolveAgentSessionActivity(agent, env = process.env, fallbackSessionName = null) {
  const now = Date.now();
  if (!agent?.kind) return null;

  const candidates = [
    agent.id,
    agent.name,
    fallbackSessionName,
  ].map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean);

  const uniqueCandidates = [...new Set(candidates)];

  if (agent.kind === 'codex') {
    const codexHome = env.CODEX_HOME || path.join(os.homedir(), '.codex');
    let latest = null;
    for (const candidate of uniqueCandidates) {
      const activityMtime = latestActivityMtimeForThreadId(codexHome, candidate, now);
      if (Number.isFinite(activityMtime)) {
        latest = Math.max(latest ?? -Infinity, activityMtime);
      }
    }
    return latest;
  }

  if (agent.kind === 'claude') {
    const claudeHome = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    let latest = null;
    for (const candidate of uniqueCandidates) {
      const activityMtime = latestActivityMtimeForThreadId(claudeHome, candidate, now);
      if (Number.isFinite(activityMtime)) {
        latest = Math.max(latest ?? -Infinity, activityMtime);
      }
    }
    return latest;
  }

  if (agent.kind === 'qodercli') {
    const qoderHome = env.QODER_HOME || path.join(os.homedir(), '.qoder');
    let latest = null;
    for (const candidate of uniqueCandidates) {
      const activityMtime = latestActivityMtimeForThreadId(qoderHome, candidate, now);
      if (Number.isFinite(activityMtime)) {
        latest = Math.max(latest ?? -Infinity, activityMtime);
      }
    }
    return latest;
  }

  return null;
}

export async function detectPaneAgents(panes, env = process.env) {
  if (!panes.length) return new Map();
  const { stdout } = await exec('ps', ['-eo', 'pid=,ppid=,etimes=,args=']);
  const processes = parseProcessList(stdout);
  const codexHome = env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const claudeHome = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const codex = loadCodexSessions(codexHome);
  const agents = new Map();

  for (const pane of panes) {
    const tree = descendants(pane.pid, processes);
    const process = tree.find((item) => agentKindFromCommand(item.command));
    if (!process) continue;
    const kind = agentKindFromCommand(process.command);

    if (kind === 'codex') {
      const resumed = process.command.match(new RegExp(`\\bresume\\s+(${UUID})`, 'i'))?.[1];
      let id = resumed || nearestCodexId(process.startedAt, codex.starts);
      let name = codex.names.get(id) || null;
      if (!name && !id) {
        const paneIdentity = await readCodexPaneIdentity(pane.session);
        id = paneIdentity?.id || id;
        name = paneIdentity?.name || codex.names.get(id) || null;
      }
      agents.set(pane.session, { kind: 'codex', id, name });
    } else if (kind === 'claude') {
      const id = process.command.match(new RegExp(`(?:--resume(?:=|\\s+)|-r\\s+)(${UUID})`, 'i'))?.[1] || null;
      const name = findClaudeSlug(id, claudeHome) || pane.session;
      agents.set(pane.session, { kind: 'claude', id, name });
    } else {
      agents.set(pane.session, { kind: 'qodercli', id: null, name: pane.session });
    }
  }
  return agents;
}
