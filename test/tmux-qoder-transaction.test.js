import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pty from 'node-pty';
import { sendSessionMessage, scrollSession, writeTerminalInput, withoutTmuxEnvironment } from '../src/tmux.js';

const exec = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('isolated real tmux: narrow 56-line paste, copy-mode, delayed composer and concurrent input', { timeout: 15000 }, async t => {
  try { await exec('tmux', ['-V']); } catch { t.skip('tmux not installed'); return; }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codeck-tmux-qoder-'));
  const socket = `codeck-test-${process.pid}-${path.basename(dir)}`;
  const tmux = args => exec('tmux', ['-L', socket, ...args]);
  let terminal;
  t.after(async () => {
    terminal?.kill();
    await tmux(['kill-server']).catch(() => {});
    await fs.rm(dir, { recursive: true, force: true });
  });
  const receipt = path.join(dir, 'receipt.json');
  await tmux(['-f', '/dev/null', 'new-session', '-d', '-s', 'isolated-qoder', '-x', '37', '-y', '22',
    process.execPath, fileURLToPath(new URL('../scripts/fixtures/qoder-paste-tui.mjs', import.meta.url)), receipt]);
  const paneId = (await tmux(['display-message', '-p', '-t', '=isolated-qoder:', '#{pane_id}'])).stdout.trim();
  const capturePane = async () => (await tmux(['capture-pane', '-p', '-e', '-J', '-t', paneId])).stdout;
  for (let tries = 0; !(await capturePane()).includes('Ultimate Model'); tries++) {
    assert.ok(tries < 50, 'simulator becomes ready'); await delay(20);
  }
  terminal = pty.spawn('tmux', ['-L', socket, 'attach-session', '-t', 'isolated-qoder'], {
    name: 'xterm-256color', cols: 37, rows: 22, env: withoutTmuxEnvironment(process.env),
  });
  let attached = false;
  terminal.onData(data => { if (data.includes('Ultimate')) attached = true; });
  for (let tries = 0; !attached; tries++) {
    assert.ok(tries < 100, 'real PTY attaches'); await delay(20);
  }
  await scrollSession('isolated-qoder', 2, { execTmux: tmux });
  assert.equal((await tmux(['display-message', '-p', '-t', paneId, '#{pane_in_mode}'])).stdout.trim(), '1');
  const text = Array.from({ length: 56 }, (_, i) => `${i}:目标 ${'x'.repeat(80)}`).join('\n');
  assert.ok(Buffer.byteLength(text) > 5000);
  const events = []; let scroll, human;
  const result = await sendSessionMessage({ provider: 'qodercli', sessionName: 'isolated-qoder', threadId: 'fixture', text }, {
    listTmuxSessions: async () => [{ name: 'isolated-qoder', agent: { kind: 'qodercli', id: 'fixture', paneId } }],
    capturePane,
    loadBuffer: async (name, bytes) => {
      const file = path.join(dir, 'buffer'); await fs.writeFile(file, bytes);
      await tmux(['load-buffer', '-b', name, file]);
    },
    execTmux: async args => {
      const result = await tmux(args);
      if (args.includes('paste-buffer')) {
        events.push('paste');
        scroll = scrollSession('isolated-qoder', 2, { execTmux: async args => { events.push('scroll'); return tmux(args); } });
        human = writeTerminalInput('isolated-qoder', 'x', {
          isCurrent: () => true, execTmux: tmux, write: data => { terminal.write(data); events.push('human'); },
        });
      }
      if (args.includes('Enter')) events.push('enter');
      return result;
    },
  });
  await Promise.all([scroll, human]);
  assert.equal(result.submissionStatus, 'attempted');
  assert.deepEqual(events, ['paste', 'enter', 'scroll', 'human']);
  assert.deepEqual(JSON.parse(await fs.readFile(receipt, 'utf8')), { ready: true, text });
  let raw = '';
  for (let tries = 0; raw !== 'x'; tries++) {
    assert.ok(tries < 100, 'the first human byte reaches the receiving process, not just the callback');
    await delay(20);
    raw = await fs.readFile(`${receipt}.raw`, 'utf8').catch(() => '');
  }
  assert.equal((await tmux(['display-message', '-p', '-t', paneId, '#{pane_in_mode}'])).stdout.trim(), '0');
});
