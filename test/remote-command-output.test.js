import test from 'node:test';
import assert from 'node:assert/strict';
import { parseModelCommandOutput, parseSkillsCommandOutput } from '../public/remote-command-output.js';

test('parses skills command output into a structured list', () => {
  const parsed = parseSkillsCommandOutput(`
Skills
14 skills
• web-design    Design, build, and verify web interfaces
copy-output — 复制最近输出
status-model   查看状态和模型
这是一条说明
`);

  assert.equal(parsed.heading, 'Skills');
  assert.equal(parsed.count, '14 skills');
  assert.deepEqual(parsed.items, [
    { label: 'web-design', description: 'Design, build, and verify web interfaces' },
    { label: 'copy-output', description: '复制最近输出' },
    { label: 'status-model', description: '查看状态和模型' },
  ]);
  assert.deepEqual(parsed.notes, ['这是一条说明']);
});

test('falls back to raw notes when the output is not a skill list', () => {
  const parsed = parseSkillsCommandOutput('Model: gpt-5\nContext: 80% left');
  assert.equal(parsed.heading, 'Skills');
  assert.equal(parsed.count, '');
  assert.deepEqual(parsed.items, []);
  assert.deepEqual(parsed.notes, ['Model: gpt-5', 'Context: 80% left']);
});

test('parses model command output into a selectable list', () => {
  const parsed = parseModelCommandOutput(`
Current model
2 models
• gpt-5.6-codex     High reasoning
• gpt-5.6-codex-mini Fast
Current model: gpt-5.6-codex
`);

  assert.equal(parsed.heading, 'Current model');
  assert.equal(parsed.count, '2 models');
  assert.equal(parsed.selected, 'gpt-5.6-codex');
  assert.deepEqual(parsed.items, [
    { label: 'gpt-5.6-codex', description: 'High reasoning' },
    { label: 'gpt-5.6-codex-mini', description: 'Fast' },
  ]);
  assert.deepEqual(parsed.notes, []);
});

test('keeps plain model output as raw notes when no list is present', () => {
  const parsed = parseModelCommandOutput('Model: gpt-5\nContext: 80% left');
  assert.equal(parsed.heading, 'Model');
  assert.equal(parsed.count, '');
  assert.equal(parsed.selected, '');
  assert.deepEqual(parsed.items, []);
  assert.deepEqual(parsed.notes, ['Model: gpt-5', 'Context: 80% left']);
});
