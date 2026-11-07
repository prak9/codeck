import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionExecutionState, executionLabel, turnOutcome, turnStatusLabel } from '../public/execution-status.js';

test('idle is readiness, a completed turn is not a completed goal, unknown is not success', () => {
  assert.equal(sessionExecutionState({ status: 'done' }), 'idle');
  assert.equal(executionLabel('idle'), '已就绪');
  assert.equal(turnOutcome({ status: 'completed' }), 'ended');
  assert.equal(turnStatusLabel('completed'), '本轮结束');
  assert.equal(turnOutcome({}), 'unknown');
  assert.equal(turnStatusLabel('interrupted'), '本轮中止');
  assert.equal(turnStatusLabel('unrecognized'), '状态未知');
});

test('questions and foreground/background work keep their distinct meanings', () => {
  assert.equal(sessionExecutionState({ status: 'working', agent: { question: { id: 'q' } } }), 'waitingForInput');
  assert.equal(sessionExecutionState({ hasRunningProcess: true }), 'working');
  assert.equal(sessionExecutionState({ agent: { hasBackgroundProcess: true } }), 'background');
  assert.equal(turnOutcome({ status: 'completed', error: { message: 'failed' } }), 'failed');
});
