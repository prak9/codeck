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

test('planning prompt delegates iteration to its skill while preserving confirmation and conversation controls', () => {
  for (const text of ['使用 iterate skill', '先读取该 Skill', '相关领域 Skill', '确认前不执行任务',
    '预算未指定就不设默认值', '评价标准', '不输出 JSON', '原生提问工具', '我确认后',
    '进度问询不代表停止，也不重置预算', '无论自主结束还是用户中止', '不只更新状态']) {
    assert.ok(AUTONOMY_PLANNING_PROMPT.includes(text), text);
  }
  assert.doesNotMatch(AUTONOMY_PLANNING_PROMPT, /^\d+\. /m, 'iteration rules belong to the skill, not a duplicated checklist');
  assert.ok(AUTONOMY_PLANNING_PROMPT.endsWith('现在只给出简短计划，并等待我确认。'));
});
