import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { agentKindFromCommand, detectPaneAgents, findCodexHistorySessionId, findCodexOpenSessionId, findDetachedAgentSessionIds, findDetachedAgentSessionIdsFromProc, findQoderOpenSessionId, isQoderResumeCommand, paneProcessTree, parseCodexHistory, parseCodexPreview, parseCodexRename, parseCodexSessionIndex, parseProcessList, parseResumedSessionId, parseRolloutFilename, parseRuntimeSessionRegistry, PS_ARGUMENTS, readPaneProcessTrees, resolveCodexSessionId, uniqueCodexStartMatch } from '../src/agents.js';

function writeProcProcess(root, {
  pid, ppid, pgrp = pid, session = pid, startTicks = 0, command = '', children = [], environment = '', cwd = null,
}) {
  const processRoot = path.join(root, String(pid));
  const taskRoot = path.join(processRoot, 'task', String(pid));
  fs.mkdirSync(taskRoot, { recursive: true });
  const fields = ['S', ppid, pgrp, session, ...Array(15).fill(0), startTicks];
  fs.writeFileSync(path.join(processRoot, 'stat'), `${pid} (process ${pid}) ${fields.join(' ')}\n`);
  fs.writeFileSync(path.join(processRoot, 'cmdline'), `${command.split(' ').filter(Boolean).join('\0')}\0`);
  fs.writeFileSync(path.join(processRoot, 'environ'), environment);
  fs.writeFileSync(path.join(taskRoot, 'children'), children.join(' '));
  if (cwd) fs.symlinkSync(cwd, path.join(processRoot, 'cwd'));
}

function writeCodexOpenSession({ codexHome, procRoot, id, firstFd = 35, metadata = {} }) {
  const sessions = path.join(codexHome, 'sessions', '2026', '09', '05');
  const locks = path.join(codexHome, 'thread-writer-locks');
  const fdRoot = path.join(procRoot, '11', 'fd');
  for (const directory of [sessions, locks, fdRoot]) fs.mkdirSync(directory, { recursive: true });
  const rollout = path.join(sessions, `rollout-2026-09-05T11-00-36-${id}.jsonl`);
  const lock = path.join(locks, `${id}.lock`);
  const lockFd = path.join(fdRoot, String(firstFd));
  const rolloutFd = path.join(fdRoot, String(firstFd + 1));
  fs.writeFileSync(rollout, `${JSON.stringify({ type: 'session_meta', payload: { id, ...metadata } })}\n`);
  fs.writeFileSync(lock, '');
  fs.symlinkSync(lock, lockFd);
  fs.symlinkSync(rollout, rolloutFd);
  return { rollout, lock, lockFd, rolloutFd };
}

test('latest Codex session name wins for a renamed thread', () => {
  const content = [
    '{"id":"abc","thread_name":"first"}',
    '{"id":"abc","thread_name":"final"}',
    '{partially-written',
  ].join('\n');
  assert.equal(parseCodexSessionIndex(content).get('abc'), 'final');
});

test('uses the first real Codex prompt as the session name, not injected AGENTS context', () => {
  const line = (role, text) => JSON.stringify({
    type: 'response_item', payload: { type: 'message', role, content: [{ type: 'input_text', text }] },
  });
  const content = [
    line('developer', 'developer instructions'),
    line('user', '# AGENTS.md instructions\n\n<INSTRUCTIONS>rules</INSTRUCTIONS>'),
    line('user', '<environment_context>cwd</environment_context>'),
    line('user', 'Review the mobile layout\nand fix overflow'),
    line('user', 'a later follow-up'),
  ].join('\n');

  assert.equal(parseCodexPreview(content), 'Review the mobile layout');
  assert.equal(parseCodexPreview(line('user', 'x'.repeat(300))).length, 160);
});

test('extracts Codex id and local start time from rollout filename', () => {
  const item = parseRolloutFilename('/tmp/rollout-2026-08-15T10-01-32-01a00327-27df-7f12-8505-176abc010ea0.jsonl');
  assert.equal(item.id, '01a00327-27df-7f12-8505-176abc010ea0');
  assert.equal(new Date(item.startedAt).getHours(), 10);
});

test('recovers an interactive Codex resume selection from its writer lock time', () => {
  const selectedId = '01a01f67-bd04-7ca0-afdd-e9f2b59d27d5';
  const newRolloutId = '01a024ba-19cd-78a2-85d2-5151ef55f75b';
  const startedAt = 1_700_000_000_000;
  const codex = {
    writers: [{ id: selectedId, startedAt: startedAt + 6_000 }],
    starts: [{ id: newRolloutId, startedAt: startedAt + 1_000 }],
  };

  assert.equal(resolveCodexSessionId({ command: 'codex --yolo resume', startedAt }, codex), selectedId);
  assert.equal(resolveCodexSessionId({
    command: `codex resume ${newRolloutId}`,
    startedAt,
  }, codex), newRolloutId);
  assert.equal(resolveCodexSessionId({
    command: 'codex --yolo',
    startedAt,
  }, { writers: [{ id: selectedId, startedAt: startedAt - 300_000 }], starts: codex.starts }), newRolloutId);
});

