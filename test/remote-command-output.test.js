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

test('parses the current Codex numbered model picker without treating its notes as models', () => {
  const parsed = parseModelCommandOutput(`
Select Model and Effort
Access legacy models by running codex -m <model_name>

› 1. gpt-5.6-sol (current)  Latest frontier model
  2. gpt-5.6-terra          Optimized for coding
  3. gpt-5.5-codex          Previous generation

Press enter to confirm or esc to go back
`);

  assert.equal(parsed.heading, 'Select Model and Effort');
  assert.equal(parsed.selected, 'gpt-5.6-sol');
  assert.deepEqual(parsed.items, [
    { label: 'gpt-5.6-sol', description: 'Latest frontier model' },
    { label: 'gpt-5.6-terra', description: 'Optimized for coding' },
    { label: 'gpt-5.5-codex', description: 'Previous generation' },
  ]);
  assert.deepEqual(parsed.notes, [
    'Access legacy models by running codex -m <model_name>',
    'Press enter to confirm or esc to go back',
  ]);
});

test('parses Codex reasoning choices with multi-word labels', () => {
  const parsed = parseModelCommandOutput(`
Select Reasoning Level for gpt-5.6-sol

  1. Low (default)              Fast responses with lighter reasoning
  2. Medium                     Balanced for everyday tasks
  3. High                       Greater reasoning depth
  4. Extra high                 Extra high reasoning depth
› 5. More reasoning… (current)  Max and Ultra consume usage limits faster

Press enter to confirm or esc to go back
`);

  assert.equal(parsed.heading, 'Select Reasoning Level for gpt-5.6-sol');
  assert.equal(parsed.selected, 'More reasoning…');
  assert.deepEqual(parsed.items.map((item) => item.label), [
    'Low (default)', 'Medium', 'High', 'Extra high', 'More reasoning…',
  ]);
});

test('keeps plain model output as raw notes when no list is present', () => {
  const parsed = parseModelCommandOutput('Model: gpt-5\nContext: 80% left');
  assert.equal(parsed.heading, 'Model');
  assert.equal(parsed.count, '');
  assert.equal(parsed.selected, '');
  assert.deepEqual(parsed.items, []);
  assert.deepEqual(parsed.notes, ['Model: gpt-5', 'Context: 80% left']);
});
