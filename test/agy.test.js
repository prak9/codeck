import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validateClient, resolveSessionClientCommand, createSession } from '../src/tmux.js';
import { agentKindFromCommand } from '../src/agents.js';
const exec = promisify(execFile);

test('AGY starts with proxy variables and explicit permission bypass in both launch modes', async () => {
  assert.equal(validateClient('agy'), true);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codeck-agy-launch-'));
  try {
    await fs.writeFile(path.join(directory, 'agy'), '#!/usr/bin/env node\nconsole.log(JSON.stringify({args: process.argv.slice(2), proxy: Object.fromEntries(["HTTP_PROXY","HTTPS_PROXY","ALL_PROXY","http_proxy","https_proxy","all_proxy"].map(k=>[k,process.env[k]])), noProxy: process.env.NO_PROXY}));\n', { mode: 0o700 });
    for (const mode of ['new', 'resume']) {
      const command = resolveSessionClientCommand('agy', mode);
      const { stdout } = await exec('/bin/bash', ['--noprofile', '--norc', '-c', command], {
        env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, BASH_ENV: '/dev/null', HTTP_PROXY: 'http://old.invalid', NO_PROXY: 'localhost,internal.test' },
      });
      const actual = JSON.parse(stdout);
      assert.deepEqual(actual.args, ['--dangerously-skip-permissions', ...(mode === 'resume' ? ['--continue'] : [])]);
      assert.equal(actual.noProxy, 'localhost,internal.test');
      assert.ok(Object.values(actual.proxy).every(value => value === 'http://127.0.0.1:7890'));
      const calls = [];
      await createSession({ name: 'agy-work', client: 'agy', cwd: '/srv/project', mode }, async (...args) => { calls.push(args); return { stdout: '%27\n' }; });
      assert.deepEqual(calls[1], ['tmux', ['send-keys', '-l', '-t', '%27', command]]);
    }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('AGY CLI is identified without treating its management commands as active agents', () => {
  for (const command of ['/home/x/.local/bin/agy --dangerously-skip-permissions', 'agy --continue']) {
    assert.equal(agentKindFromCommand(command), 'agy');
  }
  for (const command of ['agy remote-control start', 'agy acp', 'agy update', '/home/x/.local/bin/agy mic-serve', '/usr/bin/bash']) {
    assert.equal(agentKindFromCommand(command), null);
  }
});
