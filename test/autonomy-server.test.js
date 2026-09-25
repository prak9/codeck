import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import https from 'node:https';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { WebSocket } from 'ws';

test('server forwards phase-specific send guards and verified task cancellation to the tmux adapter', async () => {
  const source = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  let options; const sends = []; const stops = [];
  const agentRegistry = {
    prepareSessionMessage: async () => ({}), recordSessionMessage() {},
    sendSessionMessage: async (provider, params) => { sends.push({ provider, ...params }); return { submissionStatus: 'submitted' }; },
    interruptSession: async (provider, params) => { stops.push({ provider, ...params }); },
  };
  vm.runInNewContext(source.slice(source.indexOf('const autonomy = new AutonomyController('), source.indexOf('const sessionFeed =')), {
    AutonomyController: function (value) { options = value; },
    path, os, process: { env: {} }, crypto: { randomUUID: () => 'fixture-command' },
    agentRegistry, invalidateSessionSnapshots: async () => {},
  });
  const target = { provider: 'codex', tmuxSession: 'research', threadId: 'thread-1', paneId: '%7' };
  const guard = () => true;
  await options.send(target, 'Setup', guard, { requireIdle: false, nonInterrupting: true });
  await options.send(target, 'Round', guard, { requireIdle: true, nonInterrupting: true });
  await options.stop(target, guard);
  assert.deepEqual(sends.map(value => value.requireIdle), [false, true]);
  for (const value of [...sends, ...stops]) {
    assert.equal(value.provider, 'codex'); assert.equal(value.sessionName, 'research');
    assert.equal(value.threadId, 'thread-1'); assert.equal(value.expectedPaneId, '%7');
    assert.equal(value.isCurrent, guard);
  }
  assert.equal(sends.every(value => value.nonInterrupting), true);
  assert.equal(stops[0].waitForIdle, true);
});

test('isolated server restores autonomy paused and exposes it only to the owner API', { timeout: 15_000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeck-autonomy-server-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = { provider: 'codex', threadId: 'fixture-thread', tmuxSession: 'fixture-missing' };
  fs.writeFileSync(path.join(dir, 'autonomy.json'), JSON.stringify({ version: 1, runs: [{
    id: 'fixture', target, status: 'running', round: 2, paneId: '%987654', pending: null,
    exchange: { text: 'Never replay this', nonce: 'fixture' },
    plan: { goal: 'Fixture only', acceptance: 'No terminal writes', preferences: 'No work', maxRounds: 3 },
  }] }));
  const reservation = net.createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening'); const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, ['src/server.js'], { cwd: new URL('..', import.meta.url),
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), CODECK_TOKEN: 'isolated-autonomy-test',
      CODECK_WEB_AUTH: '0', CODECK_DATA_DIR: dir, CODECK_TLS_CERT: '', CODECK_TLS_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
  });
  let output = '';
  await new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => { output += chunk; if (output.includes('Codeck is running')) resolve(); });
    child.stderr.on('data', chunk => { output += chunk; });
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Server exited ${code}: ${output}`)));
  });
  const denied = new WebSocket(`wss://127.0.0.1:${port}/agent`, { rejectUnauthorized: false });
  const [error] = await once(denied, 'error'); assert.match(error.message, /401/);
  const socket = new WebSocket(`wss://127.0.0.1:${port}/agent?streamVersion=2`,
    [`codeck.${Buffer.from('isolated-autonomy-test').toString('base64url')}`], { rejectUnauthorized: false });
  t.after(() => socket.terminate());
  const [raw] = await once(socket, 'message'); const ready = JSON.parse(raw);
  assert.equal(ready.type, 'ready'); assert.equal(ready.autonomy[0].status, 'paused');
  assert.equal(ready.autonomy[0].round, 2); assert.equal(ready.autonomy[0].exchange, undefined);
  const stored = JSON.parse(fs.readFileSync(path.join(dir, 'autonomy.json'))).runs[0];
  assert.equal(stored.exchange, null); assert.equal(stored.pending, null);
  const html = await new Promise((resolve, reject) => {
    https.get(`https://127.0.0.1:${port}/remote.html`, { rejectUnauthorized: false }, response => {
      let body = ''; response.on('data', chunk => { body += chunk; }); response.on('end', () => resolve(body));
    }).on('error', reject);
  });
  assert.match(html, /id="autonomyButton"/);
});
