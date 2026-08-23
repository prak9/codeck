import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { agentKindFromCommand, findQoderOpenSessionId, isQoderResumeCommand, paneProcessTree, parseCodexPreview, parseCodexRename, parseCodexSessionIndex, parseProcessList, parseResumedSessionId, parseRolloutFilename, parseRuntimeSessionRegistry, PS_ARGUMENTS, resolveCodexSessionId } from '../src/agents.js';

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

test('resolves a resumed Qoder session from the transcript opened by its process', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeck-qoder-fd-'));
  try {
    const qoderHome = path.join(root, '.qoder');
    const project = path.join(qoderHome, 'projects', '-srv-project');
    const otherProject = path.join(qoderHome, 'projects', '-srv-other');
    const procRoot = path.join(root, 'proc');
    const fdRoot = path.join(procRoot, '105873', 'fd');
    const sessionId = '5ebc3421-1111-4111-8111-111111111111';
    const otherId = 'd0d06e09-2222-4222-8222-222222222222';
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(otherProject, { recursive: true });
    fs.mkdirSync(fdRoot, { recursive: true });
    const transcript = path.join(project, `${sessionId}.jsonl`);
    const otherTranscript = path.join(otherProject, `${otherId}.jsonl`);
    fs.writeFileSync(transcript, [
      JSON.stringify({ type: 'workspace-directories', sessionId, directories: ['/srv/project'] }),
      JSON.stringify({ type: 'assistant', sessionId, cwd: '/srv/project', message: { content: [{ type: 'text', text: 'Done' }] } }),
    ].join('\n'));
    fs.writeFileSync(otherTranscript, JSON.stringify({
      type: 'workspace-directories', sessionId: otherId, directories: ['/srv/other'],
    }));
    fs.symlinkSync(transcript, path.join(fdRoot, '39'));
    fs.symlinkSync(otherTranscript, path.join(fdRoot, '40'));

    assert.equal(findQoderOpenSessionId(
      [{ pid: 105873 }], qoderHome, '/srv/project', { procRoot },
    ), sessionId);
    assert.equal(findQoderOpenSessionId(
      [{ pid: 105873 }], qoderHome, '/srv/missing', { procRoot },
    ), null);
    fs.writeFileSync(otherTranscript, JSON.stringify({
      type: 'workspace-directories', sessionId: otherId, directories: ['/srv/project'],
    }));
    assert.equal(findQoderOpenSessionId(
      [{ pid: 105873 }], qoderHome, '/srv/project', { procRoot },
    ), null, 'ambiguous open transcripts must not be guessed');
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

test('ps is asked for one field per -o, never a comma-joined header', () => {
  // `-o pid=,ppid=,etimes=,args=` is a single pid column headed ",ppid=,etimes=,args="
  // on older procps, because POSIX allows commas inside the header.
  for (const argument of PS_ARGUMENTS) {
    assert.equal(argument.includes(','), false, `"${argument}" would collapse into one column`);
  }
  assert.equal(PS_ARGUMENTS.filter((a) => a.endsWith('=')).length, 4, 'pid, ppid, etimes, args');
});
