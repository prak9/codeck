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
      await createSession({ name: 'agy-work', client: 'agy', cwd: directory, mode }, async (...args) => { calls.push(args); return { stdout: '%27\n' }; });
      assert.equal(calls[0][1].at(-1), directory);
      assert.deepEqual(calls[1], ['tmux', ['send-keys', '-l', '-t', '%27', command]]);
    }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('a missing directory or regular file cannot silently start AGY in the home directory', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codeck-agy-cwd-'));
  try {
    const file = path.join(directory, 'file');
    await fs.writeFile(file, '');
    for (const cwd of [file, path.join(directory, 'missing')]) {
      const calls = [];
      await assert.rejects(createSession({ name: 'agy-work', client: 'agy', cwd }, async (...args) => {
        calls.push(args); return { stdout: '%27\n' };
      }), /工作目录无效/);
      assert.deepEqual(calls, []);
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

test('AGY history pages preserve public errors in order and keep internal retries private', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { AgyAgentBackend } = await import('../src/agy-agent-backend.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codeck-agy-history-'));
  const id = '11111111-2222-3333-4444-555555555555';
  try {
    const db = new DatabaseSync(path.join(root, id + '.db'));
    try {
      db.exec('CREATE TABLE steps(idx INTEGER PRIMARY KEY,step_type INTEGER,step_format INTEGER,step_payload BLOB)');
      const insert = db.prepare('INSERT INTO steps VALUES(?,?,0,?)');
      // AGY ErrorMessage (24) contains ErrorDetails (3) and should_show_user (5).
      for (const [idx, type, hex] of [
        [0,14,'9a0103120141'], [1,15,'a201031a0158'],
        [2,17,'c2010a1a060a01451201582801'], // public "E", internal "X"
        [3,15,'a201030a0142'], [4,14,'9a0103120143'],
        [5,17,'c201081a060a0148120158'], // hidden retry, even with a user text
        [6,17,'c2010a28011a060a0151120158'], // public "Q", flag before details
      ]) {
        insert.run(idx, type, Buffer.from(hex, 'hex'));
      }
    } finally { db.close(); }
    const backend = new AgyAgentBackend(root);
    const latest = backend.openThread(id, { turnLimit: 1 }).thread;
    assert.equal(latest.truncated, true);
    assert.equal(latest.turns[0].items[0].content[0].text, 'C');
    assert.deepEqual(latest.turns[0].items.slice(1), [{ id: 'agy-step-6', type: 'agentError', text: 'Q' }]);
    assert.equal(latest.turns[0].status, 'failed');
    const older = backend.loadThreadHistory(id, { beforeTurnId: latest.oldestTurnId, limit: 2 });
    assert.equal(older.truncated, false);
    assert.deepEqual(older.turns[0].items.map(i => i.text || i.content[0].text), ['A','E','B']);
    assert.notEqual(older.turns[0].status, 'failed', 'a subsequent public reply supersedes the failure');
    assert.throws(() => backend.openThread('../other'), /无效/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('Remote sends AGY multiline input to its bound conversation and checks identity before Enter', async () => {
  const { sendSessionMessage } = await import('../src/tmux.js');
  for (const switched of [true, false]) {
    const keys = [];
    let id = 'first';
    const result = await sendSessionMessage({ provider: 'agy', sessionName: 'work', threadId: id, text: 'one\ntwo', replaceDraft: true }, {
      listTmuxSessions: async () => [{ name: 'work', agent: { id, kind: 'agy', paneId: '%7' } }],
      loadBuffer: async (_, text) => assert.equal(text, 'one\ntwo'),
      waitForPaste: async () => { if (switched) id = 'replacement'; },
      execTmux: async args => keys.push(args),
    });
    assert.equal(keys.filter(args => args.includes('paste-buffer') && args.includes('-p')).length, 1);
    assert.equal(keys.some(args => args.includes('Enter')), !switched);
    assert.equal(result.submissionStatus, switched ? 'unconfirmed' : undefined);
  }
});
