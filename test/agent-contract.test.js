import test from 'node:test';
import assert from 'node:assert/strict';
import * as model from '../public/agent-model.js';

for (const provider of ['codex', 'claude', 'qodercli']) {
  const base = () => ({ id: 'thread-1', provider, turns: [], tmux: { name: 'work', status: 'done' } });

  test(`${provider} delivery evidence is distinct from execution and transcript persistence`, () => {
    const thread = { ...base(), receivedDeliveryIds: ['command-1'] };
    const delivery = { commandId: 'command-1', text: 'Continue' };
    assert.equal(model.isUserMessageDeliveryReceived(thread, delivery), true);
    assert.equal(model.isUserMessageDeliveryConfirmed(thread, delivery), false);
    assert.equal(model.isUserMessageDeliveryReceived(thread, { ...delivery, commandId: 'other' }), false);
    assert.equal(model.threadExecutionState(thread), 'idle', 'receipt alone cannot imply execution');
  });

  test(`${provider} execution state has the same precedence and does not invent idle`, () => {
    assert.equal(model.threadExecutionState({ id: 'thread-1', provider, turns: [] }), 'unknown');
    assert.equal(model.threadExecutionState(base()), 'idle');
    assert.equal(model.threadExecutionState({ ...base(), tmux: { name: 'work', status: 'background' } }), 'background');
    assert.equal(model.threadExecutionState({ ...base(), status: { type: 'active' } }), 'working');
    assert.equal(model.threadExecutionState({ ...base(), tmux: { name: 'work', status: 'working' }, turns: [
      { id: 'old', status: 'failed', items: [] },
    ] }), 'working', 'an old failure does not hide newer foreground activity');
    assert.equal(model.threadExecutionState({ ...base(), turns: [{ id: 'latest', status: 'failed', error: 'Failed', items: [] }] }), 'failed');
    assert.equal(model.threadExecutionState(base(), { waitingForInput: true }), 'waitingForInput');
    assert.equal(model.threadExecutionState({ ...base(), tmux: { name: 'work', available: false } }), 'unknown');
  });

  test(`${provider} observed receipt evidence cannot be downgraded by a lagging refresh`, () => {
    const item = { id: 'delivery:command-1', type: 'userMessage', content: 'Continue',
      delivery: { commandId: 'command-1', status: 'received' } };
    const current = { ...base(), receivedDeliveryIds: ['command-1'], turns: [{ id: 'turn', status: 'completed', items: [item] }] };
    const refreshed = { ...base(), turns: [{ id: 'turn', status: 'completed', items: [{
      ...item, delivery: { ...item.delivery, status: 'unknown' },
    }] }] };
    const result = model.reconcileAgentThreadRefresh(current, refreshed);
    assert.equal(result.turns[0].items[0].delivery.status, 'received');
    assert.equal(model.isUserMessageDeliveryReceived(result, { commandId: 'command-1', text: 'Continue' }), true);
  });

  test(`${provider} history and delivery evidence never cross a thread or provider boundary`, () => {
    const current = { ...base(), receivedDeliveryIds: ['command-1'] };
    for (const refreshed of [{ ...base(), id: 'thread-2' }, { ...base(), provider: 'another-provider' },
      { ...base(), tmux: { name: 'other', status: 'done' } }]) {
      const result = model.reconcileAgentThreadRefresh(current, refreshed);
      assert.equal(result, refreshed);
      assert.equal(model.isUserMessageDeliveryReceived(result, { commandId: 'command-1', text: 'Continue' }), false);
    }
  });

  test(`${provider} a non-overlapping newer tail cannot erase already loaded history`, () => {
    const turns = [1, 2, 3, 4].map(id => ({ id: `turn-${id}`, status: 'completed', items: [
      { id: `output-${id}`, type: 'agentMessage', text: `Output ${id}` },
    ] }));
    const current = { ...base(), turns: turns.slice(0, 2), truncated: true, oldestTurnId: 'turn-1' };
    const incoming = { ...base(), turns: turns.slice(2), truncated: true, oldestTurnId: 'turn-3' };
    const refreshed = model.reconcileAgentThreadRefresh(current, incoming);
    assert.deepEqual(refreshed.turns.map(turn => turn.id), turns.map(turn => turn.id));
    const again = model.reconcileAgentThreadRefresh(refreshed, incoming);
    assert.deepEqual(again.turns.map(turn => turn.id), turns.map(turn => turn.id));
  });

  test(`${provider} a tail refresh cannot reopen history that is already fully loaded`, () => {
    const turns = [1, 2].map(id => ({ id: `turn-${id}`, status: 'completed', items: [] }));
    const refreshed = model.reconcileAgentThreadRefresh({ ...base(), turns, truncated: false, oldestTurnId: 'turn-1' }, {
      ...base(), turns: turns.slice(1), truncated: true, oldestTurnId: 'turn-2', liveOutput: 'changed',
    });
    assert.equal(refreshed.truncated, false);
    assert.equal(refreshed.oldestTurnId, 'turn-1');
  });
}
