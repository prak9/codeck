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

const agyMenu = (focus = 0, effort = 0) => [
  'Switch Model', '', '  Search:', '          ────────────────────', '',
  ...['Gemini 4 Argon', 'GPT-OSS 120B (Medium)'].map((label, i) =>
    (i === focus ? '> ' : '  ') + label + (i === 0 ? '  (current)' : '')),
  '', '  Effort  ◂ ' + (effort ? '●━━━━◉' : '◉────○') + ' ▸', '            low  high',
  'Keyboard: ↑/↓ Navigate  ←/→ Effort  enter Select  esc Go Back',
].join('\n');

test('AGY /model returns the live picker without pasting into its search, and waits for a newly opened picker', async () => {
  const { sendSessionMessage } = await import('../src/tmux.js');
  const target = { provider: 'agy', sessionName: 'label', threadId: 'thread-1', text: '/model' };
  for (const alreadyOpen of [true, false]) {
    const keys = [];
    let reads = 0;
    const result = await sendSessionMessage(target, {
      listTmuxSessions: async () => [{ name: 'label', agent: { kind: 'agy', id: 'thread-1', paneId: '%7' } }],
      capturePane: async () => alreadyOpen || (keys.includes('Enter') && ++reads >= 2)
        ? 'private transcript\n───────\n>\n───────\n' + agyMenu() + '\n\n   Gemini 4 Argon · low' : '>\n───\n? for shortcuts',
      loadBuffer: async () => {}, execTmux: async args => keys.push(args.at(-1)), waitForPaste: async () => {},
      waitForSlashOutput: async () => {},
    });
    assert.deepEqual(result.commandOutput?.parsed.models, ['Gemini 4 Argon', 'GPT-OSS 120B (Medium)']);
    assert.equal(result.commandOutput.parsed.highlighted, 'Gemini 4 Argon');
    assert.doesNotMatch(result.terminalOutput, /private transcript/);
    assert.equal(keys.filter(k => k === 'Enter').length, alreadyOpen ? 0 : 1);
  }
});

test('AGY model preview, effort, confirm and cancel only send keys to a verified live picker', async () => {
  const { selectSessionCommand, dismissSessionCommand } = await import('../src/tmux.js');
  const target = { provider: 'agy', sessionName: 'label', threadId: 'thread-1', command: '/model' };
  let focus = 0, effort = 0, closed = false;
  const keys = [];
  const io = {
    listTmuxSessions: async () => [{ name: 'label', agent: { kind: 'agy', id: 'thread-1', paneId: '%7' } }],
    capturePane: async () => '───────\n>\n───────\n' + (closed ? agyMenu() + '\n>\n─────────────────\n? for shortcuts' : agyMenu(focus, effort)),
    execTmux: async args => { const key = args.at(-1); keys.push(key);
      if (key === 'Down') focus = 1;
      if (key === 'Right') effort = 1;
      if (['Enter', 'Escape'].includes(key)) closed = true;
    }, waitForSlashOutput: async () => {},
  };
  const option = 'GPT-OSS 120B (Medium)';
  const preview = await selectSessionCommand({ ...target, option, menuText: agyMenu() }, io);
  assert.equal(preview.commandOutput.parsed.highlighted, option);
  const adjusted = await selectSessionCommand({ ...target, option: '→', menuText: preview.terminalOutput }, io);
  assert.match(adjusted.terminalOutput, /●━━━━◉/);
  await assert.rejects(selectSessionCommand({ ...target, option: 'Enter', menuText: preview.terminalOutput }, io));
  assert.equal((await selectSessionCommand({ ...target, option: 'Enter', menuText: adjusted.terminalOutput }, io)).completed, true);
  assert.deepEqual(keys, ['Down','Right','Enter']);
  assert.equal((await dismissSessionCommand({ ...target, command: '/model' }, io)).dismissed, false);
  closed = false;
  assert.equal((await dismissSessionCommand({ ...target, command: '/model' }, io)).dismissed, true);
  assert.deepEqual(keys, ['Down','Right','Enter','Escape']);
});

