import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pty from 'node-pty';
import { preferLatestClientSize, withoutTmuxEnvironment } from '../src/tmux.js';

const exec = promisify(execFile);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('desktop attach replaces a window-local mobile/manual grid without changing other windows', { timeout: 10000 }, async t => {
  try { await exec('tmux', ['-V']); } catch { t.skip('tmux unavailable'); return; }
  const socket = `codeck-size-test-${process.pid}`;
  const tmux = args => exec('tmux', ['-L', socket, ...args]);
  let terminal;
  t.after(async () => { terminal?.kill(); await tmux(['kill-server']).catch(() => {}); });
  await tmux(['-f', '/dev/null', 'new-session', '-d', '-s', 'desktop', '-x', '37', '-y', '21']);
  await tmux(['new-session', '-d', '-s', 'other', '-x', '80', '-y', '24']);
  await tmux(['set-option', '-w', '-t', '=other:', 'window-size', 'manual']);
  await tmux(['resize-window', '-t', '=desktop:', '-x', '37', '-y', '21']);
  await tmux(['set-option', '-g', 'window-size', 'latest']);
  terminal = pty.spawn('tmux', ['-L', socket, 'attach-session', '-t', '=desktop'], {
    name: 'xterm-256color', cols: 140, rows: 40, env: withoutTmuxEnvironment(process.env),
  });
  terminal.onData(() => {});
  for (let tries = 0; !(await tmux(['list-clients'])).stdout.trim(); tries++) { assert.ok(tries < 50); await wait(20); }
  const width = async () => Number((await tmux(['display-message', '-p', '-t', '=desktop:', '#{window_width}'])).stdout.trim());
  assert.equal(await width(), 37, 'global latest does not override a window-local manual setting');
  await preferLatestClientSize('desktop', { execTmux: tmux, supportsWindowSize: async () => true });
  for (let tries = 0; await width() !== 140 && tries < 50; tries++) await wait(20);
  assert.equal(await width(), 140);
  assert.equal((await tmux(['show-options', '-w', '-v', '-t', '=other:', 'window-size'])).stdout.trim(), 'manual');
});
