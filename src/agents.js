import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const AGENT_SESSION_ENV = new Set(['CODEX_THREAD_ID', 'CLAUDE_CODE_SESSION_ID', 'QODER_SESSION_ID']);
const CODEX_HISTORY_READ_LIMIT = 2 * 1024 * 1024;
const CODEX_METADATA_READ_LIMIT = 64 * 1024;
const CODEX_METADATA_CACHE_LIMIT = 256;
const QODER_TRANSCRIPT_READ_LIMIT = 128 * 1024;
const AGENT_IDENTITY_CACHE_TTL_MS = 5_000;
const DETACHED_PROCESS_CACHE_TTL_MS = 5_000;
const CLAUDE_TRANSCRIPT_MISS_TTL_MS = 5_000;
let codexCache = { expires: 0, names: new Map(), starts: [], writers: [], history: [], historySignature: '', cwds: new Map(), previews: new Map() };
const codexPaneSessions = new Map();
const codexRolloutMetadata = new Map();
const claudeTranscriptIndexes = new Map();
const codexHistoryIndexes = new WeakMap();
let clockTicksPromise;

// A cold scan populates every cache entry at once. Spread only their first safety
// audit across the normal TTL; later audits keep the full TTL from their last check.
function initialAuditDelay(key, ttlMs) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 1) return Math.max(0, ttlMs || 0);
  const ttl = Math.floor(ttlMs);
  const floor = Math.min(1_000, ttl - 1);
  let hash = 2_166_136_261;
  for (const character of String(key)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return floor + 1 + (hash >>> 0) % (ttl - floor);
}

function initialAuditDelayByIndex(index, count, ttlMs) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 1) return Math.max(0, ttlMs || 0);
  const ttl = Math.floor(ttlMs);
  const floor = Math.min(1_000, ttl - 1);
  return floor + Math.ceil((ttl - floor) * (index + 1) / Math.max(1, count));
}

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

export function parseCodexPreview(content) {
  for (const line of String(content).split('\n')) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line);
      const payload = item?.type === 'response_item' ? item.payload : null;
      if (payload?.type !== 'message' || payload.role !== 'user' || !Array.isArray(payload.content)) continue;
      const text = payload.content.map((part) => typeof part?.text === 'string' ? part.text : '').join('').trim();
      if (!text || text.startsWith('# AGENTS.md instructions') || /^<environment_context>[\s\S]*<\/environment_context>$/.test(text)) continue;
      return text.split('\n').find((value) => value.trim())?.trim().slice(0, 160) || null;
    } catch { /* Ignore a partially written line. */ }
  }
  return null;
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

// Exported so a regression test can assert the shape: one -o per field, never a single
// comma-joined header.
export const PS_ARGUMENTS = ['-eo', 'pid=', '-o', 'ppid=', '-o', 'etimes=', '-o', 'args='];

let warnedProcessListUnparsed = false;

function warnProcessListUnparsed() {
  if (warnedProcessListUnparsed) return;
  warnedProcessListUnparsed = true;
  console.warn('codeck: ps returned rows this build cannot parse; agent detection is disabled and sessions fall back to their foreground command');
}

export function agentKindFromCommand(command) {
  if (/(?:^|[ /])codex(?:\s|$)/i.test(command) && !/(?:^|\s)app-server(?:\s|$)/i.test(command)) return 'codex';
  if (/(?:^|[ /])claude(?:\s|$)/i.test(command)) return 'claude';
  if (/(?:^|[ /])qodercli(?:\s|$)/i.test(command)) return 'qodercli';
  return null;
}

export function parseResumedSessionId(command) {
  return command.match(new RegExp(`(?:--resume(?:=|\\s+)|-r\\s+|--session-id(?:=|\\s+))(${UUID})`, 'i'))?.[1] || null;
}

export function isQoderResumeCommand(command) {
  return /(?:^|\s)(?:--resume(?=$|[\s=])|-r(?=$|\s)|--continue(?=$|\s))/i.test(command);
}

export function parseRuntimeSessionRegistry(content) {
  try {
    const item = JSON.parse(content);
    if (!new RegExp(`^${UUID}$`, 'i').test(item?.sessionId)) return null;
    return {
      id: item.sessionId,
      cwd: typeof item.cwd === 'string' && item.cwd ? item.cwd : null,
    };
  } catch { return null; }
}

export function parseCodexRename(output) {
  const matches = [...output.matchAll(new RegExp(`Session renamed to (.+?)\\. To resume this session[\\s\\S]*?\\((${UUID})\\)`, 'g'))];
  return matches.length ? { name: matches.at(-1)[1].trim(), id: matches.at(-1)[2] } : null;
}

export function parseCodexHistory(content) {
  const sessionId = new RegExp(`^${UUID}$`, 'i');
  return String(content).split('\n').flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const item = JSON.parse(line);
      const timestamp = Number(item?.ts) * 1000;
      if (!sessionId.test(item?.session_id || '') || !Number.isFinite(timestamp) || typeof item?.text !== 'string' || !item.text.trim()) return [];
      return [{ id: item.session_id, timestamp, text: item.text }];
    } catch { return []; }
  });
}

function stripCodexAnsi(value) {
  return String(value).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}

function compactCodexText(value) {
  return stripCodexAnsi(value).replace(/\s+/gu, '');
}

function codexPromptBlocks(output) {
  const lines = stripCodexAnsi(output).split('\n');
  const prompts = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^›(?:\s(.*)|$)/u);
    if (!match) continue;
    const parts = [match[1] || ''];
    let cursor = index + 1;
    while (cursor < lines.length) {
      const continuation = lines[cursor].match(/^ {2,}(\S.*)$/u);
      if (!continuation) break;
      parts.push(continuation[1]);
      cursor += 1;
    }
    let next = cursor;
    while (next < lines.length && !lines[next].trim()) next += 1;
    if (/^\s*(?:gpt-[\w.-]+|o\d[\w.-]*|codex[\w.-]*)\b.*\s·\s(?:~(?:\/|$)|\/)/i.test(lines[next] || '')) continue;
    const text = compactCodexText(parts.join('\n'));
    if (text) prompts.push({ position: index, text });
  }
  return prompts;
}

