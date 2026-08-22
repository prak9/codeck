import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
let codexCache = { expires: 0, names: new Map(), starts: [], writers: [], previews: new Map() };

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
  if (/(?:^|[ /])codex(?:\s|$)/i.test(command) && !/app-server/.test(command)) return 'codex';
  if (/(?:^|[ /])claude(?:\s|$)/i.test(command)) return 'claude';
  if (/(?:^|[ /])qodercli(?:\s|$)/i.test(command)) return 'qodercli';
  return null;
}

export function parseResumedSessionId(command) {
  return command.match(new RegExp(`(?:--resume(?:=|\\s+)|-r\\s+|--session-id(?:=|\\s+))(${UUID})`, 'i'))?.[1] || null;
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

function walkFiles(root, accept, results = []) {
  if (!fs.existsSync(root)) return results;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) walkFiles(target, accept, results);
    else if (accept(entry.name)) results.push(target);
  }
  return results;
}

function loadCodexSessions(codexHome) {
  if (codexCache.expires > Date.now()) return codexCache;
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
  codexCache = { expires: Date.now() + 15_000, names, starts, writers, previews: codexCache.previews };
  return codexCache;
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

export function resolveCodexSessionId(process, codex) {
  const resumed = process.command.match(new RegExp(`\\bresume\\s+(${UUID})`, 'i'))?.[1];
  return resumed
    || nearestCodexId(process.startedAt, codex.writers || [])
    || nearestCodexId(process.startedAt, codex.starts || []);
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

function processCwd(pid) {
  try { return fs.readlinkSync(`/proc/${pid}/cwd`); } catch { return null; }
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

export async function detectPaneAgents(panes, env = process.env) {
  if (!panes.length) return new Map();
  // One -o per field. POSIX lets the header in `-o name=header` contain commas, so
  // `-o pid=,ppid=,etimes=,args=` is a single pid column headed ",ppid=,etimes=,args="
  // on older procps. Every row then holds one number, no row parses, and agent
  // detection silently returns nothing.
  const { stdout } = await exec('ps', PS_ARGUMENTS);
  const processes = parseProcessList(stdout);
  // A populated ps with no parsable rows is a format mismatch, not an empty system.
  // Left silent it degrades every agent session to the command-based fallback.
  if (!processes.length && stdout.trim()) warnProcessListUnparsed();
  const codexHome = env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const claudeHome = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const qoderHome = env.QODER_CONFIG_DIR || path.join(os.homedir(), env.QODER_CONFIG_DIR_NAME || '.qoder');
  const codex = loadCodexSessions(codexHome);
  const agents = new Map();

  for (const pane of panes) {
    const tree = descendants(pane.pid, processes);
    const process = tree.find((item) => agentKindFromCommand(item.command));
    if (!process) continue;
    const kind = agentKindFromCommand(process.command);
    const registered = kind === 'claude'
      ? readRuntimeSession(tree, claudeHome)
      : kind === 'qodercli' ? readRuntimeSession(tree, qoderHome) : null;
    const runtime = {
      startedAt: registered?.startedAt || process.startedAt,
      cwd: registered?.cwd || processCwd(registered?.pid || process.pid),
      paneId: pane.paneId,
    };

    if (kind === 'codex') {
      let id = resolveCodexSessionId(process, codex);
      let name = codex.names.get(id) || codexPreview(id, codex);
      if (!name) {
        const paneIdentity = await readCodexPaneIdentity(pane.session);
        if (paneIdentity && (!id || paneIdentity.id === id)) {
          id = paneIdentity.id;
          name = paneIdentity.name || codex.names.get(id) || codexPreview(id, codex);
        }
      }
      agents.set(pane.session, { kind: 'codex', id, name, ...runtime });
    } else if (kind === 'claude') {
      const id = registered?.id || parseResumedSessionId(process.command);
      const name = findClaudeSlug(id, claudeHome) || pane.session;
      agents.set(pane.session, { kind: 'claude', id, name, ...runtime });
    } else {
      agents.set(pane.session, { kind: 'qodercli', id: registered?.id || parseResumedSessionId(process.command), name: pane.session, ...runtime });
    }
  }
  return agents;
}
