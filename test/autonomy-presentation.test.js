import test from 'node:test';
import assert from 'node:assert/strict';
import { autonomyExecutionLabel, AUTONOMY_PLANNING_PROMPT } from '../public/remote-autonomy.js';

test('autonomy labels distinguish actual work, background work, questions and idle without changing the run', () => {
  const run = Object.freeze({ status: 'running' });
  assert.equal(autonomyExecutionLabel(run, 'working'), '自主执行中');
  assert.equal(autonomyExecutionLabel(run, 'background'), '自主后台运行');
  assert.equal(autonomyExecutionLabel(run, 'done'), '自主模式·当前空闲');
  assert.equal(autonomyExecutionLabel(run, 'idle'), '自主模式·当前空闲');
  assert.equal(autonomyExecutionLabel(run, 'working', true), '等待你的回答');
  assert.equal(autonomyExecutionLabel(run, 'waitingForInput'), '等待你的回答');
  assert.equal(autonomyExecutionLabel(run, 'failed'), null);
  for (const status of ['planning', 'ended', 'completed', 'error', 'off']) {
    assert.equal(autonomyExecutionLabel({ status }, 'done'), null);
  }
  assert.equal(autonomyExecutionLabel(null, 'done'), null);
  assert.equal(autonomyExecutionLabel({ status: 'exiting' }, 'done'), '自主模式·当前空闲');
});

test('planning prompt preserves confirmation while carrying exploration, evidence, budget and handoff requirements', () => {
  for (const text of ['确认前不执行任务', '预算未指定就不设默认值', '评价标准', '替代解释', '机制不同',
    '可回退', '否定这个想法', '对照或消融', '必要时复测', '不能降低验收标准', '剩余预算',
    '恢复方式', '遗留运行任务', '相关 Skill']) assert.ok(AUTONOMY_PLANNING_PROMPT.includes(text), text);
  assert.ok(AUTONOMY_PLANNING_PROMPT.endsWith('现在只给出简短计划，并等待我确认。'));
});