function latestCodexPrompt(output) {
  return codexPromptBlocks(output).at(-1)?.text || null;
}

function codexHistoryIndex(history) {
  if (!Array.isArray(history)) return { exact: new Map(), prefixes: new Map() };
  const cached = codexHistoryIndexes.get(history);
  if (cached) return cached;
  const index = { exact: new Map(), prefixes: new Map() };
  for (const item of history) {
    const value = compactCodexText(item?.text);
    if (!value || !item?.id) continue;
    const target = value.length > 320 ? index.prefixes : index.exact;
    const key = value.length > 320 ? value.slice(0, 320) : value;
    const ids = target.get(key) || new Set();
    ids.add(item.id);
    target.set(key, ids);
  }
  codexHistoryIndexes.set(history, index);
  return index;
}

function matchCodexHistorySession(output, history, acceptId = () => true) {
  const prompts = codexPromptBlocks(output);
  const candidatesByPrompt = prompts.map(() => new Set());
  const historyIndex = codexHistoryIndex(history);
  let matched = false;
  for (const [index, prompt] of prompts.entries()) {
    const ids = new Set(historyIndex.exact.get(prompt.text) || []);
    if (prompt.text.length >= 320) {
      for (const id of historyIndex.prefixes.get(prompt.text.slice(0, 320)) || []) ids.add(id);
    }
    if (ids.size) matched = true;
    for (const id of ids) {
      if (acceptId(id)) candidatesByPrompt[index].add(id);
    }
  }
  let candidates = null;
  for (let index = candidatesByPrompt.length - 1; index >= 0; index -= 1) {
    const promptCandidates = candidatesByPrompt[index];
    if (!promptCandidates.size) continue;
    if (!candidates) candidates = new Set(promptCandidates);
    else if (candidates.size > 1) {
      const overlap = new Set([...candidates].filter((id) => promptCandidates.has(id)));
      if (!overlap.size) return { id: null, matched, candidates: overlap };
      candidates = overlap;
    }
    if (candidates.size === 1) return { id: candidates.values().next().value, matched, candidates };
  }
  return { id: null, matched, candidates: candidates || new Set() };
}

export function findCodexHistorySessionId(output, history, acceptId = () => true) {
  return matchCodexHistorySession(output, history, acceptId).id;
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

function readTextTail(file, limit) {
  const descriptor = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(descriptor).size;
    const length = Math.min(size, limit);
    const buffer = Buffer.alloc(length);
    fs.readSync(descriptor, buffer, 0, length, size - length);
    const content = buffer.toString('utf8');
    if (length === size) return content;
    const firstNewline = content.indexOf('\n');
    return firstNewline < 0 ? '' : content.slice(firstNewline + 1);
  } finally { fs.closeSync(descriptor); }
}

function loadCodexSessions(codexHome) {
  const historyFile = path.join(codexHome, 'history.jsonl');
  let historySignature = '';
  try {
    const stat = fs.statSync(historyFile);
    historySignature = `${stat.size}:${stat.mtimeMs}`;
  } catch { /* No history yet. */ }
  if (codexCache.expires > Date.now() && codexCache.historySignature === historySignature) return codexCache;
  let names = new Map();
  try { names = parseCodexSessionIndex(fs.readFileSync(path.join(codexHome, 'session_index.jsonl'), 'utf8')); } catch { /* No index yet. */ }
  const starts = walkFiles(path.join(codexHome, 'sessions'), (name) => name.startsWith('rollout-') && name.endsWith('.jsonl'))
    .flatMap((file) => {
      const parsed = parseRolloutFilename(file);
      return parsed ? [{ ...parsed, file }] : [];
    });
  const writers = walkFiles(path.join(codexHome, 'thread-writer-locks'), (name) => name.endsWith('.lock'))
    .flatMap((file) => {
      const id = path.basename(file).match(new RegExp(`^(${UUID})\\.lock$`, 'i'))?.[1];
      if (!id) return [];
      try { return [{ id, startedAt: fs.statSync(file).mtimeMs }]; }
      catch { return []; }
    });
  let history = [];
  try { history = parseCodexHistory(readTextTail(historyFile, CODEX_HISTORY_READ_LIMIT)); } catch { /* No history yet. */ }
  codexCache = {
    expires: Date.now() + 15_000, names, starts, writers, history, historySignature,
    cwds: codexCache.cwds, previews: codexCache.previews,
  };
  return codexCache;
}

function codexSessionCwd(id, codex) {
  if (!id) return null;
  if (codex.cwds.has(id)) return codex.cwds.get(id);
  const file = codex.starts.find((item) => item.id === id)?.file;
  let cwd = null;
  if (file) {
    try {
      const descriptor = fs.openSync(file, 'r');
      try {
        const size = Math.min(fs.fstatSync(descriptor).size, 64 * 1024);
        const buffer = Buffer.alloc(size);
        fs.readSync(descriptor, buffer, 0, size, 0);
        for (const line of buffer.toString('utf8').split('\n')) {
          if (!line.trim()) continue;
          const item = JSON.parse(line);
          if (item?.type === 'session_meta' && typeof item.payload?.cwd === 'string') {
            cwd = item.payload.cwd;
            break;
          }
        }
      } finally { fs.closeSync(descriptor); }
    } catch { /* The rollout may rotate or contain a partial line. */ }
  }
  if (cwd) codex.cwds.set(id, cwd);
  return cwd;
}