test('AGY nested menus, information views and wrapped keyboard hints expose only actions on the active overlay', async () => {
  const { agyCommandMenu } = await import('../src/agy-command-menu.js');
  const frame = 'private transcript\n────────────\n>\n────────────\n';
  for (const [body, command, keys] of [
    ['Antigravity CLI   general    commands    shortcuts   (←/→ or tab to cycle)\nVersion 1.5\nKeyboard: ↑/↓ Navigate  ←/→ Switch View\n  esc Close', '/help', ['↑','↓','←','→']],
    ['Permissions — Project\nNo allowlist rules.\nKeyboard: ↑/↓ Navigate  ←/→ Switch View  a Add rule  esc Close', '/permissions', ['↑','↓','←','→','a']],
    ['PreToolUse — Matchers\n > + Add new matcher...\n  ↑/↓ Navigate · enter Select · e Toggle · backspace Delete · esc Back', '/hooks', ['↑','↓','Enter','e','Backspace']],
    ['└ Context Usage\nRelated: /artifact\n  ↑/↓ Scroll · pgup/pgdown Page · ctrl+end Bottom · ctrl+home Top · esc Close', '/context', ['↑','↓','PgUp','PgDn','Ctrl+End','Ctrl+Home']],
  ]) {
    const dialog = agyCommandMenu(frame + body + '\n\n        Gemini 4 Argon · medium');
    assert.equal(dialog?.command, command);
    assert.deepEqual(dialog.parsed.items.map(item => item.label), keys);
    assert.doesNotMatch(dialog.text, /private transcript/);
    assert.equal(agyCommandMenu(frame + body + '\n' + frame + '? for shortcuts'), null);
  }
  const full = ' Diff  All Changes  Per Turn  Commit Tree\n\n  No changes.\n  ←/→ switch view · esc dismiss\n        Gemini 4 Argon · medium';
  assert.equal(agyCommandMenu(full)?.command, '/diff');
  assert.equal(agyCommandMenu(full + '\n' + frame + '? for shortcuts'), null);
  assert.equal(agyCommandMenu(frame + '> /model   Set a model\n  ↑/↓ Navigate · enter Select · tab Complete\nesc to cancel   Gemini'), null);
});

test('a fresh AGY session can show and retire its native menu before its first conversation has an ID', async () => {
  const { tmuxSessionsToThreads, applyTmuxSnapshot } = await import('../public/agent-model.js');
  const { currentCommandOutput } = await import('../public/remote-command-output.js');
  const commandMenu = { command: '/model', text: agyMenu() };
  const session = { name: 'new', agent: { kind: 'agy', commandMenu } };
  const [thread] = tmuxSessionsToThreads([session]);
  assert.equal(currentCommandOutput(thread), commandMenu);
  delete session.agent.commandMenu;
  applyTmuxSnapshot(thread, tmuxSessionsToThreads([session])[0].tmux);
  assert.equal(currentCommandOutput(thread), undefined);
});

test('AGY menu text is pasted literally without submitting and a stale input field rejects further text', async () => {
  const { selectSessionCommand } = await import('../src/tmux.js');
  const { agyCommandMenu } = await import('../src/agy-command-menu.js');
  const target = { provider: 'agy', sessionName: 'label', threadId: 'thread-1', command: '/permissions' };
  const frame = '─────────\n>\n─────────\n';
  let body = 'Add Rule — Project — allowlist\nEnter a permission rule:\n\nFormat: action(target)\nKeyboard: ↑/↓ Navigate\tenter Select  esc Close';
  const before = agyCommandMenu(frame + body);
  assert.deepEqual(before.parsed.items.map(item => item.label), ['↑','↓','Enter']);
  const input = 'example with spaces';
  const calls = [];
  const io = {
    listTmuxSessions: async () => [{name: 'label', agent: {kind: 'agy', id: 'thread-1', paneId: '%7'}}],
    capturePane: async () => frame + body,
    loadBuffer: async (_, text) => assert.equal(text, input),
    execTmux: async args => { calls.push(args); body = body.replace('Format:', input + '\nFormat:'); },
    waitForSlashOutput: async () => {},
  };
  const choose = text => selectSessionCommand({...target, menuText: before.text, option: '输入', input: text}, io);
  await assert.rejects(choose('one\ntwo'));
  const after = await choose(input);
  assert.ok(after.commandOutput.text.includes(input));
  await assert.rejects(choose(input));
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('paste-buffer'));
  assert.ok(!calls[0].includes('Enter'));
});
