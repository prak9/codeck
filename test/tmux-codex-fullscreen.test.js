import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { scrollSession } from '../src/tmux.js';
const exec = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('real tmux: fullscreen history scrolls with mouse off, inherited copy-mode and no draft pollution', { timeout: 10000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codeck-fullscreen-'));
  const socket = `codeck-fullscreen-${process.pid}`;
  const tmux = args => exec('tmux', ['-L', socket, ...args]);
  t.after(async () => {
    await tmux(['kill-server']).catch(() => {});
    await fs.rm(dir, { recursive: true, force: true });
  });
  const receipt = path.join(dir, 'input.json');
  await tmux(['-f', '/dev/null', 'new-session', '-d', '-s', 'fixture', '-x', '80', '-y', '24',
    process.execPath, fileURLToPath(new URL('../scripts/fixtures/codex-fullscreen-tui.mjs', import.meta.url)), receipt]);
  const waitFor = async offset => {
    for (let i = 0; i < 100; i++) {
      const state = await fs.readFile(receipt, 'utf8').then(JSON.parse).catch(() => null);
      if (state?.offset === offset) { assert.equal(state.draft, ''); return; }
      await delay(20);
    }
    assert.fail(`native history should reach offset ${offset}`);
  };
  await waitFor(0);
  await tmux(['copy-mode', '-t', 'fixture']);
  await scrollSession('fixture', 12, { execTmux: tmux });
  await waitFor(12);
  assert.equal((await tmux(['display-message', '-p', '-t', 'fixture', '#{pane_in_mode}'])).stdout.trim(), '0');
  await scrollSession('fixture', -6, { execTmux: tmux });
  await waitFor(6);
  await tmux(['resize-window', '-t', 'fixture', '-x', '37', '-y', '22']);
  await scrollSession('fixture', 6, { execTmux: tmux });
  await waitFor(12);
});
