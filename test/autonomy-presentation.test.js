import test from 'node:test';
import assert from 'node:assert/strict';
import { autonomyExecutionLabel, autonomySummaryRows, autonomySummaryIndex, AUTONOMY_PLANNING_PROMPT } from '../public/remote-autonomy.js';

test('summary stays after its receipt turn, before subsequent messages and after history reload', () => {
  const run = { summaryReceiptId: 'receipt-123', stoppedAt: 5000 };
  const turns = [
    { items: [{ type: 'userMessage', text: 'instructions receipt-123' }] },
    { items: [{ type: 'commandExecution', command: 'receipt-123.json --status completed' }] },
    { items: [{ type: 'userMessage', text: 'next task' }] },
  ];
  assert.equal(autonomySummaryIndex(run, turns), 2);
  assert.equal(autonomySummaryIndex(run, structuredClone(turns)), 2);
  assert.equal(autonomySummaryIndex(run, turns.slice(2)), 0, 'missing history cannot put an old summary at the bottom');
  assert.equal(autonomySummaryIndex({ stoppedAt: 5000 }, [{ startedAt: 1 }, { startedAt: 6 }]), 1);
});

test('completed autonomy has a readable final report independent of the final chat reply', () => {
  const run = { status: 'completed', plan: { goal: '修复发送' }, summary: '已修复竞态',
    evidence: 'test.log', checkpoint: { version: 'abc123', verification: '回归通过' }, next: '部署验证' };
  assert.deepEqual(autonomySummaryRows(run), [
    ['结束原因', '目标完成'], ['目标', '修复发送'], ['进展与结果', '已修复竞态'],
    ['版本与验证', 'abc123\n回归通过'], ['证据位置', 'test.log'], ['下一步', '部署验证'],
  ]);
  assert.deepEqual(autonomySummaryRows({ ...run, status: 'running' }), []);
  assert.deepEqual(autonomySummaryRows(null), []);
});

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
    '预算未指定就不设默认值', '评价标准', '不输出 JSON', '等待我用普通消息回复', '不要调用原生提问工具', '我确认后',
    '进度问询不代表停止，也不重置预算', '无论自主结束还是用户中止', '不只更新状态']) {
    assert.ok(AUTONOMY_PLANNING_PROMPT.includes(text), text);
  }
  assert.doesNotMatch(AUTONOMY_PLANNING_PROMPT, /^\d+\. /m, 'iteration rules belong to the skill, not a duplicated checklist');
  assert.doesNotMatch(AUTONOMY_PLANNING_PROMPT, /有原生提问工具就使用/);
  assert.ok(AUTONOMY_PLANNING_PROMPT.endsWith('现在只给出简短计划，并等待我确认。'));
});