function codexPreview(id, codex) {
  if (!id) return null;
  if (codex.previews.has(id)) return codex.previews.get(id);
  const file = codex.starts.find((item) => item.id === id)?.file;
  let preview = null;
  if (file) {
    try {
      const descriptor = fs.openSync(file, 'r');
      try {
        const size = Math.min(fs.fstatSync(descriptor).size, 512 * 1024);
        const buffer = Buffer.alloc(size);
        fs.readSync(descriptor, buffer, 0, size, 0);
        preview = parseCodexPreview(buffer.toString('utf8'));
      } finally { fs.closeSync(descriptor); }
    } catch { /* The rollout may rotate while sessions are being listed. */ }
  }
  if (preview) codex.previews.set(id, preview);
  return preview;
}

export function paneProcessTree(rootPid, processes) {
  const result = processes.filter((process) => process.pid === rootPid);
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

function isIndependentProcessLeader(process, procRoot) {
  if (Number.isFinite(process?.pgrp) && Number.isFinite(process?.session)) {
    return process.pgrp === process.pid && process.session === process.pid;
  }
  try {
    const stat = parseProcStat(fs.readFileSync(path.join(procRoot, String(process.pid), 'stat'), 'utf8'));
    return stat?.pgrp === process.pid && stat.session === process.pid;
  } catch { return false; }
}

function parseProcStat(content) {
  const open = content.indexOf('(');
  const close = content.lastIndexOf(')');
  if (open < 0 || close <= open) return null;
  const pid = Number(content.slice(0, open).trim());
  const fields = content.slice(close + 1).trim().split(/\s+/);
  const ppid = Number(fields[1]);
  const pgrp = Number(fields[2]);
  const session = Number(fields[3]);
  const startTicks = Number(fields[19] || 0);
  if (![pid, ppid, pgrp, session, startTicks].every(Number.isFinite)) return null;
  return { pid, ppid, pgrp, session, startTicks, name: content.slice(open + 1, close) };
}

function procPidList(content) {
  return String(content || '').trim().split(/\s+/).map(Number).filter(Number.isInteger);
}

function readProcChildren(procRoot, pid) {
  try { return procPidList(fs.readFileSync(path.join(procRoot, String(pid), 'task', String(pid), 'children'), 'utf8')); }
  catch { return []; }
}

function readProcThreadChildren(procRoot, pid) {
  const taskRoot = path.join(procRoot, String(pid), 'task');
  let threads;
  try { threads = fs.readdirSync(taskRoot).filter((entry) => /^\d+$/.test(entry)); }
  catch { return []; }
  const children = new Set();
  for (const thread of threads) {
    let content;
    try { content = fs.readFileSync(path.join(taskRoot, thread, 'children'), 'utf8'); }
    catch { continue; }
    for (const child of procPidList(content)) children.add(child);
  }
  return [...children];
}

function readProcProcess(procRoot, pid, { clockTicks, now, uptimeMs }) {
  let stat;
  try { stat = parseProcStat(fs.readFileSync(path.join(procRoot, String(pid), 'stat'), 'utf8')); }
  catch { return null; }
  if (!stat) return null;
  let command = '';
  try {
    command = fs.readFileSync(path.join(procRoot, String(pid), 'cmdline'), 'utf8')
      .split('\0').filter(Boolean).join(' ').trim();
  } catch { /* Process may exit between the stat and cmdline reads. */ }
  return {
    pid: stat.pid,
    ppid: stat.ppid,
    startTicks: stat.startTicks,
    startedAt: now - Math.max(0, uptimeMs - stat.startTicks / clockTicks * 1000),
    command: command || stat.name,
  };
}

export function readPaneProcessTrees(panes, {
  procRoot = '/proc', clockTicks = 100, now = Date.now(), uptimeMs = 0,
  processTreeCache = null, processTreeCacheTtlMs = AGENT_IDENTITY_CACHE_TTL_MS,
} = {}) {
  const cache = processTreeCache instanceof Map ? processTreeCache : null;
  const cacheTtlMs = Number.isFinite(processTreeCacheTtlMs)
    ? Math.max(0, processTreeCacheTtlMs)
    : AGENT_IDENTITY_CACHE_TTL_MS;
  const byRoot = new Map();
  const trees = new Map();
  for (const pane of panes || []) {
    const cached = cache?.get(pane.session);
    const cacheMatchesPaneIdentity = cached
      && cached.paneId === pane.paneId
      && cached.pid === pane.pid
      && cached.currentCommand === (pane.currentCommand || '');
    const cacheMatchesPane = cacheMatchesPaneIdentity && cached.expiresAt > now;
    if (cacheMatchesPane) {
      const topologyMatches = [...cached.childrenByPid].every(([pid, expected]) => {
        const current = readProcChildren(procRoot, pid);
        return current.length === expected.length
          && current.every((child, index) => child === expected[index]);
      });
      const agentCommandsMatch = topologyMatches && cached.tree.every((process) => (
        !agentKindFromCommand(process.command)
        || readProcCommand(procRoot, process.pid) === process.command
      ));
      if (agentCommandsMatch) {
        trees.set(pane.session, cached.tree);
        continue;
      }
    }

    let observation = byRoot.get(pane.pid);
    if (!observation) {
      const tree = [];
      const childrenByPid = new Map();
      const seen = new Set();
      const queue = [pane.pid];
      while (queue.length) {
        const pid = queue.shift();
        if (!Number.isInteger(pid) || seen.has(pid)) continue;
        seen.add(pid);
        const process = readProcProcess(procRoot, pid, { clockTicks, now, uptimeMs });
        if (!process) continue;
        tree.push(process);
        const children = readProcChildren(procRoot, pid);
        childrenByPid.set(pid, children);
        for (const child of children) {
          if (!seen.has(child)) queue.push(child);
        }
      }
      observation = { tree, childrenByPid };
      byRoot.set(pane.pid, observation);
    }
    trees.set(pane.session, observation.tree);
    if (cache && observation.tree.length) {
      const auditDelay = cacheMatchesPaneIdentity
        ? cacheTtlMs
        : initialAuditDelay(`${pane.session}\0${pane.paneId}\0${pane.pid}`, cacheTtlMs);
      cache.set(pane.session, {
        paneId: pane.paneId,
        pid: pane.pid,
        currentCommand: pane.currentCommand || '',
        expiresAt: now + auditDelay,
        ...observation,
      });
    } else {
      cache?.delete(pane.session);
    }
  }
  if (cache) {
    const activeSessions = new Set((panes || []).map((pane) => pane.session));
    for (const session of cache.keys()) {
      if (!activeSessions.has(session)) cache.delete(session);
    }
  }
  return trees;
}

function readProcCommand(procRoot, pid, fallback = '') {
  try {
    return fs.readFileSync(path.join(procRoot, String(pid), 'cmdline'), 'utf8')
      .split('\0').filter(Boolean).join(' ') || fallback;
  } catch { return fallback; }
}

function readAgentSessionId(procRoot, pid) {
  let entries;
  try { entries = fs.readFileSync(path.join(procRoot, String(pid), 'environ'), 'utf8').split('\0'); }
  catch { return null; }
  for (const entry of entries) {
    const separator = entry.indexOf('=');
    if (separator < 0 || !AGENT_SESSION_ENV.has(entry.slice(0, separator))) continue;
    const id = entry.slice(separator + 1);
    if (new RegExp(`^${UUID}$`, 'i').test(id)) return id;
  }
  return null;
}

export function findDetachedAgentSessionIdsFromProc(attachedPids, {
  procRoot = '/proc',
  observationCache = null,
  observationCacheTtlMs = DETACHED_PROCESS_CACHE_TTL_MS,
  now = Date.now(),
} = {}) {
  const cache = observationCache instanceof Map ? observationCache : null;
  const candidatePids = new Set(readProcChildren(procRoot, 1));
  const queue = [...candidatePids];
  const processes = [];
  while (queue.length) {
    const pid = queue.shift();
    let stat;
    try { stat = parseProcStat(fs.readFileSync(path.join(procRoot, String(pid), 'stat'), 'utf8')); }
    catch { continue; }
    if (!stat) continue;
    const cached = cache?.get(pid);
    const cacheMatchesProcess = cached?.startTicks === stat.startTicks
      && cached.name === stat.name;
    const reusable = cacheMatchesProcess && cached.expiresAt > now;
    const auditDelay = cacheMatchesProcess
      ? Math.max(0, observationCacheTtlMs)
      : initialAuditDelay(`${stat.pid}\0${stat.startTicks}\0${stat.name}`, observationCacheTtlMs);
    const process = reusable
      ? { ...cached, ...stat }
      : {
          ...stat,
          command: readProcCommand(procRoot, pid, stat.name),
          environmentLoaded: false,
          agentSessionId: null,
          expiresAt: now + auditDelay,
        };
    processes.push(process);
    cache?.set(pid, process);
    if (!/(?:^|[ /])codex(?:\s|$)/i.test(process.command)
      || !/(?:^|\s)app-server(?:\s|$)/i.test(process.command)) continue;
    // app-server may spawn unified-exec from any worker thread. Linux exposes those
    // children only below that thread's task directory, not the process leader's.
    for (const child of readProcThreadChildren(procRoot, pid)) {
      if (candidatePids.has(child)) continue;
      candidatePids.add(child);
      queue.push(child);
    }
  }
  if (cache) {
    for (const pid of cache.keys()) {
      if (!candidatePids.has(pid)) cache.delete(pid);
    }
  }
  for (const process of processes) {
    if (attachedPids?.has(process.pid) || !isIndependentProcessLeader(process, procRoot)) continue;
    if (!process.environmentLoaded) {
      process.agentSessionId = readAgentSessionId(procRoot, process.pid);
      process.environmentLoaded = true;
      cache?.set(process.pid, process);
    }
  }
  return findDetachedAgentSessionIds(processes, attachedPids, { procRoot });
}

function readProcUptimeMs(procRoot) {
  try { return Number(fs.readFileSync(path.join(procRoot, 'uptime'), 'utf8').trim().split(/\s+/)[0]) * 1000 || 0; }
  catch { return 0; }
}

function processClockTicks() {
  clockTicksPromise ||= exec('getconf', ['CLK_TCK'])
    .then(({ stdout }) => Number(stdout.trim()) || 100)
    .catch(() => 100);
  return clockTicksPromise;
}

export function findDetachedAgentSessionIds(processes, attachedPids, { procRoot = '/proc' } = {}) {
  const ids = new Set();
  const sessionId = new RegExp(`^${UUID}$`, 'i');
  for (const process of processes || []) {
    // Every tool subprocess inherits the Agent session id. Count only independent
    // terminal session leaders. Unified-exec leaders remain below the app-server
    // parent, while helpers stay in their parent's terminal session.
    if (attachedPids?.has(process.pid) || !isIndependentProcessLeader(process, procRoot)) continue;
    if (Object.hasOwn(process, 'agentSessionId')) {
      if (sessionId.test(process.agentSessionId || '')) ids.add(process.agentSessionId);
      continue;
    }
    let entries;
    try { entries = fs.readFileSync(path.join(procRoot, String(process.pid), 'environ'), 'utf8').split('\0'); }
    catch { continue; }
    for (const entry of entries) {
      const separator = entry.indexOf('=');
      if (separator < 0 || !AGENT_SESSION_ENV.has(entry.slice(0, separator))) continue;
      const id = entry.slice(separator + 1);
      if (sessionId.test(id)) ids.add(id);
    }
  }
  return ids;
}

function nearestCodexCandidate(startedAt, starts) {
  const candidate = starts.reduce((best, item) => {
    const distance = Math.abs(item.startedAt - startedAt);
    return !best || distance < best.distance ? { id: item.id, distance } : best;
  }, null);
  return candidate?.distance <= 120_000 ? candidate : null;
}

// 可见文本去不掉歧义时的兜底: 进程启动时刻与 rollout 创建时刻是秒级吻合的强信号,
// 但原来只要 visibleMatch.matched 为真就被整个丢弃 —— 现场表现是同一个 cwd 下开了
// 两个 codex 会话 (research 与 report 都在 /home/x/py), 两边都拿不到身份, 正文与
// 历史全空。只有"窗口内唯一、且没被别的 pane 认领"时才采用: 猜错的后果是把另一个
// 会话的对话显示到这边, 所以宁可继续放弃。
const UNIQUE_START_MATCH_WINDOW_MS = 30_000;

export function uniqueCodexStartMatch(process, codex, claimed = new Set()) {
  const startedAt = process?.startedAt;
  if (!Number.isFinite(startedAt)) return null;
  const within = (list) => (list || []).filter((item) => (
    Math.abs(item.startedAt - startedAt) <= UNIQUE_START_MATCH_WINDOW_MS
  ));
  // 唯一性必须在剔除"已认领"之前判断: 否则别的 pane 认领掉其余候选后, 会把本来
  // 有歧义的情形伪装成唯一。
  const rollouts = within(codex?.starts);
  if (rollouts.length !== 1 || claimed.has(rollouts[0].id)) return null;
  // 只有启动时刻还不够: 一个早已结束的旧会话也可能恰好落在窗口里 (测试
  // "Codex rollout cwd disambiguates identical prompts" 就是这种情形, 它会把陈旧
  // 会话安到别的 pane 上)。writer lock 是活着的进程才会持有的, 用它做第二重证据。
  const locks = within(codex?.writers);
  if (locks.length !== 1 || locks[0].id !== rollouts[0].id) return null;
  return rollouts[0].id;
}

// A bare resume reopens an old rollout, so its filename time cannot match this process.
// The newly acquired writer lock can, but only when the ambiguous visible text and cwd
// already include that thread and no second matching writer started alongside it.
function uniqueCodexResumeWriterMatch(process, codex, candidates, claimed = new Set()) {
  const startedAt = process?.startedAt;
  if (!Number.isFinite(startedAt)
    || !/\bresume(?:\s|$)/i.test(process?.command || '')
    || !candidates?.size) return null;
  const rolloutIds = new Set((codex?.starts || []).map((item) => item.id));
  const locks = (codex?.writers || []).filter((item) => (
    Math.abs(item.startedAt - startedAt) <= UNIQUE_START_MATCH_WINDOW_MS
    && candidates.has(item.id)
    && rolloutIds.has(item.id)
  ));
  // Count before removing claimed ids: another pane claiming one candidate must not
  // turn two simultaneous resumes into an apparently unique match.
  if (locks.length !== 1 || claimed.has(locks[0].id)) return null;
  return locks[0].id;
}

export function resolveCodexSessionId(process, codex) {
  const resumed = process.command.match(new RegExp(`\\bresume\\s+(${UUID})`, 'i'))?.[1];
  if (resumed) return resumed;
  const starts = codex.starts || [];
  const writer = nearestCodexCandidate(process.startedAt, codex.writers || []);
  const rollout = nearestCodexCandidate(process.startedAt, starts);
  if (/\bresume(?:\s|$)/i.test(process.command)) {
    return writer?.id || rollout?.id || null;
  }
  // A new Codex process creates its writer lock before the first prompt creates a
  // rollout. Until that rollout exists, app-server cannot read the thread, so keep
  // the tmux session on the directly manageable pending path.
  if (writer && !starts.some((item) => item.id === writer.id)) return null;
  if (rollout && (!writer || rollout.distance <= writer.distance)) return rollout.id;
  return writer?.id || rollout?.id || null;
}

function claudeTranscriptIndex(claudeHome) {
  let index = claudeTranscriptIndexes.get(claudeHome);
  if (!index) {
    index = { files: new Map(), slugs: new Map(), nextScanAt: 0 };
    claudeTranscriptIndexes.set(claudeHome, index);
  }
  return index;
}

function refreshClaudeTranscriptIndex(index, claudeHome, now) {
  const files = new Map(walkFiles(
    path.join(claudeHome, 'projects'),
    (name) => new RegExp(`^${UUID}\\.jsonl$`, 'i').test(name),
  ).map((file) => [path.basename(file, '.jsonl').toLowerCase(), file]));
  index.files = files;
  index.nextScanAt = now + CLAUDE_TRANSCRIPT_MISS_TTL_MS;
  for (const id of index.slugs.keys()) {
    if (!files.has(id)) index.slugs.delete(id);
  }
}

function findClaudeSlug(sessionId, claudeHome, now = Date.now()) {
  if (!sessionId) return null;
  const id = sessionId.toLowerCase();
  const index = claudeTranscriptIndex(claudeHome);
  let file = index.files.get(id);
  if (!file && now >= index.nextScanAt) {
    refreshClaudeTranscriptIndex(index, claudeHome, now);
    file = index.files.get(id);
  }
  if (!file) return null;
  let stat;
  try { stat = fs.statSync(file); }
  catch {
    index.files.delete(id);
    index.slugs.delete(id);
    return null;
  }
  const signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  const cached = index.slugs.get(id);
  if (cached?.file === file && cached.signature === signature) return cached.slug;
  const length = Math.min(stat.size, 128 * 1024);
  const buffer = Buffer.alloc(length);
  const descriptor = fs.openSync(file, 'r');
  try { fs.readSync(descriptor, buffer, 0, length, stat.size - length); } finally { fs.closeSync(descriptor); }
  const slugs = [...buffer.toString('utf8').matchAll(/"slug"\s*:\s*"([^"]+)"/g)];
  const slug = slugs.at(-1)?.[1] || null;
  index.slugs.set(id, { file, signature, slug });
  return slug;
}

async function readCodexPaneOutput(session) {
  try {
    const { stdout } = await exec('tmux', ['capture-pane', '-p', '-t', `${session}:`, '-S', '-2000']);
    return stdout;
  } catch { return ''; }
}

function processCwd(pid, procRoot = '/proc') {
  try { return fs.readlinkSync(path.join(procRoot, String(pid), 'cwd')); } catch { return null; }
}

function normalizedPath(value) {
  if (!value) return null;
  try { return fs.realpathSync(value); }
  catch { return path.resolve(value); }
}

function pathPartsWithin(root, target) {
  if (!root) return null;
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return relative.split(path.sep);
}

function codexRolloutIsSubagent(file, id) {
  let descriptor;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return false;
    const signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    const cached = codexRolloutMetadata.get(file);
    if (cached?.signature === signature) return cached.subagent;
    descriptor = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(Math.min(stat.size, CODEX_METADATA_READ_LIMIT));
    const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    const entry = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8').split('\n', 1)[0]);
    const metadata = entry?.type === 'session_meta' ? entry.payload : null;
    if ((metadata?.id || metadata?.session_id) !== id) return false;
    const subagent = metadata.thread_source != null
      ? metadata.thread_source === 'subagent'
      : Boolean(metadata.source?.subagent);
    if (codexRolloutMetadata.size >= CODEX_METADATA_CACHE_LIMIT) {
      codexRolloutMetadata.delete(codexRolloutMetadata.keys().next().value);
    }
    codexRolloutMetadata.set(file, { signature, subagent });
    return subagent;
  } catch {
    // An unreadable or partial header remains a candidate; never guess its role.
    codexRolloutMetadata.delete(file);
    return false;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function findCodexOpenSessionId(processes, codexHome, { procRoot = '/proc' } = {}) {
  if (!processes?.length || !codexHome) return null;
  let locksRoot;
  let sessionsRoot;
  try {
    locksRoot = fs.realpathSync.native(path.join(codexHome, 'thread-writer-locks'));
    sessionsRoot = fs.realpathSync.native(path.join(codexHome, 'sessions'));
  } catch { return null; }

  const lockIds = new Set();
  const rollouts = new Map();
  for (const process of processes) {
    const fdRoot = path.join(procRoot, String(process.pid), 'fd');
    let descriptors;
    try { descriptors = fs.readdirSync(fdRoot); }
    catch { continue; }
    for (const descriptor of descriptors) {
      let target;
      try {
        const link = fs.readlinkSync(path.join(fdRoot, descriptor));
        if (/^(?:pipe|socket):\[|^anon_inode:/.test(link)) continue;
        target = fs.realpathSync.native(path.isAbsolute(link) ? link : path.resolve(fdRoot, link));
      } catch { continue; }

      const lockParts = pathPartsWithin(locksRoot, target);
      const lockMatch = lockParts?.length === 1
        ? lockParts[0].match(new RegExp(`^(${UUID})\\.lock$`, 'i'))
        : null;
      if (lockMatch) lockIds.add(lockMatch[1]);

      if (!pathPartsWithin(sessionsRoot, target)) continue;
      const rollout = parseRolloutFilename(target);
      if (rollout) rollouts.set(rollout.id, target);
    }
  }

  // The writer lock identifies ownership and the rollout confirms app-server can
  // already open the thread. During a fork both descriptors move to the child,
  // while the original `codex resume <id>` argument necessarily stays unchanged.
  // Parallel subagents share the CLI process and own their own pairs. Only exclude
  // roles confirmed by metadata; unknown headers and multiple roots stay ambiguous.
  const ids = [...lockIds].filter((id) => (
    rollouts.has(id) && !codexRolloutIsSubagent(rollouts.get(id), id)
  ));
  return ids.length === 1 ? ids[0] : null;
}

function qoderTranscriptMatches(file, id, cwd) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, 'r');
    const length = Math.min(fs.fstatSync(descriptor).size, QODER_TRANSCRIPT_READ_LIMIT);
    const buffer = Buffer.alloc(length);
    fs.readSync(descriptor, buffer, 0, length, 0);
    const expectedId = id.toLowerCase();
    const expectedCwd = normalizedPath(cwd);
    let idFound = false;
    let cwdFound = false;
    for (const line of buffer.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); }
      catch { continue; }
      if (String(entry?.sessionId || '').toLowerCase() !== expectedId) continue;
      idFound = true;
      const directories = Array.isArray(entry.directories) ? entry.directories : [];
      const candidates = [entry.cwd, ...directories].filter((value) => typeof value === 'string' && value);
      if (candidates.some((candidate) => normalizedPath(candidate) === expectedCwd)) cwdFound = true;
    }
    return idFound && cwdFound;
  } catch { return false; }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

