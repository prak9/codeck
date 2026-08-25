import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { agentKindFromCommand, detectPaneAgents, findCodexHistorySessionId, findDetachedAgentSessionIds, findDetachedAgentSessionIdsFromProc, findQoderOpenSessionId, isQoderResumeCommand, paneProcessTree, parseCodexHistory, parseCodexPreview, parseCodexRename, parseCodexSessionIndex, parseProcessList, parseResumedSessionId, parseRolloutFilename, parseRuntimeSessionRegistry, PS_ARGUMENTS, readPaneProcessTrees, resolveCodexSessionId } from '../src/agents.js';

function writeProcProcess(root, {
  pid, ppid, pgrp = pid, session = pid, startTicks = 0, command = '', children = [], environment = '',
}) {
  const processRoot = path.join(root, String(pid));
  const taskRoot = path.join(processRoot, 'task', String(pid));
  fs.mkdirSync(taskRoot, { recursive: true });
  const fields = ['S', ppid, pgrp, session, ...Array(15).fill(0), startTicks];
  fs.writeFileSync(path.join(processRoot, 'stat'), `${pid} (process ${pid}) ${fields.join(' ')}\n`);
  fs.writeFileSync(path.join(processRoot, 'cmdline'), `${command.split(' ').filter(Boolean).join('\0')}\0`);
  fs.writeFileSync(path.join(processRoot, 'environ'), environment);
  fs.writeFileSync(path.join(taskRoot, 'children'), children.join(' '));
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
    ].join('\n'));

    const agents = await detectPaneAgents([{ session: 'skills', pid: 10, paneId: '%1' }], { CODEX_HOME: codexHome }, {
      procRoot, clockTicks: 100, now: 1_000_000, uptimeMs: 100_000,
      readCodexPaneOutput: async () => '› 深度发挥分析下中芯国际投资价值\n• 正在分析',
    });

    assert.equal(agents.get('skills')?.id, currentId);
    assert.equal(agents.get('skills')?.name, '深度发挥分析下中芯国际投资价值');

    const afterScroll = await detectPaneAgents([{ session: 'skills', pid: 10, paneId: '%1' }], { CODEX_HOME: codexHome }, {
      procRoot, clockTicks: 100, now: 1_000_000, uptimeMs: 100_000,
      readCodexPaneOutput: async () => '• 最终输出很长，当前提示已经滚出捕获范围',
    });
    assert.equal(afterScroll.get('skills')?.id, currentId);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('recognizes supported agent CLI processes', () => {
  assert.equal(agentKindFromCommand('node /usr/bin/codex resume abc'), 'codex');
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
      { pid: 10, ppid: 1, startedAt: 980_000, command: '/bin/bash' },
      { pid: 11, ppid: 10, startedAt: 990_000, command: 'node /usr/bin/codex --yolo' },
      { pid: 12, ppid: 11, startedAt: 995_000, command: '/bin/bash -lc npm test' },
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('discovers detached Agent task leaders from PID 1 children only', () => {
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
    fs.writeFileSync(path.join(root, '60', 'stat'), '60 (firefox) S 999 60 60 0 0 0\n');
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
