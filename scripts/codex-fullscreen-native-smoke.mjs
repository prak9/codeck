// Explicit smoke: real Codex, synthetic offline history, isolated home/tmux server.
// No prompts are submitted and no real conversation is resumed.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import pty from 'node-pty';
import { scrollSession, withoutTmuxEnvironment } from '../src/tmux.js';
const exec = promisify(execFile);
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codeck-native-fullscreen-'));
const socket = `codeck-native-${process.pid}`;
const tmux = args => exec('tmux', ['-L', socket, ...args]);
const id = crypto.randomUUID(), timestamp = new Date().toISOString();
let terminal;
try {
  await fs.mkdir(path.join(dir, 'sessions'));
  const records = [{ timestamp, type: 'session_meta', payload: { id, timestamp, cwd: dir, originator: 'codex_cli_rs', cli_version: '0.160.0', source: 'cli', model_provider: 'openai' } }];
  for (let i = 0; i < 30; i++) {
    const turnId = crypto.randomUUID();
    const reply = Array.from({ length: 15 }, (_, j) => `SAMPLE_${i}_${j}: Offline preserved transcript text.`).join('\n');
    records.push({ timestamp, type: 'event_msg', payload: { type: 'task_started', turn_id: turnId, model_context_window: 128000 } });
    records.push({ timestamp, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `Offline example ${i}` }] } });
    records.push({ timestamp, type: 'event_msg', payload: { type: 'user_message', message: `Offline example ${i}`, images: [], local_images: [] } });
    records.push({ timestamp, type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: reply }] } });
    records.push({ timestamp, type: 'event_msg', payload: { type: 'agent_message', message: reply, phase: 'final_answer' } });
    records.push({ timestamp, type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId, last_agent_message: reply } });
  }
  const rollout = path.join(dir, 'sessions', `rollout-${timestamp.slice(0, 19).replaceAll(':', '-')}-${id}.jsonl`);
  await fs.writeFile(rollout, records.map(r => JSON.stringify(r)).join('\n') + '\n');
  await fs.writeFile(path.join(dir, 'config.toml'), `[tui]\nfullscreen_transcript = true\n[projects."${dir}"]\ntrust_level = "trusted"\n`);
  // Read the existing login only; all CLI metadata and resumed history stay isolated.
  const auth = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');
  await fs.copyFile(auth, path.join(dir, 'auth.json'));
  await fs.chmod(path.join(dir, 'auth.json'), 0o600);
  await tmux(['-f', '/dev/null', 'new-session', '-d', '-s', 'fixture', '-x', '100', '-y', '30', '-c', dir]);
  await tmux(['set-option', '-w', '-t', 'fixture', 'remain-on-exit', 'on']);
  await tmux(['respawn-pane', '-k', '-t', 'fixture', '-c', dir,
    'env', `CODEX_HOME=${dir}`, 'codex', '--no-daemon', '-c', 'check_for_update_on_startup=false', 'resume', id]);
  terminal = pty.spawn('tmux', ['-L', socket, 'attach-session', '-t', 'fixture'], { name: 'xterm-256color', cols: 100, rows: 30, env: withoutTmuxEnvironment(process.env) });
  terminal.onData(() => {});
  const capture = async () => (await tmux(['capture-pane', '-p', '-t', 'fixture'])).stdout;
  let before = '';
  for (let i = 0; i < 150; i++) {
    before = await capture();
    if (before.includes('SAMPLE_29_')) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(before.includes('SAMPLE_29_'), `real Codex loaded synthetic history: ${before}`);
  await tmux(['copy-mode', '-t', 'fixture']);
  await scrollSession('fixture', 24, { execTmux: tmux });
  await new Promise(resolve => setTimeout(resolve, 500));
  const after = await capture();
  assert.notEqual(after, before, 'native scroll changes real Codex history');
  assert.match(after, /SAMPLE_2[0-8]_/);
  assert.doesNotMatch(after, /\[<64;/);
  await scrollSession('fixture', 24, { execTmux: tmux });
  await new Promise(resolve => setTimeout(resolve, 200));
  const next = await capture();
  assert.notEqual(next, after, `consecutive desktop scroll stays native: ${after}`);
  terminal.resize(37, 22);
  await new Promise(resolve => setTimeout(resolve, 300));
  for (let i = 0; i < 12; i++) {
    await scrollSession('fixture', 120, { execTmux: tmux });
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const oldest = await capture();
  assert.match(oldest, /SAMPLE_0_/);
  assert.doesNotMatch(oldest, /\[<64;/);
  for (let i = 0; i < 12; i++) {
    await scrollSession('fixture', -120, { execTmux: tmux });
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const newest = await capture();
  assert.match(newest, /SAMPLE_29_/);
  await tmux(['send-keys', '-t', 'fixture', 'F3']);
  await new Promise(resolve => setTimeout(resolve, 200));
  const search = await capture();
  assert.notEqual(search, newest, 'native F3 opens transcript search');
  console.log('PASS real Codex: desktop/narrow history to first message, native search, no wheel text leaked');
} finally {
  terminal?.kill();
  await tmux(['kill-server']).catch(() => {});
  await fs.rm(dir, { recursive: true, force: true });
}