export function findQoderOpenSessionId(processes, qoderHome, cwd, { procRoot = '/proc' } = {}) {
  if (!processes?.length || !qoderHome || !cwd) return null;
  let projectsRoot;
  let sessionLogsRoot = null;
  try { projectsRoot = fs.realpathSync(path.join(qoderHome, 'projects')); }
  catch { return null; }
  try { sessionLogsRoot = fs.realpathSync(path.join(qoderHome, 'logs', 'sessions')); }
  catch { /* Older Qoder versions may open the project transcript directly. */ }
  const ids = new Set();
  for (const process of processes) {
    const fdRoot = path.join(procRoot, String(process.pid), 'fd');
    let descriptors;
    try { descriptors = fs.readdirSync(fdRoot); }
    catch { continue; }
    for (const descriptor of descriptors) {
      let target;
      try {
        const link = fs.readlinkSync(path.join(fdRoot, descriptor));
        target = fs.realpathSync(path.isAbsolute(link) ? link : path.resolve(fdRoot, link));
      } catch { continue; }
      const projectParts = pathPartsWithin(projectsRoot, target);
      const directMatch = projectParts?.length === 2
        ? projectParts[1].match(new RegExp(`^(${UUID})\\.jsonl$`, 'i'))
        : null;
      let id = directMatch?.[1] || null;
      let transcript = directMatch ? target : null;

      if (!transcript) {
        const logParts = pathPartsWithin(sessionLogsRoot, target);
        const segmentMatch = logParts?.length === 4
          && logParts[2] === 'segments'
          && logParts[3].endsWith('.jsonl')
          ? logParts[1].match(new RegExp(`^(${UUID})$`, 'i'))
          : null;
        if (!segmentMatch) continue;
        id = segmentMatch[1];
        try { transcript = fs.realpathSync(path.join(projectsRoot, logParts[0], `${id}.jsonl`)); }
        catch { continue; }
        const transcriptParts = pathPartsWithin(projectsRoot, transcript);
        if (transcriptParts?.length !== 2
          || transcriptParts[0] !== logParts[0]
          || transcriptParts[1].toLowerCase() !== `${id}.jsonl`.toLowerCase()) continue;
      }

      if (!qoderTranscriptMatches(transcript, id, cwd)) continue;
      ids.add(id);
    }
  }
  return ids.size === 1 ? [...ids][0] : null;
}

