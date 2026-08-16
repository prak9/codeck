import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
let codexCache = { expires: 0, names: new Map(), starts: [] };

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
