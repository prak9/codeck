import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { validateSessionName } from './tmux.js';
import { HTTP_URL_PATTERN } from '../public/terminal-history-links.js';

const exec = promisify(execFile);
const FORMAT = '#{session_name}\t#{pane_id}\t#{pane_width}\t#{pane_height}\t#{scroll_position}\t#{pane_in_mode}\t#{history_size}';
const CONTEXT_ROWS = 128;

export function historyUrls(output, { startComplete = false } = {}) {
  // Boundary logical lines may be clipped; retain the first only at history start.
  const complete = output.split('\n').slice(startComplete ? 0 : 1, -2).join('\n');
  return [...new Set(complete.match(HTTP_URL_PATTERN) || [])].filter(value => {
    if (value.length > 8192) return false;
    try { return ['http:', 'https:'].includes(new URL(value).protocol); }
    catch { return false; }
  }).slice(0, 256);
}

export function createTerminalHistoryLinkReader({
  execTmux = args => exec('tmux', args, { timeout: 1500, maxBuffer: 2 * 1024 * 1024 }),
} = {}) {
  const pending = new Map();
  let modeCapture;
  async function read(name) {
    if (!validateSessionName(name)) throw new Error('无效的会话名');
    const target = `=${name}:`;
    const { stdout: before } = await execTmux(['display-message', '-p', '-t', target, FORMAT]);
    const [session, pane, width, height, position, mode, history] = before.trimEnd().split('\t');
    if (session !== name || !/^%\d+$/.test(pane) || mode !== '1') return { urls: [] };
    const cols = Number(width), rows = Number(height), scroll = Number(position);
    if (![cols, rows, scroll].every(Number.isInteger) || cols < 1 || cols > 1000
      || rows < 1 || rows > 500 || scroll < 0) return { urls: [] };
    // Newer tmux clones the copy-mode backing screen; older releases use the pane.
    if (!modeCapture) modeCapture = execTmux(['list-commands']).then(({ stdout }) => (
      /^capture-pane[^\n]*\[[^\]]*M/m.test(stdout)
    )).catch(error => { modeCapture = null; throw error; });
    const useMode = await modeCapture;
    const marker = `codeck-links-${randomUUID()}`;
    const { stdout } = await execTmux([
      'capture-pane', '-p', '-J', ...(useMode ? ['-M'] : []), '-t', pane,
      '-S', String(-scroll - CONTEXT_ROWS), '-E', String(-scroll + rows + CONTEXT_ROWS),
      ';', 'display-message', '-p', marker,
      ';', 'display-message', '-p', '-t', target, FORMAT,
    ]);
    const split = stdout.lastIndexOf(`${marker}\n`);
    if (split < 0 || stdout.slice(split + marker.length + 1).trimEnd() !== before.trimEnd()) return { urls: [] };
    return { urls: historyUrls(stdout.slice(0, split), { startComplete: scroll + CONTEXT_ROWS >= Number(history) }) };
  }
  return name => {
    if (pending.has(name)) return pending.get(name);
    const request = read(name).finally(() => pending.delete(name));
    pending.set(name, request);
    return request;
  };
}
