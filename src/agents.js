import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const AGENT_SESSION_ENV = new Set(['CODEX_THREAD_ID', 'CLAUDE_CODE_SESSION_ID', 'QODER_SESSION_ID']);
const QODER_TRANSCRIPT_READ_LIMIT = 128 * 1024;
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

function isDetachedProcessLeader(process, procRoot) {
  if (process.ppid !== 1) return false;
  try {
    const stat = fs.readFileSync(path.join(procRoot, String(process.pid), 'stat'), 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    return Number(fields[2]) === process.pid && Number(fields[3]) === process.pid;
  } catch { return false; }
}

export function findDetachedAgentSessionIds(processes, attachedPids, { procRoot = '/proc' } = {}) {
  const ids = new Set();
  const sessionId = new RegExp(`^${UUID}$`, 'i');
  for (const process of processes || []) {
    // Every tool subprocess inherits the Agent session id. Count only independently
    // detached task leaders: direct app-server children can be abandoned utilities,
    // while reparented crash/helper children are not tasks in their own right.
    if (attachedPids?.has(process.pid) || !isDetachedProcessLeader(process, procRoot)) continue;
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

function nearestCodexId(startedAt, starts) {
  const candidate = starts.reduce((best, item) => {
    const distance = Math.abs(item.startedAt - startedAt);
    return !best || distance < best.distance ? { id: item.id, distance } : best;
  }, null);
  return candidate?.distance <= 120_000 ? candidate.id : null;
}

export function resolveCodexSessionId(process, codex) {
  const resumed = process.command.match(new RegExp(`\\bresume\\s+(${UUID})`, 'i'))?.[1];
  if (resumed) return resumed;
  const starts = codex.starts || [];
  const writer = nearestCodexId(process.startedAt, codex.writers || []);
  if (/\bresume(?:\s|$)/i.test(process.command)) {
    return writer || nearestCodexId(process.startedAt, starts);
  }
  // A new Codex process creates its writer lock before the first prompt creates a
  // rollout. Until that rollout exists, app-server cannot read the thread, so keep
  // the tmux session on the directly manageable pending path.
  if (writer && !starts.some((item) => item.id === writer)) return null;
  return writer || nearestCodexId(process.startedAt, starts);
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
  const trees = new Map(panes.map((pane) => [pane.session, paneProcessTree(pane.pid, processes)]));

  for (const pane of panes) {
    const tree = trees.get(pane.session);
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
      // A bare --resume selects a transcript inside Qoder's TUI, so its start time is
      // not an identity. Prefer the runtime registry and explicit UUID, then the main
      // transcript the live process has actually opened.
      const explicitId = parseResumedSessionId(process.command);
      const id = registered?.id || explicitId
        || findQoderOpenSessionId(tree, qoderHome, runtime.cwd);
      agents.set(pane.session, {
        kind: 'qodercli',
        id,
        name: pane.session,
        matchByStart: !isQoderResumeCommand(process.command),
        ...runtime,
      });
    }
  }
  const attachedPids = new Set([...trees.values()].flat().map((process) => process.pid));
  const detachedSessionIds = findDetachedAgentSessionIds(processes, attachedPids);
  for (const agent of agents.values()) {
    if (agent.id && detachedSessionIds.has(agent.id)) agent.hasBackgroundProcess = true;
  }
  return agents;
}
