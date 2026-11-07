import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createTelegramTask } from '../src/telegram-task.js';
test('new task starts via one tmux creation with an initial CLI prompt, not paste/Enter', async () => {
  const calls = [];
  const result = await createTelegramTask({ name: 'tg-123-0', provider: 'codex', cwd: os.tmpdir(), text: "check 'quotes'\n$(not-a-command)" },
    async (file, args) => { calls.push({ file, args }); return { stdout: '%123\n' }; });
  assert.equal(calls.length, 1); assert.equal(calls[0].args[0], 'new-session');
  assert.ok(!calls[0].args.includes('send-keys'));
  assert.equal(result.paneId, '%123'); assert.equal(result.threadId, null);
  assert.match(calls[0].args.at(-1), /codex --no-alt-screen/);
  await assert.rejects(createTelegramTask({ name: 'bad;name', provider: 'codex', cwd: os.tmpdir(), text: 'work' }));
  await assert.rejects(createTelegramTask({ name: 'fine', provider: 'shell', cwd: os.tmpdir(), text: 'work' }));
});

test('the startup shell preserves a multiline prompt as data, including shell substitutions and leading flags', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codeck-prompt-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const resultFile = path.join(directory, 'args'); const executable = path.join(directory, 'fake-agent');
  await fs.writeFile(executable, `#!/bin/bash\nprintf '%s\\0' "$@" > '${resultFile}'\n`, { mode: 0o700 });
  const sentinel = path.join(directory, 'must-not-exist');
  const prompt = `--help\n'quoted' $(touch ${sentinel}) \`touch ${sentinel}\``;
  await createTelegramTask({ name: 'isolated', provider: 'codex', cwd: directory, text: prompt }, async (_file, args) => {
    const command = args.at(-1).replace(/^codex/, `'${executable}'`).replace(/; exec bash -l$/, '');
    await promisify(execFile)('bash', ['-c', command]); return { stdout: '%1' };
  });
  const args = (await fs.readFile(resultFile, 'utf8')).split('\0');
  assert.equal(args.at(-2), prompt); assert.equal(args.at(-3), '--');
  await assert.rejects(fs.stat(sentinel), { code: 'ENOENT' });
});

test('isolated tmux pane receives one initial prompt and remains available after CLI exit', async t => {
  const exec = promisify(execFile);
  try { await exec('tmux', ['-V']); } catch (e) { if (e.code === 'ENOENT') return t.skip('tmux unavailable'); throw e; }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codeck-tmux-task-'));
  const socket = `codeck-task-test-${process.pid}`;
  t.after(async () => { await exec('tmux', ['-L', socket, 'kill-server']).catch(() => {}); await fs.rm(directory, { recursive: true, force: true }); });
  const script = path.join(directory, 'agent'); const output = path.join(directory, 'prompt');
  await fs.writeFile(script, `#!/bin/bash\nprintf '%s\\0' "$@" > '${output}'\n`, { mode: 0o700 });
  const prompt = "只读研究\n保留 'quoted' 和 $HOME，不修改项目";
  const target = await createTelegramTask({ name: 'isolated', provider: 'codex', cwd: directory, text: prompt }, async (_cmd, args) => {
    args[args.length - 1] = args.at(-1).replace(/^codex/, `'${script}'`);
    return exec('tmux', ['-L', socket, '-f', '/dev/null', ...args]);
  });
  let data;
  for (let i = 0; i < 50; i++) { try { data = await fs.readFile(output, 'utf8'); break; } catch { await new Promise(r => setTimeout(r, 50)); } }
  assert.equal(data?.split('\0').at(-2), prompt);
  assert.match(target.paneId, /^%\d+$/);
  await exec('tmux', ['-L', socket, 'has-session', '-t', 'isolated']);
});