test('a Codex process follows its open thread after an explicit resume forks', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeck-codex-forked-resume-'));
  const procRoot = path.join(root, 'proc');
  const codexHome = path.join(root, 'codex');
  const cwd = path.join(root, 'workspace');
  const parentId = '01a04160-1111-7111-8111-111111111111';
  const childId = '01a04161-2222-7222-8222-222222222222';
  try {
    fs.mkdirSync(cwd, { recursive: true });
    writeProcProcess(procRoot, { pid: 10, ppid: 1, command: '/bin/bash', children: [11] });
    writeProcProcess(procRoot, {
      pid: 11, ppid: 10, startTicks: 9_000,
      command: `node /usr/bin/codex --yolo resume ${parentId}`, cwd,
    });

    const sessions = path.join(codexHome, 'sessions', '2026', '09', '05');
    const locks = path.join(codexHome, 'thread-writer-locks');
    const fdRoot = path.join(procRoot, '11', 'fd');
    fs.mkdirSync(sessions, { recursive: true });
    fs.mkdirSync(locks, { recursive: true });
    fs.mkdirSync(fdRoot, { recursive: true });
    const parentRollout = path.join(sessions, `rollout-2026-09-04T21-20-29-${parentId}.jsonl`);
    const childRollout = path.join(sessions, `rollout-2026-09-05T11-00-36-${childId}.jsonl`);
    fs.writeFileSync(parentRollout, JSON.stringify({
      type: 'session_meta', payload: { id: parentId, session_id: parentId, cwd },
    }));
    fs.writeFileSync(childRollout, [
      JSON.stringify({
        type: 'session_meta',
        payload: { id: childId, session_id: childId, forked_from_id: parentId, cwd },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '子分支的新消息' }] },
      }),
    ].join('\n'));
    const parentLock = path.join(locks, `${parentId}.lock`);
    const childLock = path.join(locks, `${childId}.lock`);
    fs.writeFileSync(parentLock, '');
    fs.writeFileSync(childLock, '');
    const writerFd = path.join(fdRoot, '35');
    const rolloutFd = path.join(fdRoot, '46');
    fs.symlinkSync(parentLock, writerFd);
    fs.symlinkSync(parentRollout, rolloutFd);
    fs.writeFileSync(path.join(codexHome, 'history.jsonl'), JSON.stringify({
      session_id: childId, ts: 100, text: '子分支的新消息',
    }));

    const pane = [{ session: 'codeck', pid: 10, paneId: '%1' }];
    const identityCache = new Map();
    const processTreeCache = new Map();
    const detect = (now) => detectPaneAgents(pane, { CODEX_HOME: codexHome }, {
      procRoot, clockTicks: 100, now, uptimeMs: 100_000,
      identityCache, identityCacheTtlMs: 5_000, processTreeCache,
      readCodexPaneOutput: async () => '› 子分支的新消息\n• 正在分析',
    });

    assert.equal((await detect(1_000_000)).get('codeck')?.id, parentId);
    fs.rmSync(writerFd);
    fs.rmSync(rolloutFd);
    fs.symlinkSync(childLock, writerFd);
    assert.equal(
      (await detect(1_001_000)).get('codeck')?.id,
      parentId,
      'a writer lock without an open rollout is not enough to expose the child',
    );
    fs.symlinkSync(childRollout, rolloutFd);
    assert.equal(
      (await detect(1_002_000)).get('codeck')?.id,
      childId,
      'open descriptors invalidate the cached parent before its TTL',
    );
    writeCodexOpenSession({
      codexHome, procRoot, id: '01a04162-3333-7333-8333-333333333333', firstFd: 50,
      metadata: { thread_source: 'subagent', parent_thread_id: childId },
    });
    writeCodexOpenSession({
      codexHome, procRoot, id: '01a04163-4444-7444-8444-444444444444', firstFd: 60,
      metadata: { source: { subagent: { thread_spawn: { parent_thread_id: childId } } } },
    });
    assert.equal(
      (await detect(1_003_000)).get('codeck')?.id,
      childId,
      'parallel subagents must not make the current fork fall back to its old resume argument',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Codex open-session detection keeps unknown metadata and multiple roots ambiguous', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeck-codex-open-metadata-'));
  const codexHome = path.join(root, 'codex');
  const procRoot = path.join(root, 'proc');
  const rootId = '01a04164-1111-7111-8111-111111111111';
  const otherId = '01a04165-2222-7222-8222-222222222222';
  const detect = () => findCodexOpenSessionId([{ pid: 11 }], codexHome, { procRoot });
  const originalOpen = fs.openSync;
  try {
    const main = writeCodexOpenSession({ codexHome, procRoot, id: rootId, metadata: { thread_source: 'user' } });
    const other = writeCodexOpenSession({ codexHome, procRoot, id: otherId, firstFd: 50 });
    const metadata = (payload) => `${JSON.stringify({ type: 'session_meta', payload })}\n`;
    assert.equal(detect(), null, 'an unknown candidate cannot be assumed to be a subagent');
    fs.writeFileSync(other.rollout, metadata({ id: otherId, thread_source: 'user' }));
    assert.equal(detect(), null, 'two user threads must remain ambiguous');
    fs.writeFileSync(other.rollout, metadata({ id: rootId, thread_source: 'subagent' }));
    assert.equal(detect(), null, 'metadata for a different thread cannot exclude this candidate');
    const subagent = metadata({ id: otherId, thread_source: 'subagent', parent_thread_id: rootId });
    fs.writeFileSync(other.rollout, subagent.slice(0, -5));
    assert.equal(detect(), null, 'a partially written header cannot exclude a candidate');
    fs.appendFileSync(other.rollout, subagent.slice(-5));
    assert.equal(detect(), rootId, 'a completed header is retried immediately');
    let headerReads = 0;
    fs.openSync = function countedHeader(file, ...args) {
      if (file === main.rollout || file === other.rollout) headerReads += 1;
      return originalOpen.call(this, file, ...args);
    };
    assert.equal(detect(), rootId);
    assert.equal(headerReads, 0, 'unchanged metadata is reused while FDs are still checked');
    fs.openSync = originalOpen;

    const replacement = `${other.rollout}.replacement`;
    const previous = fs.statSync(other.rollout);
    fs.writeFileSync(replacement, metadata({
      id: otherId, thread_source: 'user', parent_thread_id: rootId,
    }).padEnd(subagent.length));
    fs.utimesSync(replacement, previous.atimeMs / 1000, previous.mtimeMs / 1000);
    fs.renameSync(replacement, other.rollout);
    assert.equal(detect(), null, 'a replaced rollout invalidates cached subagent metadata');
    fs.writeFileSync(other.rollout, metadata({
      id: otherId, base_instructions: 'x'.repeat(128 * 1024), thread_source: 'subagent',
    }));
    assert.equal(detect(), null, 'a header beyond the bounded read stays ambiguous');
    fs.writeFileSync(other.rollout, metadata({
      id: otherId, thread_source: 'user', source: { subagent: {} },
    }));
    assert.equal(detect(), null, 'a user role cannot be excluded by conflicting source metadata');
    fs.writeFileSync(other.rollout, subagent);
    assert.equal(detect(), rootId, 'an in-place metadata change also invalidates the cache');
    fs.rmSync(main.lockFd);
    fs.rmSync(main.rolloutFd);
    assert.equal(detect(), null, 'a sole subagent is not the pane root');
  } finally {
    fs.openSync = originalOpen;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Codex open-session detection tolerates unreadable metadata and closing descriptors', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeck-codex-open-races-'));
  const codexHome = path.join(root, 'codex');
  const procRoot = path.join(root, 'proc');
  const rootId = '01a04166-1111-7111-8111-111111111111';
  const otherId = '01a04167-2222-7222-8222-222222222222';
  const originalOpen = fs.openSync;
  const originalReadlink = fs.readlinkSync;
  const originalReaddir = fs.readdirSync;
  try {
    writeCodexOpenSession({ codexHome, procRoot, id: rootId, metadata: { thread_source: 'user' } });
    const other = writeCodexOpenSession({
      codexHome, procRoot, id: otherId, firstFd: 50, metadata: { thread_source: 'subagent' },
    });
    const detect = () => findCodexOpenSessionId([{ pid: 11 }, { pid: 12 }], codexHome, { procRoot });
    fs.openSync = function deniedMetadata(file, ...args) {
      if (file === other.rollout) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      return originalOpen.call(this, file, ...args);
    };
    fs.readdirSync = function deniedProcess(directory, ...args) {
      if (directory === path.join(procRoot, '12', 'fd')) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      return originalReaddir.call(this, directory, ...args);
    };
    assert.equal(detect(), null, 'unreadable metadata stays ambiguous');
    fs.openSync = originalOpen;
    assert.equal(detect(), rootId, 'a transient read failure must not be cached');
    fs.readlinkSync = function closedDescriptor(file, ...args) {
      if (file === other.rolloutFd) throw Object.assign(new Error('descriptor closed'), { code: 'ENOENT' });
      return originalReadlink.call(this, file, ...args);
    };
    assert.equal(detect(), rootId, 'an FD closing during the scan is ignored');
  } finally {
    fs.openSync = originalOpen;
    fs.readlinkSync = originalReadlink;
    fs.readdirSync = originalReaddir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Codex FD scans preserve symlink aliases without resolving pipe and socket targets', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeck-codex-open-paths-'));
  const codexHome = path.join(root, 'codex');
  const procRoot = path.join(root, 'proc');
  const sessionId = '01a04168-1111-7111-8111-111111111111';
  const originalRealpath = fs.realpathSync;
  const attemptedPseudoPaths = [];
  try {
    const main = writeCodexOpenSession({ codexHome, procRoot, id: sessionId });
    const homeAlias = path.join(root, 'codex-alias');
    const rolloutAlias = path.join(root, 'transcript-alias');
    fs.symlinkSync(codexHome, homeAlias);
    fs.symlinkSync(main.rollout, rolloutAlias);
    fs.rmSync(main.rolloutFd);
    fs.symlinkSync(path.relative(path.dirname(main.rolloutFd), rolloutAlias), main.rolloutFd);
    for (const [index, target] of ['pipe:[100]', 'socket:[200]', 'anon_inode:[eventpoll]'].entries()) {
      fs.symlinkSync(target, path.join(procRoot, '11', 'fd', String(60 + index)));
    }
    const counted = (resolve) => function observedPath(file, ...args) {
      if (/pipe:\[|socket:\[|anon_inode:/.test(String(file))) attemptedPseudoPaths.push(file);
      return resolve.call(this, file, ...args);
    };
    fs.realpathSync = Object.assign(counted(originalRealpath), { native: counted(originalRealpath.native) });
    assert.equal(findCodexOpenSessionId([{ pid: 11 }], homeAlias, { procRoot }), sessionId);
    assert.deepEqual(attemptedPseudoPaths, [], 'non-file descriptors do not need canonicalization');
    const outside = path.join(root, path.basename(main.rollout));
    fs.writeFileSync(outside, '{}\n');
    fs.rmSync(main.rollout);
    fs.symlinkSync(outside, main.rollout);
    assert.equal(
      findCodexOpenSessionId([{ pid: 11 }], homeAlias, { procRoot }),
      null,
      'a symlink escaping the configured sessions directory is not a valid rollout',
    );
  } finally {
    fs.realpathSync = originalRealpath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('does not expose a fresh Codex writer before its first rollout exists', () => {
  const freshId = '01a028e8-3750-7050-98d2-27078915be46';
  const otherId = '01a028e6-3604-7350-943b-e1455dc6dfd1';
  const startedAt = 1_700_000_000_000;
  const process = { command: 'codex --yolo', startedAt };
  const codex = {
    writers: [{ id: freshId, startedAt: startedAt + 2_000 }],
    starts: [{ id: otherId, startedAt: startedAt - 30_000 }],
  };

  assert.equal(resolveCodexSessionId(process, codex), null);
  codex.starts.push({ id: freshId, startedAt: startedAt + 3_000 });
  assert.equal(resolveCodexSessionId(process, codex), freshId);
});

test('a fresh Codex process prefers its nearby rollout over another session writer', () => {
  const resumedId = '01a01f67-bd04-7ca0-afdd-e9f2b59d27d5';
  const freshId = '01a028e8-3750-7050-98d2-27078915be46';
  const startedAt = 1_700_000_000_000;

  assert.equal(resolveCodexSessionId({ command: 'codex --yolo', startedAt }, {
    writers: [{ id: resumedId, startedAt: startedAt - 96_000 }],
    starts: [
      { id: resumedId, startedAt: startedAt - 86_400_000 },
      { id: freshId, startedAt: startedAt + 2_000 },
    ],
  }), freshId);
});

test('parses process ancestry fields without splitting the command', () => {
  assert.deepEqual(parseProcessList('  12  5  7 node /usr/bin/codex --yolo resume abc', 10_000), [{
    pid: 12, ppid: 5, startedAt: 3_000, command: 'node /usr/bin/codex --yolo resume abc',
  }]);
});

test('extracts the latest renamed Codex session from terminal history', () => {
  const output = '• Session renamed to first. To resume this session run codex resume, then select first (019fe08c-beed-79b0-aef6-b1d4b40506bb)\n'
    + '• Session renamed to test. To resume this session run codex resume, then select test (01a00327-27df-7f12-8505-176abc010ea0)\n';
  assert.deepEqual(parseCodexRename(output), { name: 'test', id: '01a00327-27df-7f12-8505-176abc010ea0' });
});

test('the latest visible Codex prompt follows a thread switch inside a long-lived pane', () => {
  const oldId = '01a028e8-3750-7050-98d2-27078915be46';
  const currentId = '01a03781-258c-7e12-85a9-97f5c8440771';
  const history = parseCodexHistory([
    JSON.stringify({ session_id: oldId, ts: 100, text: '提炼这个链接里的内容' }),
    '{partially-written',
    JSON.stringify({ session_id: currentId, ts: 200, text: '深度发挥分析下中芯国际投资价值' }),
    JSON.stringify({ session_id: currentId, ts: 300, text: '分析中芯国际的投资价值怎么样了' }),
  ].join('\n'));
  const pane = [
    '› 提炼这个链接里的内容',
    '• 已完成旧任务',
    '› 深度发挥分析下中芯国际投',
    '  资价值',
    '• 正在分析',
    '› 分析中芯国际的投资价值怎么样了',
  ].join('\n');

  assert.deepEqual(history.map(({ id, timestamp, text }) => ({ id, timestamp, text })), [
    { id: oldId, timestamp: 100_000, text: '提炼这个链接里的内容' },
    { id: currentId, timestamp: 200_000, text: '深度发挥分析下中芯国际投资价值' },
    { id: currentId, timestamp: 300_000, text: '分析中芯国际的投资价值怎么样了' },
  ]);
  assert.equal(findCodexHistorySessionId(pane, history), currentId);
});

test('Codex output quoting another thread prompt cannot switch the tmux session id', () => {
  const skillsId = '01a03781-258c-7e12-85a9-97f5c8440771';
  const codeckId = '01a01f67-bd04-7ca0-afdd-e9f2b59d27d5';
  const history = parseCodexHistory([
    JSON.stringify({ session_id: skillsId, ts: 100, text: '深度发挥分析下中芯国际投资价值' }),
    JSON.stringify({ session_id: codeckId, ts: 200, text: '普通版的语音录入能否做成类似remote版的操作界面和体验' }),
    JSON.stringify({ session_id: skillsId, ts: 300, text: 'Summarize recent commits' }),
  ].join('\n'));
  const pane = [
    '› 普通版的语音录入能否做成类似remote版的操作界面和体验',
    '',
    '• Reviewed the regression test',
    "  const skillsPrompt = '深度发挥分析下中芯国际投资价值';",
    '',
    '› Summarize recent commits',
    '',
    '  gpt-5.6-sol max · /data/code/codeck',
  ].join('\n');

  assert.equal(findCodexHistorySessionId(pane, history), codeckId);
});

test('a prompt shared by multiple Codex threads is ambiguous', () => {
  const codeckId = '01a01f67-bd04-7ca0-afdd-e9f2b59d27d5';
  const skillsId = '01a03781-258c-7e12-85a9-97f5c8440771';
  const history = parseCodexHistory([
    JSON.stringify({ session_id: codeckId, ts: 100, text: '提交并推送' }),
    JSON.stringify({ session_id: skillsId, ts: 200, text: '提交并推送' }),
  ].join('\n'));

  assert.equal(findCodexHistorySessionId('› 提交并推送', history), null);
  assert.equal(findCodexHistorySessionId('› 提交并推送', history, (id) => id === codeckId), codeckId);
});

test('an old Codex thread resumed from an ambiguous prompt needs one fresh writer lock', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeck-codex-old-resume-'));
  const procRoot = path.join(root, 'proc');
  const codexHome = path.join(root, 'codex');
  const cwd = path.join(root, 'workspace');
  const resumedId = '01a04003-1111-7111-8111-111111111111';
  const otherId = '01a04004-2222-7222-8222-222222222222';
  const processStartedAt = new Date('2026-09-04T17:53:16').getTime();
  try {
    fs.mkdirSync(cwd, { recursive: true });
    writeProcProcess(procRoot, { pid: 10, ppid: 1, command: '/bin/bash', children: [11] });
    writeProcProcess(procRoot, {
      pid: 11, ppid: 10, startTicks: 9_000,
      command: 'node /usr/bin/codex --yolo resume', cwd,
    });
    const sessions = path.join(codexHome, 'sessions', '2026', '08', '22');
    fs.mkdirSync(sessions, { recursive: true });
    const transcript = (id) => JSON.stringify({ type: 'session_meta', payload: { id, cwd } });
    fs.writeFileSync(
      path.join(sessions, `rollout-2026-08-22T10-00-00-${resumedId}.jsonl`),
      transcript(resumedId),
    );
    fs.writeFileSync(
      path.join(sessions, `rollout-2026-08-22T11-00-00-${otherId}.jsonl`),
      transcript(otherId),
    );
    fs.writeFileSync(path.join(codexHome, 'history.jsonl'), [
      JSON.stringify({ session_id: resumedId, ts: 100, text: '怎么样了' }),
      JSON.stringify({ session_id: otherId, ts: 200, text: '怎么样了' }),
    ].join('\n'));
    const locks = path.join(codexHome, 'thread-writer-locks');
    fs.mkdirSync(locks, { recursive: true });
    const resumedLock = path.join(locks, `${resumedId}.lock`);
    const otherLock = path.join(locks, `${otherId}.lock`);
    fs.writeFileSync(resumedLock, '');
    fs.writeFileSync(otherLock, '');
    fs.utimesSync(resumedLock, (processStartedAt + 4_000) / 1_000, (processStartedAt + 4_000) / 1_000);
    fs.utimesSync(otherLock, (processStartedAt + 6_000) / 1_000, (processStartedAt + 6_000) / 1_000);
    const detect = () => detectPaneAgents(
      [{ session: 'research', pid: 10, paneId: '%1' }],
      { CODEX_HOME: codexHome },
      {
        procRoot, clockTicks: 100,
        now: processStartedAt + 10_000, uptimeMs: 100_000,
        readCodexPaneOutput: async () => '› 怎么样了\n• 已完成',
      },
    );

    assert.equal((await detect()).get('research')?.id, null, 'two matching live writers stay ambiguous');
    fs.rmSync(otherLock);
    fs.appendFileSync(path.join(codexHome, 'history.jsonl'), '\n');
    assert.equal((await detect()).get('research')?.id, resumedId);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Codex rollout cwd disambiguates identical prompts in different tmux panes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeck-codex-cwd-'));
  const procRoot = path.join(root, 'proc');
  const codexHome = path.join(root, 'codex');
  const codeckCwd = path.join(root, 'codeck-workspace');
  const skillsCwd = path.join(root, 'skills-workspace');
  const codeckId = '01a04000-1111-7111-8111-111111111111';
  const skillsId = '01a04001-2222-7222-8222-222222222222';
  const oldSkillsId = '01a04002-3333-7333-8333-333333333333';
  try {
    fs.mkdirSync(codeckCwd, { recursive: true });
    fs.mkdirSync(skillsCwd, { recursive: true });
    writeProcProcess(procRoot, { pid: 10, ppid: 1, command: '/bin/bash', children: [11] });
    writeProcProcess(procRoot, { pid: 11, ppid: 10, command: 'node /usr/bin/codex --yolo', cwd: codeckCwd });
    writeProcProcess(procRoot, { pid: 20, ppid: 1, command: '/bin/bash', children: [21] });
    writeProcProcess(procRoot, { pid: 21, ppid: 20, command: 'node /usr/bin/codex --yolo', cwd: skillsCwd });
    writeProcProcess(procRoot, { pid: 30, ppid: 1, command: '/bin/bash', children: [31] });
    writeProcProcess(procRoot, { pid: 31, ppid: 30, command: 'node /usr/bin/codex --yolo', cwd: skillsCwd });
    const sessions = path.join(codexHome, 'sessions', '2026', '08', '25');
    fs.mkdirSync(sessions, { recursive: true });
    const transcript = (id, cwd) => [
      JSON.stringify({ type: 'session_meta', payload: { id, cwd } }),
      JSON.stringify({
        type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '提交并推送' }] },
      }),
    ].join('\n');
    fs.writeFileSync(path.join(sessions, `rollout-2026-08-25T10-00-00-${codeckId}.jsonl`), transcript(codeckId, codeckCwd));
    fs.writeFileSync(path.join(sessions, `rollout-2026-08-25T10-01-00-${oldSkillsId}.jsonl`), transcript(oldSkillsId, skillsCwd));
    fs.writeFileSync(path.join(sessions, `rollout-2026-08-25T10-02-00-${skillsId}.jsonl`), transcript(skillsId, skillsCwd));
    fs.writeFileSync(path.join(codexHome, 'history.jsonl'), [
      JSON.stringify({ session_id: oldSkillsId, ts: 50, text: '提交并推送' }),
      JSON.stringify({ session_id: codeckId, ts: 100, text: '提交并推送' }),
      JSON.stringify({ session_id: skillsId, ts: 150, text: '更新现有 code review skill' }),
      JSON.stringify({ session_id: skillsId, ts: 200, text: '提交并推送' }),
    ].join('\n'));

    const agents = await detectPaneAgents([
      { session: 'codeck-cwd', pid: 10, paneId: '%1' },
      { session: 'skills-cwd', pid: 20, paneId: '%2' },
      { session: 'ambiguous-cwd', pid: 30, paneId: '%3' },
    ], { CODEX_HOME: codexHome }, {
      procRoot, clockTicks: 100, now: new Date('2026-08-25T10:02:40').getTime(), uptimeMs: 100_000,
      readCodexPaneOutput: async (session) => session === 'skills-cwd'
        ? '› 更新现有 code review skill\n• 已完成\n› 提交并推送\n• 已完成'
        : '› 提交并推送\n• 已完成',
    });

    assert.equal(agents.get('codeck-cwd')?.id, codeckId);
    assert.equal(agents.get('skills-cwd')?.id, skillsId);
    assert.equal(agents.get('ambiguous-cwd')?.id, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('detects the current Codex thread after a long-lived tmux process switches threads', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeck-codex-switch-'));
  const procRoot = path.join(root, 'proc');
  const codexHome = path.join(root, 'codex');
  const oldId = '01a028e8-3750-7050-98d2-27078915be46';
  const currentId = '01a03781-258c-7e12-85a9-97f5c8440771';
  try {
    writeProcProcess(procRoot, { pid: 10, ppid: 1, startTicks: 8_000, command: '/bin/bash', children: [11] });
    writeProcProcess(procRoot, { pid: 11, ppid: 10, startTicks: 9_000, command: 'node /usr/bin/codex --yolo' });
    const sessions = path.join(codexHome, 'sessions', '2026', '08', '25');
    fs.mkdirSync(sessions, { recursive: true });
    const promptLine = (text) => JSON.stringify({
      type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
    });
    fs.writeFileSync(path.join(sessions, `rollout-2026-08-22T10-00-00-${oldId}.jsonl`), promptLine('旧任务'));
    fs.writeFileSync(path.join(sessions, `rollout-2026-08-25T10-00-00-${currentId}.jsonl`), promptLine('深度发挥分析下中芯国际投资价值'));
    fs.writeFileSync(path.join(codexHome, 'history.jsonl'), [
      JSON.stringify({ session_id: oldId, ts: 100, text: '提炼这个链接里的内容' }),
      JSON.stringify({ session_id: currentId, ts: 200, text: '深度发挥分析下中芯国际投资价值' }),
      JSON.stringify({ session_id: currentId, ts: 250, text: '提交并推送' }),
      JSON.stringify({ session_id: oldId, ts: 300, text: '提交并推送' }),
    ].join('\n'));

    const agents = await detectPaneAgents([{ session: 'skills', pid: 10, paneId: '%1' }], { CODEX_HOME: codexHome }, {
      procRoot, clockTicks: 100, now: 1_000_000, uptimeMs: 100_000,
      readCodexPaneOutput: async () => '› 深度发挥分析下中芯国际投资价值\n• 正在分析',
    });

    assert.equal(agents.get('skills')?.id, currentId);
    assert.equal(agents.get('skills')?.name, '深度发挥分析下中芯国际投资价值');

    const afterScroll = await detectPaneAgents([{ session: 'skills', pid: 10, paneId: '%1' }], { CODEX_HOME: codexHome }, {
      procRoot, clockTicks: 100, now: 1_000_000, uptimeMs: 100_000,
      readCodexPaneOutput: async () => '› 提交并推送\n• 正在处理',
    });
    assert.equal(afterScroll.get('skills')?.id, currentId);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('reuses a resolved Agent identity until its process signature changes or the cache expires', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeck-agent-identity-cache-'));
  const procRoot = path.join(root, 'proc');
  const codexHome = path.join(root, 'codex');
  const cwd = path.join(root, 'workspace');
  const sessionId = '01a04100-1111-7111-8111-111111111111';
  try {
    fs.mkdirSync(cwd, { recursive: true });
    writeProcProcess(procRoot, { pid: 10, ppid: 1, command: '/bin/bash', children: [11] });
    writeProcProcess(procRoot, {
      pid: 11, ppid: 10, startTicks: 9_000,
      command: 'node /usr/bin/codex --yolo', cwd,
    });
    const sessions = path.join(codexHome, 'sessions', '2026', '08', '29');
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(path.join(sessions, `rollout-2026-08-29T10-00-00-${sessionId}.jsonl`), [
      JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd } }),
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '优化会话扫描' }] },
      }),
    ].join('\n'));
    fs.writeFileSync(path.join(codexHome, 'history.jsonl'), JSON.stringify({
      session_id: sessionId, ts: 100, text: '优化会话扫描',
    }));

    const pane = [{ session: 'performance', pid: 10, paneId: '%1', currentCommand: 'node' }];
    const identityCache = new Map();
    const processTreeCache = new Map();
    let paneReads = 0;
    const detect = (now) => detectPaneAgents(pane, { CODEX_HOME: codexHome }, {
      procRoot,
      clockTicks: 100,
      now,
      uptimeMs: 100_000,
      identityCache,
      identityCacheTtlMs: 5_000,
      processTreeCache,
      readCodexPaneOutput: async () => {
        paneReads += 1;
        return '› 优化会话扫描\n• 正在分析';
      },
    });

    assert.equal((await detect(1_000_000)).get('performance')?.id, sessionId);
    assert.equal((await detect(1_001_000)).get('performance')?.id, sessionId);
    assert.equal(paneReads, 1, 'an unchanged process should reuse its resolved identity');

    fs.writeFileSync(path.join(procRoot, '11', 'cmdline'), 'node\0/usr/bin/codex\0--yolo\0--search\0');
    assert.equal((await detect(1_002_000)).get('performance')?.id, sessionId);
    assert.equal(paneReads, 2, 'a command change must invalidate the cached identity');

    assert.equal((await detect(1_006_000)).get('performance')?.id, sessionId);
    assert.equal(paneReads, 2);
    assert.equal((await detect(1_008_000)).get('performance')?.id, sessionId);
    assert.equal(paneReads, 3, 'stable processes are periodically revalidated for renames and thread switches');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a new visible Codex prompt invalidates a cached identity before its TTL', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeck-agent-prompt-cache-'));
  const procRoot = path.join(root, 'proc');
  const codexHome = path.join(root, 'codex');
  const cwd = path.join(root, 'workspace');
  const firstId = '01a04110-1111-7111-8111-111111111111';
  const secondId = '01a04111-2222-7222-8222-222222222222';
  try {
    fs.mkdirSync(cwd, { recursive: true });
    writeProcProcess(procRoot, { pid: 10, ppid: 1, command: '/bin/bash', children: [11] });
    writeProcProcess(procRoot, {
      pid: 11, ppid: 10, startTicks: 9_000,
      command: 'node /usr/bin/codex --yolo', cwd,
    });
    const sessions = path.join(codexHome, 'sessions', '2026', '08', '29');
    fs.mkdirSync(sessions, { recursive: true });
    const transcript = (id, text) => [
      JSON.stringify({ type: 'session_meta', payload: { id, cwd } }),
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
      }),
    ].join('\n');
    fs.writeFileSync(
      path.join(sessions, `rollout-2026-08-29T10-00-00-${firstId}.jsonl`),
      transcript(firstId, '第一个会话'),
    );
    fs.writeFileSync(
      path.join(sessions, `rollout-2026-08-29T10-01-00-${secondId}.jsonl`),
      transcript(secondId, '第二个会话'),
    );
    fs.writeFileSync(path.join(codexHome, 'history.jsonl'), [
      JSON.stringify({ session_id: firstId, ts: 100, text: '第一个会话' }),
      JSON.stringify({ session_id: secondId, ts: 200, text: '第二个会话' }),
    ].join('\n'));

    const pane = [{ session: 'switching', pid: 10, paneId: '%1', currentCommand: 'node' }];
    const identityCache = new Map();
    const processTreeCache = new Map();
    const paneOutputs = new Map([['switching', '› 第一个会话\n• 已完成']]);
    let deepOutput = paneOutputs.get('switching');
    let paneReads = 0;
    const detect = (now) => detectPaneAgents(pane, { CODEX_HOME: codexHome }, {
      procRoot,
      clockTicks: 100,
      now,
      uptimeMs: 100_000,
      identityCache,
      identityCacheTtlMs: 5_000,
      processTreeCache,
      paneOutputs,
      readCodexPaneOutput: async () => {
        paneReads += 1;
        return deepOutput;
      },
    });

    assert.equal((await detect(1_000_000)).get('switching')?.id, firstId);
    paneOutputs.set('switching', '› 第二个会话\n• 正在分析');
    deepOutput = paneOutputs.get('switching');
    assert.equal((await detect(1_001_000)).get('switching')?.id, secondId);
    assert.equal(paneReads, 2, 'a thread switch must not wait for the cache TTL');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('does not cache an unresolved Agent identity while its transcript is still starting', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeck-agent-pending-cache-'));
  const procRoot = path.join(root, 'proc');
  const codexHome = path.join(root, 'codex');
  const cwd = path.join(root, 'workspace');
  const sessionId = '01a04101-2222-7222-8222-222222222222';
  try {
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(codexHome, { recursive: true });
    writeProcProcess(procRoot, { pid: 10, ppid: 1, command: '/bin/bash', children: [11] });
    writeProcProcess(procRoot, {
      pid: 11, ppid: 10, startTicks: 9_000,
      command: 'node /usr/bin/codex --yolo', cwd,
    });
    const pane = [{ session: 'starting', pid: 10, paneId: '%1' }];
    const identityCache = new Map();
    let paneOutput = '';
    let paneReads = 0;
    const detect = (now) => detectPaneAgents(pane, { CODEX_HOME: codexHome }, {
      procRoot,
      clockTicks: 100,
      now,
      uptimeMs: 100_000,
      identityCache,
      identityCacheTtlMs: 5_000,
      readCodexPaneOutput: async () => {
        paneReads += 1;
        return paneOutput;
      },
    });

    assert.equal((await detect(1_000_000)).get('starting')?.id, null);

    const sessions = path.join(codexHome, 'sessions', '2026', '08', '29');
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(path.join(sessions, `rollout-2026-08-29T10-00-00-${sessionId}.jsonl`), [
      JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd } }),
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '刚建立的会话' }] },
      }),
    ].join('\n'));
    fs.writeFileSync(path.join(codexHome, 'history.jsonl'), JSON.stringify({
      session_id: sessionId, ts: 100, text: '刚建立的会话',
    }));
    paneOutput = '› 刚建立的会话\n• 正在分析';

    assert.equal((await detect(1_001_000)).get('starting')?.id, sessionId);
    assert.equal(paneReads, 2, 'a pending process must be retried before the normal cache TTL');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a runtime registry session switch invalidates a cached Agent identity before its TTL', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeck-agent-registry-switch-'));
  const procRoot = path.join(root, 'proc');
  const qoderHome = path.join(root, 'qoder');
  const cwd = path.join(root, 'workspace');
  const firstId = '01a04120-1111-7111-8111-111111111111';
  const secondId = '01a04121-2222-7222-8222-222222222222';
  try {
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(path.join(qoderHome, 'sessions'), { recursive: true });
    writeProcProcess(procRoot, { pid: 10, ppid: 1, command: '/bin/bash', children: [11] });
    writeProcProcess(procRoot, {
      pid: 11, ppid: 10, startTicks: 9_000,
      command: 'node /usr/bin/qodercli --resume --yolo', cwd,
    });
    const registry = path.join(qoderHome, 'sessions', '11.json');
    const identityCache = new Map();
    const processTreeCache = new Map();
    const detect = (now) => detectPaneAgents(
      [{ session: 'switching', pid: 10, paneId: '%1' }],
      { QODER_CONFIG_DIR: qoderHome },
      {
        procRoot, clockTicks: 100, now, uptimeMs: 100_000,
        identityCache, identityCacheTtlMs: 5_000, processTreeCache,
      },
    );

    fs.writeFileSync(registry, JSON.stringify({ sessionId: firstId, cwd }));
    assert.equal((await detect(1_000_000)).get('switching')?.id, firstId);

    fs.writeFileSync(registry, JSON.stringify({ sessionId: secondId, cwd }));
    assert.equal(
      (await detect(1_001_000)).get('switching')?.id,
      secondId,
      'a same-process /new or /resume must switch identities without waiting for the cache TTL',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a Claude registry session switch invalidates its cached identity before the TTL', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeck-claude-registry-switch-'));
  const procRoot = path.join(root, 'proc');
  const claudeHome = path.join(root, 'claude');
  const cwd = path.join(root, 'workspace');
  const firstId = '01a04122-1111-7111-8111-111111111111';
  const secondId = '01a04123-2222-7222-8222-222222222222';
  try {
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(path.join(claudeHome, 'sessions'), { recursive: true });
    writeProcProcess(procRoot, { pid: 10, ppid: 1, command: '/bin/bash', children: [11] });
    writeProcProcess(procRoot, {
      pid: 11, ppid: 10, startTicks: 9_000,
      command: 'node /usr/bin/claude --resume', cwd,
    });
    const registry = path.join(claudeHome, 'sessions', '11.json');
    const identityCache = new Map();
    const processTreeCache = new Map();
    const detect = (now) => detectPaneAgents(
      [{ session: 'switching', pid: 10, paneId: '%1' }],
      { CLAUDE_CONFIG_DIR: claudeHome },
      {
        procRoot, clockTicks: 100, now, uptimeMs: 100_000,
        identityCache, identityCacheTtlMs: 5_000, processTreeCache,
      },
    );

    fs.writeFileSync(registry, JSON.stringify({ sessionId: firstId, cwd }));
    assert.equal((await detect(1_000_000)).get('switching')?.id, firstId);
    fs.writeFileSync(registry, JSON.stringify({ sessionId: secondId, cwd }));
    assert.equal((await detect(1_001_000)).get('switching')?.id, secondId);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('indexes Claude transcripts once and reuses known session paths for later audits', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeck-claude-transcript-index-'));
  const procRoot = path.join(root, 'proc');
  const claudeHome = path.join(root, 'claude');
  const projectsRoot = path.join(claudeHome, 'projects', 'workspace');
  const identityCache = new Map();
  const processTreeCache = new Map();
  const ids = [
    '01a04124-1111-7111-8111-111111111111',
    '01a04125-2222-7222-8222-222222222222',
  ];
  const originalReaddirSync = fs.readdirSync;
  let projectDirectoryReads = 0;
  try {
    fs.mkdirSync(projectsRoot, { recursive: true });
    writeProcProcess(procRoot, { pid: 1, ppid: 0, children: [10, 20] });
    const panes = ids.map((id, index) => {
      const pid = (index + 1) * 10;
      writeProcProcess(procRoot, {
        pid, ppid: 1, startTicks: 8_000 + index,
        command: '/bin/bash', children: [pid + 1],
      });
      writeProcProcess(procRoot, {
        pid: pid + 1, ppid: pid, startTicks: 9_000 + index,
        command: `node /usr/bin/claude --resume ${id}`,
      });
      fs.writeFileSync(path.join(projectsRoot, `${id}.jsonl`), JSON.stringify({
        sessionId: id, slug: `claude-session-${index}`,
      }));
      return { session: `claude-${index}`, pid, paneId: `%${index + 1}`, currentCommand: 'node' };
    });
    fs.readdirSync = function countedRead(directory, ...args) {
      if (String(directory).startsWith(path.join(claudeHome, 'projects'))) projectDirectoryReads += 1;
      return originalReaddirSync.call(this, directory, ...args);
    };
    const detect = (now) => detectPaneAgents(panes, { CLAUDE_CONFIG_DIR: claudeHome }, {
      procRoot, clockTicks: 100, now, uptimeMs: 100_000,
      identityCache, identityCacheTtlMs: 5_000, processTreeCache,
    });

    const first = await detect(1_000_000);
    assert.deepEqual([...first.values()].map((agent) => agent.name), [
      'claude-session-0', 'claude-session-1',
    ]);
    assert.equal(projectDirectoryReads, 2, 'one recursive index should serve both Claude sessions');

    projectDirectoryReads = 0;
    await detect(1_006_000);
    assert.equal(projectDirectoryReads, 0, 'known transcript paths should survive identity cache audits');
  } finally {
    fs.readdirSync = originalReaddirSync;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a Qoder segment FD switch invalidates a cached bare-resume identity before its TTL', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeck-qoder-fd-switch-'));
  const procRoot = path.join(root, 'proc');
  const qoderHome = path.join(root, 'qoder');
  const cwd = path.join(root, 'workspace');
  const projectName = '-workspace';
  const firstId = '01a04130-1111-7111-8111-111111111111';
  const secondId = '01a04131-2222-7222-8222-222222222222';
  try {
    fs.mkdirSync(cwd, { recursive: true });
    writeProcProcess(procRoot, { pid: 10, ppid: 1, command: '/bin/bash', children: [11] });
    writeProcProcess(procRoot, {
      pid: 11, ppid: 10, startTicks: 9_000,
      command: 'node /usr/bin/qodercli --resume --yolo', cwd,
    });
    const fdRoot = path.join(procRoot, '11', 'fd');
    const projectRoot = path.join(qoderHome, 'projects', projectName);
    fs.mkdirSync(fdRoot, { recursive: true });
    fs.mkdirSync(projectRoot, { recursive: true });
    const segmentFor = (id) => path.join(
      qoderHome, 'logs', 'sessions', projectName, id, 'segments', 'current.jsonl',
    );
    for (const id of [firstId, secondId]) {
      const segment = segmentFor(id);
      fs.mkdirSync(path.dirname(segment), { recursive: true });
      fs.writeFileSync(segment, '{"level":"info"}\n');
      fs.writeFileSync(path.join(projectRoot, `${id}.jsonl`), JSON.stringify({
        type: 'workspace-directories', sessionId: id, directories: [cwd],
      }));
    }
    const descriptor = path.join(fdRoot, '39');
    fs.symlinkSync(segmentFor(firstId), descriptor);
    const identityCache = new Map();
    const processTreeCache = new Map();
    const detect = (now) => detectPaneAgents(
      [{ session: 'switching', pid: 10, paneId: '%1' }],
      { QODER_CONFIG_DIR: qoderHome },
      {
        procRoot, clockTicks: 100, now, uptimeMs: 100_000,
        identityCache, identityCacheTtlMs: 5_000, processTreeCache,
      },
    );

    assert.equal((await detect(1_000_000)).get('switching')?.id, firstId);
    fs.rmSync(descriptor);
    fs.symlinkSync(segmentFor(secondId), descriptor);
    assert.equal(
      (await detect(1_001_000)).get('switching')?.id,
      secondId,
      'QoderCLI 1.1.28 exposes the active bare-resume session through its segment FD',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('recognizes supported agent CLI processes', () => {
  assert.equal(agentKindFromCommand('node /usr/bin/codex resume abc'), 'codex');
  assert.equal(agentKindFromCommand('/home/x/.local/bin/codex --remote unix:///data/.codex/app-server-control/app-server-control.sock resume 01a02936-cfd6-7eb1-8a66-d18af33402c5'), 'codex');
  assert.equal(agentKindFromCommand('/home/x/.local/bin/codex app-server --listen unix:///tmp/codex.sock'), null);
  assert.equal(agentKindFromCommand('/usr/local/bin/claude --resume abc'), 'claude');
  assert.equal(agentKindFromCommand('/opt/qoder/bin/qodercli --continue'), 'qodercli');
  assert.equal(agentKindFromCommand('/bin/bash'), null);
});

test('extracts explicit Claude and Qoder session ids from CLI arguments', () => {
  const id = '01a00327-27df-7f12-8505-176abc010ea0';
  assert.equal(parseResumedSessionId(`claude --resume ${id}`), id);
  assert.equal(parseResumedSessionId(`qodercli -r ${id}`), id);
  assert.equal(parseResumedSessionId(`qodercli --session-id=${id}`), id);
  assert.equal(parseResumedSessionId('qodercli --continue'), null);
});

test('recognizes Qoder commands that resume without an explicit session id', () => {
  assert.equal(isQoderResumeCommand('qodercli --resume --yolo'), true);
  assert.equal(isQoderResumeCommand('qodercli --continue'), true);
  assert.equal(isQoderResumeCommand('qodercli --yolo'), false);
});

test('resolves a resumed Qoder session from its open segment log and validates the main transcript', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeck-qoder-fd-'));
  try {
    const qoderHome = path.join(root, '.qoder');
    const project = path.join(qoderHome, 'projects', '-srv-project');
    const logProject = path.join(qoderHome, 'logs', 'sessions', '-srv-project');
    const procRoot = path.join(root, 'proc');
    const fdRoot = path.join(procRoot, '105873', 'fd');
    const sessionId = '5ebc3421-1111-4111-8111-111111111111';
    const temporaryId = '1b59ca82-2222-4222-8222-222222222222';
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(fdRoot, { recursive: true });
    const transcript = path.join(project, `${sessionId}.jsonl`);
    const temporaryTranscript = path.join(project, `${temporaryId}.jsonl`);
    const segment = path.join(logProject, sessionId, 'segments', '2026-08-23T10-00-00-p105873.jsonl');
    const temporarySegment = path.join(logProject, temporaryId, 'segments', '2026-08-23T09-59-59-p105873.jsonl');
    fs.mkdirSync(path.dirname(segment), { recursive: true });
    fs.mkdirSync(path.dirname(temporarySegment), { recursive: true });
    fs.writeFileSync(transcript, [
      JSON.stringify({ type: 'workspace-directories', sessionId, directories: ['/srv/project'] }),
      JSON.stringify({ type: 'assistant', sessionId, cwd: '/srv/project', message: { content: [{ type: 'text', text: 'Done' }] } }),
    ].join('\n'));
    fs.writeFileSync(segment, '{"level":"info"}\n');
    fs.writeFileSync(temporarySegment, '{"level":"info"}\n');
    fs.symlinkSync(segment, path.join(fdRoot, '39'));
    fs.symlinkSync(temporarySegment, path.join(fdRoot, '40'));

    assert.equal(findQoderOpenSessionId(
      [{ pid: 105873 }], qoderHome, '/srv/project', { procRoot },
    ), sessionId);
    assert.equal(findQoderOpenSessionId(
      [{ pid: 105873 }], qoderHome, '/srv/missing', { procRoot },
    ), null);
    fs.writeFileSync(temporaryTranscript, JSON.stringify({
      type: 'workspace-directories', sessionId: temporaryId, directories: ['/srv/project'],
    }));
    assert.equal(findQoderOpenSessionId(
      [{ pid: 105873 }], qoderHome, '/srv/project', { procRoot },
    ), null, 'ambiguous validated segment sessions must not be guessed');

    fs.rmSync(temporaryTranscript);
    fs.rmSync(path.join(fdRoot, '39'));
    fs.rmSync(path.join(fdRoot, '40'));
    fs.symlinkSync(transcript, path.join(fdRoot, '41'));
    assert.equal(findQoderOpenSessionId(
      [{ pid: 105873 }], qoderHome, '/srv/project', { procRoot },
    ), sessionId, 'direct project transcript FDs remain supported');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('reads the session registry written by current Claude and Qoder CLIs', () => {
  const id = '01a00327-27df-7f12-8505-176abc010ea0';
  assert.deepEqual(parseRuntimeSessionRegistry(JSON.stringify({ sessionId: id, cwd: '/srv/project' })), {
    id, cwd: '/srv/project',
  });
  assert.equal(parseRuntimeSessionRegistry('{incomplete'), null);
  assert.equal(parseRuntimeSessionRegistry('{"sessionId":"not-a-uuid","cwd":"/srv/project"}'), null);
});

test('a ps format this build cannot parse yields no agents rather than bad ones', () => {
  // Older procps reads `-o pid=,ppid=,etimes=,args=` as one pid column headed
  // ",ppid=,etimes=,args=", so every row is a bare number.
  assert.deepEqual(parseProcessList('  12\n  34\n  56', 10_000), []);
});

test('process rows still parse when the command itself contains spaces', () => {
  const rows = parseProcessList('  12  5  7 node /usr/bin/qodercli --continue\n  13  12  3 bash', 10_000);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].command, 'node /usr/bin/qodercli --continue');
  assert.equal(agentKindFromCommand(rows[0].command), 'qodercli');
});

test('the pane root process is included when an Agent replaces the shell', () => {
  const processes = parseProcessList([
    '  12  5  7 /opt/qoder/qodercli',
    '  13  12  3 /bin/bash -lc npm test',
    '  14  9  2 unrelated',
  ].join('\n'), 10_000);

  assert.deepEqual(paneProcessTree(12, processes).map((process) => process.pid), [12, 13]);
});

test('reads only each pane process tree from procfs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeck-pane-proc-'));
  try {
    writeProcProcess(root, {
      pid: 10, ppid: 1, pgrp: 10, session: 10, startTicks: 8_000,
      command: '/bin/bash', children: [11],
    });
    writeProcProcess(root, {
      pid: 11, ppid: 10, pgrp: 10, session: 10, startTicks: 9_000,
      command: 'node /usr/bin/codex --yolo', children: [12],
    });
    writeProcProcess(root, {
      pid: 12, ppid: 11, pgrp: 10, session: 10, startTicks: 9_500,
      command: '/bin/bash -lc npm test',
    });
    writeProcProcess(root, {
      pid: 99, ppid: 1, pgrp: 99, session: 99, startTicks: 1,
      command: 'unrelated daemon',
    });

    const trees = readPaneProcessTrees([{ session: 'work', pid: 10 }], {
      procRoot: root, clockTicks: 100, now: 1_000_000, uptimeMs: 100_000,
    });
    assert.deepEqual(trees.get('work'), [
      { pid: 10, ppid: 1, startTicks: 8_000, startedAt: 980_000, command: '/bin/bash' },
      { pid: 11, ppid: 10, startTicks: 9_000, startedAt: 990_000, command: 'node /usr/bin/codex --yolo' },
      { pid: 12, ppid: 11, startTicks: 9_500, startedAt: 995_000, command: '/bin/bash -lc npm test' },
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('reuses an unchanged pane process tree without rereading process details', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeck-pane-proc-cache-'));
  const processTreeCache = new Map();
  const originalReadFileSync = fs.readFileSync;
  let detailReads = 0;
  try {
    writeProcProcess(root, {
      pid: 10, ppid: 1, startTicks: 8_000,
      command: '/bin/bash', children: [11],
    });
    writeProcProcess(root, {
      pid: 11, ppid: 10, startTicks: 9_000,
      command: 'node /usr/bin/codex --yolo',
    });
    const pane = [{ session: 'work', pid: 10, paneId: '%1', currentCommand: 'codex' }];
    const first = readPaneProcessTrees(pane, {
      procRoot: root, clockTicks: 100, now: 1_000_000, uptimeMs: 100_000,
      processTreeCache,
    });
    fs.readFileSync = function countedRead(file, ...args) {
      if (/\/10\/(?:stat|cmdline)$/.test(String(file))) detailReads += 1;
      return originalReadFileSync.call(this, file, ...args);
    };
    const second = readPaneProcessTrees(pane, {
      procRoot: root, clockTicks: 100, now: 1_001_000, uptimeMs: 101_000,
      processTreeCache,
    });

    assert.equal(detailReads, 0);
    assert.equal(second.get('work'), first.get('work'));
  } finally {
    fs.readFileSync = originalReadFileSync;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('staggers cold pane process tree audits within the safety window', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeck-pane-proc-cache-stagger-'));
  const processTreeCache = new Map();
  const now = 1_000_000;
  const ttl = 5_000;
  try {
    const panes = ['one', 'two', 'three'].map((session, index) => {
      const pid = 10 + index;
      writeProcProcess(root, { pid, ppid: 1, startTicks: 8_000 + index, command: '/bin/bash' });
      return { session, pid, paneId: `%${index + 1}`, currentCommand: 'bash' };
    });

    readPaneProcessTrees(panes, {
      procRoot: root, clockTicks: 100, now, uptimeMs: 100_000,
      processTreeCache, processTreeCacheTtlMs: ttl,
    });

    const deadlines = [...processTreeCache.values()].map((entry) => entry.expiresAt);
    assert.ok(new Set(deadlines).size > 1);
    assert.ok(deadlines.every((deadline) => deadline > now && deadline <= now + ttl));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('pane process tree observations invalidate on topology changes and expire for command audits', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeck-pane-proc-cache-invalidation-'));
  const processTreeCache = new Map();
  const pane = [{ session: 'work', pid: 10, paneId: '%1', currentCommand: 'node' }];
  const read = (now) => readPaneProcessTrees(pane, {
    procRoot: root, clockTicks: 100, now, uptimeMs: 100_000,
    processTreeCache, processTreeCacheTtlMs: 5_000,
  }).get('work');
  try {
    writeProcProcess(root, {
      pid: 10, ppid: 1, startTicks: 8_000,
      command: '/bin/bash', children: [11],
    });
    writeProcProcess(root, {
      pid: 11, ppid: 10, startTicks: 9_000,
      command: 'node /usr/bin/codex --yolo',
    });
    assert.deepEqual(read(1_000_000).map((process) => process.pid), [10, 11]);

    writeProcProcess(root, {
      pid: 10, ppid: 1, startTicks: 8_000,
      command: '/bin/bash', children: [11, 12],
    });
    writeProcProcess(root, {
      pid: 12, ppid: 10, startTicks: 9_500,
      command: '/bin/bash -lc npm test',
    });
    assert.deepEqual(read(1_001_000).map((process) => process.pid), [10, 11, 12]);

    writeProcProcess(root, {
      pid: 11, ppid: 10, startTicks: 9_000,
      command: 'node /usr/bin/claude --resume',
    });
    assert.equal(
      read(1_007_000).find((process) => process.pid === 11)?.command,
      'node /usr/bin/claude --resume',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('discovers detached Agent task leaders without scanning unrelated process trees', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeck-detached-proc-'));
  const codexId = '01a028e3-8058-73e0-bfc7-e7643f298b0f';
  const attachedId = '81207e37-ab34-4c76-973a-0ebabb4a6560';
  const unrelatedId = '5ebc3421-1111-4111-8111-111111111111';
  try {
    writeProcProcess(root, { pid: 1, ppid: 0, children: [20, 30, 40] });
    writeProcProcess(root, {
      pid: 20, ppid: 1, environment: `CODEX_THREAD_ID=${codexId}\0`,
    });
    writeProcProcess(root, {
      pid: 30, ppid: 1, environment: `CLAUDE_CODE_SESSION_ID=${attachedId}\0`,
    });
    writeProcProcess(root, {
      pid: 40, ppid: 1, pgrp: 20, session: 20,
      environment: `QODER_SESSION_ID=${unrelatedId}\0`,
    });
    writeProcProcess(root, {
      pid: 50, ppid: 1, environment: `QODER_SESSION_ID=${unrelatedId}\0`,
    });

    assert.deepEqual(findDetachedAgentSessionIdsFromProc(new Set([30]), { procRoot: root }), new Set([codexId]));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('reuses unchanged detached process observations without rereading commands or environments', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeck-detached-cache-'));
  const codexId = '01a04140-1111-7111-8111-111111111111';
  const observationCache = new Map();
  const originalReadFileSync = fs.readFileSync;
  let commandReads = 0;
  let environmentReads = 0;
  try {
    writeProcProcess(root, { pid: 1, ppid: 0, children: [20] });
    writeProcProcess(root, {
      pid: 20, ppid: 1, startTicks: 2_000,
      command: '/bin/bash -lc worker',
      environment: `CODEX_THREAD_ID=${codexId}\0`,
    });
    fs.readFileSync = function countedRead(file, ...args) {
      if (String(file).endsWith('/cmdline')) commandReads += 1;
      if (String(file).endsWith('/environ')) environmentReads += 1;
      return originalReadFileSync.call(this, file, ...args);
    };

    assert.deepEqual(
      findDetachedAgentSessionIdsFromProc(new Set(), { procRoot: root, observationCache }),
      new Set([codexId]),
    );
    commandReads = 0;
    environmentReads = 0;
    assert.deepEqual(
      findDetachedAgentSessionIdsFromProc(new Set(), { procRoot: root, observationCache }),
      new Set([codexId]),
    );
    assert.equal(commandReads, 0);
    assert.equal(environmentReads, 0);
  } finally {
    fs.readFileSync = originalReadFileSync;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('staggers cold detached process audits within the safety window', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeck-detached-cache-stagger-'));
  const observationCache = new Map();
  const now = 1_000_000;
  const ttl = 5_000;
  try {
    writeProcProcess(root, { pid: 1, ppid: 0, children: [20, 21, 22] });
    for (const pid of [20, 21, 22]) {
      writeProcProcess(root, {
        pid, ppid: 1, startTicks: 2_000 + pid,
        command: `/bin/bash -lc worker-${pid}`,
      });
    }

    findDetachedAgentSessionIdsFromProc(new Set(), {
      procRoot: root, observationCache, observationCacheTtlMs: ttl, now,
    });

    const deadlines = [...observationCache.values()].map((entry) => entry.expiresAt);
    assert.ok(new Set(deadlines).size > 1);
    assert.ok(deadlines.every((deadline) => deadline > now && deadline <= now + ttl));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('detached process observations invalidate immediately for new and reused PIDs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeck-detached-cache-invalidation-'));
  const firstId = '01a04141-1111-7111-8111-111111111111';
  const secondId = '01a04142-2222-7222-8222-222222222222';
  const observationCache = new Map();
  try {
    writeProcProcess(root, { pid: 1, ppid: 0, children: [20] });
    writeProcProcess(root, {
      pid: 20, ppid: 1, startTicks: 2_000,
      command: '/bin/bash -lc first', environment: `CODEX_THREAD_ID=${firstId}\0`,
    });
    assert.deepEqual(
      findDetachedAgentSessionIdsFromProc(new Set(), { procRoot: root, observationCache }),
      new Set([firstId]),
    );

    writeProcProcess(root, { pid: 1, ppid: 0, children: [20, 21] });
    writeProcProcess(root, {
      pid: 21, ppid: 1, startTicks: 2_100,
      command: '/bin/bash -lc second', environment: `QODER_SESSION_ID=${secondId}\0`,
    });
    assert.deepEqual(
      findDetachedAgentSessionIdsFromProc(new Set(), { procRoot: root, observationCache }),
      new Set([firstId, secondId]),
    );

    writeProcProcess(root, { pid: 1, ppid: 0, children: [20] });
    writeProcProcess(root, {
      pid: 20, ppid: 1, startTicks: 3_000,
      command: '/bin/bash -lc reused', environment: `QODER_SESSION_ID=${secondId}\0`,
    });
    assert.deepEqual(
      findDetachedAgentSessionIdsFromProc(new Set(), { procRoot: root, observationCache }),
      new Set([secondId]),
    );
    assert.deepEqual([...observationCache.keys()], [20]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Agent detection shares detached process observations across session refreshes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeck-agent-detached-cache-'));
  const codexId = '01a04143-3333-7333-8333-333333333333';
  const detachedProcessObservationCache = new Map();
  const originalReadFileSync = fs.readFileSync;
  let detachedCommandReads = 0;
  let detachedEnvironmentReads = 0;
  try {
    writeProcProcess(root, { pid: 1, ppid: 0, children: [20] });
    writeProcProcess(root, { pid: 10, ppid: 1, command: '/bin/bash' });
    writeProcProcess(root, {
      pid: 20, ppid: 1, startTicks: 2_000,
      command: '/bin/bash -lc worker', environment: `CODEX_THREAD_ID=${codexId}\0`,
    });
    fs.writeFileSync(path.join(root, 'uptime'), '100 0\n');
    fs.readFileSync = function countedRead(file, ...args) {
      if (String(file).endsWith('/20/cmdline')) detachedCommandReads += 1;
      if (String(file).endsWith('/20/environ')) detachedEnvironmentReads += 1;
      return originalReadFileSync.call(this, file, ...args);
    };
    const detect = () => detectPaneAgents(
      [{ session: 'shell', pid: 10, paneId: '%1', currentCommand: 'bash' }],
      {},
      {
        procRoot: root, clockTicks: 100, now: 1_000_000, uptimeMs: 100_000,
        detachedProcessObservationCache,
      },
    );

    await detect();
    detachedCommandReads = 0;
    detachedEnvironmentReads = 0;
    await detect();
    assert.equal(detachedCommandReads, 0);
    assert.equal(detachedEnvironmentReads, 0);
  } finally {
    fs.readFileSync = originalReadFileSync;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('staggers cold Agent identity audits within the safety window', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeck-agent-identity-stagger-'));
  const procRoot = path.join(root, 'proc');
  const identityCache = new Map();
  const processTreeCache = new Map();
  const now = 1_000_000;
  const ttl = 5_000;
  const ids = [
    '01a04150-1111-7111-8111-111111111111',
    '01a04151-2222-7222-8222-222222222222',
    '01a04152-3333-7333-8333-333333333333',
  ];
  try {
    writeProcProcess(procRoot, { pid: 1, ppid: 0, children: [10, 20, 30] });
    const panes = ids.map((id, index) => {
      const pid = (index + 1) * 10;
      writeProcProcess(procRoot, {
        pid, ppid: 1, startTicks: 8_000 + index,
        command: '/bin/bash', children: [pid + 1],
      });
      writeProcProcess(procRoot, {
        pid: pid + 1, ppid: pid, startTicks: 9_000 + index,
        command: `node /usr/bin/qodercli --resume ${id} --yolo`,
      });
      return { session: `work-${index}`, pid, paneId: `%${index + 1}`, currentCommand: 'node' };
    });

    await detectPaneAgents(panes, { QODER_CONFIG_DIR: path.join(root, 'qoder') }, {
      procRoot, clockTicks: 100, now, uptimeMs: 100_000,
      identityCache, identityCacheTtlMs: ttl, processTreeCache,
    });

    const deadlines = [...identityCache.values()].map((entry) => entry.expiresAt);
    assert.equal(deadlines.length, panes.length);
    assert.equal(new Set(deadlines).size, deadlines.length);
    assert.ok(deadlines.every((deadline) => deadline > now && deadline <= now + ttl));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('discovers a live unified-exec leader below its app-server parent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeck-unified-exec-proc-'));
  const codexId = '01a01f67-bd04-7ca0-afdd-e9f2b59d27d5';
  try {
    writeProcProcess(root, { pid: 1, ppid: 0, children: [80] });
    writeProcProcess(root, {
      pid: 80, ppid: 1, pgrp: 70, session: 70, children: [81],
      command: 'node /usr/local/bin/codex app-server --listen unix://',
    });
    writeProcProcess(root, {
      pid: 81, ppid: 80, pgrp: 70, session: 70,
      command: '/usr/local/lib/codex app-server --listen unix://',
    });
    fs.mkdirSync(path.join(root, '81', 'task', '83'), { recursive: true });
    fs.writeFileSync(path.join(root, '81', 'task', '83', 'children'), '82');
    writeProcProcess(root, {
      pid: 82, ppid: 81, environment: `CODEX_THREAD_ID=${codexId}\0`,
    });

    assert.deepEqual(findDetachedAgentSessionIdsFromProc(new Set(), { procRoot: root }), new Set([codexId]));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('finds detached tasks by Agent session id without counting the Agent process tree', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeck-agent-background-'));
  const codexId = '01a028e3-8058-73e0-bfc7-e7643f298b0f';
  const claudeId = '81207e37-ab34-4c76-973a-0ebabb4a6560';
  const qoderId = '5ebc3421-1111-4111-8111-111111111111';
  const staleUtilityId = '11111111-2222-4333-8444-555555555555';
  const orphanHelperId = '66666666-7777-4888-8999-aaaaaaaaaaaa';
  const processes = [
    { pid: 10, ppid: 1 },
    { pid: 11, ppid: 10 },
    { pid: 20, ppid: 1 },
    { pid: 30, ppid: 1 },
    { pid: 40, ppid: 1 },
    { pid: 50, ppid: 1 },
    { pid: 60, ppid: 999 },
    { pid: 70, ppid: 1 },
  ];
  try {
    for (const process of processes) fs.mkdirSync(path.join(root, String(process.pid)), { recursive: true });
    fs.writeFileSync(path.join(root, '11', 'environ'), `CODEX_THREAD_ID=${codexId}\0`);
    fs.writeFileSync(path.join(root, '20', 'environ'), `PATH=/usr/bin\0CODEX_THREAD_ID=${codexId}\0`);
    fs.writeFileSync(path.join(root, '30', 'environ'), `CLAUDE_CODE_SESSION_ID=${claudeId}\0`);
    fs.writeFileSync(path.join(root, '40', 'environ'), `QODER_SESSION_ID=${qoderId}\0`);
    fs.writeFileSync(path.join(root, '50', 'environ'), 'CODEX_THREAD_ID=not-a-session\0');
    fs.writeFileSync(path.join(root, '60', 'environ'), `CODEX_THREAD_ID=${staleUtilityId}\0`);
    fs.writeFileSync(path.join(root, '70', 'environ'), `CODEX_THREAD_ID=${orphanHelperId}\0`);
    for (const pid of [20, 30, 40]) {
      fs.writeFileSync(path.join(root, String(pid), 'stat'), `${pid} (worker) S 1 ${pid} ${pid} 0 0 0\n`);
    }
    fs.writeFileSync(path.join(root, '60', 'stat'), '60 (firefox) S 999 60 999 0 0 0\n');
    fs.writeFileSync(path.join(root, '70', 'stat'), '70 (crashhelper) S 1 60 60 0 0 0\n');

    assert.deepEqual(findDetachedAgentSessionIds(
      processes, new Set([10, 11]), { procRoot: root },
    ), new Set([codexId, claudeId, qoderId]));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ps is asked for one field per -o, never a comma-joined header', () => {
  // `-o pid=,ppid=,etimes=,args=` is a single pid column headed ",ppid=,etimes=,args="
  // on older procps, because POSIX allows commas inside the header.
  for (const argument of PS_ARGUMENTS) {
    assert.equal(argument.includes(','), false, `"${argument}" would collapse into one column`);
  }
  assert.equal(PS_ARGUMENTS.filter((a) => a.endsWith('=')).length, 4, 'pid, ppid, etimes, args');
});

test('an ambiguous pane still resolves when its start time matches exactly one rollout', () => {
  // 现场情形: research 与 report 两个 codex 会话共用 cwd /home/x/py, 可见文本
  // 去不掉歧义, 于是身份被整个放弃 —— 正文与历史全空。但进程启动时刻与它自己的
  // rollout 是秒级吻合且唯一的, 这条线索原本被丢掉了。
  const startedAt = 1_700_000_000_000;
  const codex = {
    starts: [
      { id: 'aaaaaaaa-0000-4000-8000-000000000001', startedAt: startedAt + 5_000 },
      { id: 'bbbbbbbb-0000-4000-8000-000000000002', startedAt: startedAt + 400_000 },
    ],
    writers: [{ id: 'aaaaaaaa-0000-4000-8000-000000000001', startedAt: startedAt + 1_000 }],
  };
  assert.equal(
    uniqueCodexStartMatch({ startedAt }, codex),
    'aaaaaaaa-0000-4000-8000-000000000001',
  );
});

test('two rollouts started together stay ambiguous and are refused', () => {
  // 猜错的后果是把别的会话的对话显示到这边, 所以只有唯一时才认。
  const startedAt = 1_700_000_000_000;
  const codex = {
    starts: [
      { id: 'aaaaaaaa-0000-4000-8000-000000000001', startedAt: startedAt + 2_000 },
      { id: 'bbbbbbbb-0000-4000-8000-000000000002', startedAt: startedAt + 4_000 },
    ],
  };
  assert.equal(uniqueCodexStartMatch({ startedAt }, codex), null);
});

test('a rollout already claimed by another pane is not reused', () => {
  const startedAt = 1_700_000_000_000;
  const codex = {
    starts: [{ id: 'aaaaaaaa-0000-4000-8000-000000000001', startedAt: startedAt + 3_000 }],
    writers: [{ id: 'aaaaaaaa-0000-4000-8000-000000000001', startedAt: startedAt + 1_000 }],
  };
  assert.equal(uniqueCodexStartMatch({ startedAt }, codex, new Set(['aaaaaaaa-0000-4000-8000-000000000001'])), null);
});

test('a start time far from every rollout resolves to nothing', () => {
  const startedAt = 1_700_000_000_000;
  const codex = { starts: [{ id: 'aaaaaaaa-0000-4000-8000-000000000001', startedAt: startedAt + 600_000 }] };
  assert.equal(uniqueCodexStartMatch({ startedAt }, codex), null);
});

test('a rollout with no live writer lock is refused', () => {
  // 早已结束的会话也可能恰好落在启动时间窗口里; writer lock 是活进程才持有的,
  // 缺了它就不能认 —— 否则会把陈旧会话安到别的 pane 上。
  const startedAt = 1_700_000_000_000;
  const codex = { starts: [{ id: 'aaaaaaaa-0000-4000-8000-000000000001', startedAt: startedAt + 3_000 }] };
  assert.equal(uniqueCodexStartMatch({ startedAt }, codex), null);
});