function readRuntimeSession(processes, configHome) {
  for (const process of processes) {
    try {
      const registry = parseRuntimeSessionRegistry(fs.readFileSync(path.join(configHome, 'sessions', `${process.pid}.json`), 'utf8'));
      if (registry) return { ...registry, pid: process.pid, startedAt: process.startedAt };
    } catch { /* This descendant is not the Agent CLI process. */ }
  }
  return null;
}

function agentIdentityFingerprint(pane, process, cwd, configSignature, providerIdentity) {
  return JSON.stringify([
    configSignature,
    pane.paneId,
    pane.pid,
    process.pid,
    process.startTicks,
    process.command,
    cwd,
    providerIdentity,
  ]);
}

export async function detectPaneAgents(panes, env = process.env, options = {}) {
  const identityCache = options.identityCache instanceof Map ? options.identityCache : null;
  if (!panes.length) {
    identityCache?.clear();
    return new Map();
  }
  const procRoot = options.procRoot || '/proc';
  const clockTicks = options.clockTicks || await processClockTicks();
  const now = options.now ?? Date.now();
  const uptimeMs = options.uptimeMs ?? readProcUptimeMs(procRoot);
  const codexHome = env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const claudeHome = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const qoderHome = env.QODER_CONFIG_DIR || path.join(os.homedir(), env.QODER_CONFIG_DIR_NAME || '.qoder');
  const identityCacheTtlMs = Number.isFinite(options.identityCacheTtlMs)
    ? Math.max(0, options.identityCacheTtlMs)
    : AGENT_IDENTITY_CACHE_TTL_MS;
  const configSignature = [procRoot, codexHome, claudeHome, qoderHome].join('\0');
  const agents = new Map();
  const processTreeCache = options.processTreeCache instanceof Map ? options.processTreeCache : null;
  if (options.refreshIdentityCache) processTreeCache?.clear();
  const trees = readPaneProcessTrees(panes, {
    procRoot, clockTicks, now, uptimeMs,
    processTreeCache,
    processTreeCacheTtlMs: options.processTreeCacheTtlMs,
  });
  const suppliedPaneOutputs = await Promise.resolve(options.paneOutputs || null);
  const paneOutputs = suppliedPaneOutputs instanceof Map
    ? suppliedPaneOutputs
    : Array.isArray(suppliedPaneOutputs) ? new Map(suppliedPaneOutputs) : null;
  const detections = new Map();

  if (identityCache) {
    const activeSessions = new Set(panes.map((pane) => pane.session));
    for (const session of identityCache.keys()) {
      if (!activeSessions.has(session)) identityCache.delete(session);
    }
  }

  for (const pane of panes) {
    const tree = trees.get(pane.session) || [];
    const agentProcess = tree.find((item) => agentKindFromCommand(item.command));
    if (!agentProcess) {
      identityCache?.delete(pane.session);
      continue;
    }
    const kind = agentKindFromCommand(agentProcess.command);
    const cwd = processCwd(agentProcess.pid, procRoot);
    const registered = kind === 'claude'
      ? readRuntimeSession(tree, claudeHome)
      : kind === 'qodercli' ? readRuntimeSession(tree, qoderHome) : null;
    const explicitId = kind === 'claude' || kind === 'qodercli'
      ? parseResumedSessionId(agentProcess.command)
      : null;
    const openSessionId = kind === 'codex'
      ? findCodexOpenSessionId(tree, codexHome, { procRoot })
      : kind === 'qodercli' && !registered?.id && !explicitId
        ? findQoderOpenSessionId(tree, qoderHome, registered?.cwd || cwd, { procRoot })
        : null;
    const providerIdentity = registered
      ? ['registry', registered.pid, registered.id, registered.cwd]
      : explicitId
        ? ['command', explicitId]
        : openSessionId ? [`${kind}-fd`, openSessionId] : null;
    const fingerprint = agentIdentityFingerprint(
      pane, agentProcess, cwd, configSignature, providerIdentity,
    );
    const cached = identityCache?.get(pane.session);
    const visiblePrompt = kind === 'codex' ? latestCodexPrompt(paneOutputs?.get(pane.session)) : null;
    const promptChanged = Boolean(cached && visiblePrompt && visiblePrompt !== cached.prompt);
    if (!options.refreshIdentityCache
      && !promptChanged
      && cached?.fingerprint === fingerprint
      && cached.expiresAt > now) {
      agents.set(pane.session, { ...cached.agent });
      continue;
    }
    identityCache?.delete(pane.session);
    detections.set(pane.session, {
      pane, tree, process: agentProcess, kind, cwd, fingerprint, visiblePrompt, promptChanged,
      registered, explicitId, openSessionId,
      identityAuditDelay: cached ? identityCacheTtlMs : null,
    });
  }

  const coldDetectionsByKind = new Map();
  for (const detection of detections.values()) {
    if (detection.identityAuditDelay != null) continue;
    const group = coldDetectionsByKind.get(detection.kind) || [];
    group.push(detection);
    coldDetectionsByKind.set(detection.kind, group);
  }
  for (const group of coldDetectionsByKind.values()) {
    group.sort((a, b) => a.pane.session.localeCompare(b.pane.session));
    for (const [index, detection] of group.entries()) {
      detection.identityAuditDelay = initialAuditDelayByIndex(
        index, group.length, identityCacheTtlMs,
      );
    }
  }

  const needsCodexMetadata = [...detections.values()].some((item) => item.kind === 'codex');
  const codex = needsCodexMetadata ? loadCodexSessions(codexHome) : null;
  const readPaneOutput = options.readCodexPaneOutput || readCodexPaneOutput;
  const codexPaneOutputs = new Map(await Promise.all([...detections.values()].flatMap(({ pane, kind }) => (
    kind === 'codex'
      ? [Promise.resolve().then(() => readPaneOutput(pane.session)).then((output) => [pane.session, output]).catch(() => [pane.session, ''])]
      : []
  ))));

  // 同一轮里已经被确定归属的 rollout, 不再作为其它 pane 的兜底候选。
  const claimedCodexIds = new Set();
  for (const agent of agents.values()) if (agent?.kind === 'codex' && agent.id) claimedCodexIds.add(agent.id);
  for (const {
    pane, process, kind, cwd, fingerprint, visiblePrompt, promptChanged,
    registered, explicitId: providerExplicitId, openSessionId, identityAuditDelay,
  } of detections.values()) {
    const runtime = {
      startedAt: registered?.startedAt || process.startedAt,
      cwd: registered?.cwd || cwd,
      paneId: pane.paneId,
    };

    let agent;
    let cacheable = true;
    let cachePrompt = null;
    if (kind === 'codex') {
      const paneOutput = codexPaneOutputs.get(pane.session) || '';
      cachePrompt = visiblePrompt || latestCodexPrompt(paneOutput);
      const explicitId = process.command.match(new RegExp(`\\bresume\\s+(${UUID})`, 'i'))?.[1] || null;
      const paneCwd = normalizedPath(runtime.cwd);
      const cwdMatches = new Map();
      const visibleMatch = openSessionId || explicitId ? { id: null, matched: false } : matchCodexHistorySession(paneOutput, codex.history, (id) => {
        if (!paneCwd) return true;
        if (!cwdMatches.has(id)) cwdMatches.set(id, normalizedPath(codexSessionCwd(id, codex)) === paneCwd);
        return cwdMatches.get(id);
      });
      const visibleId = visibleMatch.id;
      const verifiedVisibleId = codex.starts.some((item) => item.id === visibleId) ? visibleId : null;
      if (promptChanged && !explicitId && !visibleMatch.matched) cacheable = false;
      const remembered = codexPaneSessions.get(pane.session);
      const rememberedId = remembered?.pid === process.pid
        && remembered.startedAt === process.startedAt
        && codex.starts.some((item) => item.id === remembered.id)
        ? remembered.id : null;
      let id = openSessionId || explicitId || verifiedVisibleId || rememberedId
        || (visibleMatch.matched
          ? uniqueCodexStartMatch(process, codex, claimedCodexIds)
            || uniqueCodexResumeWriterMatch(
              process, codex, visibleMatch.candidates, claimedCodexIds,
            )
          : resolveCodexSessionId(process, codex));
      if (openSessionId || explicitId || verifiedVisibleId) codexPaneSessions.set(pane.session, { pid: process.pid, startedAt: process.startedAt, id });
      let name = codex.names.get(id) || codexPreview(id, codex);
      if (!name) {
        const paneIdentity = parseCodexRename(paneOutput);
        if (paneIdentity && (!id || paneIdentity.id === id)) {
          id = paneIdentity.id;
          name = paneIdentity.name || codex.names.get(id) || codexPreview(id, codex);
        }
      }
      if (id) claimedCodexIds.add(id);
      agent = { kind: 'codex', id, name, ...runtime };
    } else if (kind === 'claude') {
      const id = registered?.id || providerExplicitId;
      const name = findClaudeSlug(id, claudeHome, now) || pane.session;
      agent = { kind: 'claude', id, name, ...runtime };
    } else {
      // A bare --resume selects a transcript inside Qoder's TUI, so its start time is
      // not an identity. Prefer the runtime registry and explicit UUID, then the main
      // transcript the live process has actually opened.
      const id = registered?.id || providerExplicitId || openSessionId;
      agent = {
        kind: 'qodercli',
        id,
        name: pane.session,
        matchByStart: !isQoderResumeCommand(process.command),
        ...runtime,
      };
    }
    agents.set(pane.session, agent);
    if (identityCache && identityCacheTtlMs > 0 && agent.id && cacheable) {
      identityCache.set(pane.session, {
        fingerprint,
        expiresAt: now + identityAuditDelay,
        agent: { ...agent },
        prompt: cachePrompt,
      });
    }
  }
  const attachedPids = new Set([...trees.values()].flat().map((process) => process.pid));
  const detachedSessionIds = findDetachedAgentSessionIdsFromProc(attachedPids, {
    procRoot,
    observationCache: options.detachedProcessObservationCache,
  });
  for (const agent of agents.values()) {
    if (agent.id && detachedSessionIds.has(agent.id)) agent.hasBackgroundProcess = true;
  }
  return agents;
}
