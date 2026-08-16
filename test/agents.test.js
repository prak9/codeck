import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentKindFromCommand, parseCodexRename, parseCodexSessionIndex, parseProcessList, parseRolloutFilename, resolveAgentSessionActivity } from '../src/agents.js';

test('latest Codex session name wins for a renamed thread', () => {
  const content = [
    '{"id":"abc","thread_name":"first"}',
    '{"id":"abc","thread_name":"final"}',
    '{partially-written',
  ].join('\n');
  assert.equal(parseCodexSessionIndex(content).get('abc'), 'final');
});

test('extracts Codex id and local start time from rollout filename', () => {
  const item = parseRolloutFilename('/tmp/rollout-2026-08-15T10-01-32-01a00327-27df-7f12-8505-176abc010ea0.jsonl');
  assert.equal(item.id, '01a00327-27df-7f12-8505-176abc010ea0');
  assert.equal(new Date(item.startedAt).getHours(), 10);
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

test('uses CLAUDE_CONFIG_DIR as activity lookup root for claude sessions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeck-test-claude-'));
  const logRoot = path.join(root, '.claude');
  const logDir = path.join(logRoot, 'projects');
  const id = '019fe08c-beed-79b0-aef6-b1d4b40506bb';
  const logFile = path.join(logDir, `${id}.jsonl`);
  const before = Date.now() - 2_000;

  try {
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(logFile, JSON.stringify({ thread_id: id }));
    fs.utimesSync(logFile, before / 1000, before / 1000);
    const activity = resolveAgentSessionActivity({ kind: 'claude', id, name: null }, { CLAUDE_CONFIG_DIR: logRoot });
    assert.ok(Number.isFinite(activity));
    assert.equal(activity <= Date.now(), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('uses QODER_HOME as activity lookup root for qodercli sessions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeck-test-qoder-'));
  const logRoot = path.join(root, '.qoder');
  const id = '01a00327-27df-7f12-8505-176abc010ea0';
  const logFile = path.join(logRoot, `${id}.jsonl`);
  const before = Date.now() - 2_000;

  try {
    fs.mkdirSync(logRoot, { recursive: true });
    fs.writeFileSync(logFile, JSON.stringify({ thread_id: id }));
    fs.utimesSync(logFile, before / 1000, before / 1000);
    const activity = resolveAgentSessionActivity({ kind: 'qodercli', id, name: null }, { QODER_HOME: logRoot });
    assert.ok(Number.isFinite(activity));
    assert.equal(activity <= Date.now(), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
