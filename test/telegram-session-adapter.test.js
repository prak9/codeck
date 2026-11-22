import test from 'node:test';
import assert from 'node:assert/strict';
import { createTelegramSessionAdapter } from '../src/telegram-session-adapter.js';

for (const provider of ['codex', 'claude', 'qodercli']) test(`${provider} uses existing session commands and never creates a model thread`, async () => {
  const calls = [];
  const target = { provider, threadId: 'thread', tmuxSession: 'work' };
  const adapter = createTelegramSessionAdapter({ connection: {},
    list: async () => [{ name: 'work', agent: { kind: provider, id: 'thread' } }],
    read: async () => ({ thread: { turns: [] } }), pendingRequests: () => [],
    rpc: async (_config, request) => { calls.push(request); return {}; },
  });
  await adapter.act('send', target, { text: 'hello', commandId: 'telegram-123' });
  await adapter.act('stop', target, { commandId: 'telegram-124' });
  assert.deepEqual(calls.map(c => c.type), ['sendSessionMessage', 'interruptSession']);
  assert.equal(calls[0].threadId, 'thread'); assert.equal(calls[1].scope, 'foreground');
  await assert.rejects(adapter.act('send', { ...target, threadId: 'replaced' }, { text: 'wrong' }), /变化/);
  assert.equal(calls.length, 2);
});

test('native question answers and approvals require the matching live request', async () => {
  let question = { id: 'q1', question: '选择？', options: [{ label: '继续' }] };
  const requests = [], calls = [];
  const target = { provider: 'qodercli', threadId: 't', tmuxSession: 's' };
  const adapter = createTelegramSessionAdapter({ connection: {},
    list: async () => [{ name: 's', agent: { kind: 'qodercli', id: 't', question } }],
    read: async () => ({ thread: { turns: [] } }), pendingRequests: () => requests,
    rpc: async (_c, request, options) => { calls.push({ request, options }); },
  });
  const live = (await adapter.read(target)).interactions[0];
  await adapter.act('answer', target, { ...live, answer: '继续' });
  assert.equal(calls[0].request.questionId, 'q1'); assert.equal(calls[0].options.subscribe, true);
  question = { ...question, id: 'q2' };
  await assert.rejects(adapter.act('answer', target, { ...live, answer: '继续' }), /过期/);
  requests.push({ provider: 'qodercli', request: { id: 12, method: 'item/commandExecution/requestApproval', params: { threadId: 't' } } });
  await adapter.act('approve', target, { id: 12, decision: 'decline' });
  assert.equal(calls.at(-1).request.decision, 'decline');
  requests.length = 0;
  await assert.rejects(adapter.act('approve', target, { id: 12, decision: 'accept' }), /过期/);
});

test('workstation and Telegram identify the same live question without fetching history; a recreated session cannot answer it', async () => {
  const request = { id: 7, method: 'item/tool/requestUserInput', params: { threadId: 'thread',
    questions: [{ id: 'unit', question: '使用哪一种口径？', options: [{ label: '季度' }] }] } };
  const session = { name: 'research', createdAt: 5, agent: { id: 'thread', kind: 'codex' } };
  const target = { tmuxSession: 'research', threadId: 'thread', provider: 'codex' };
  const calls = [];
  const adapter = createTelegramSessionAdapter({ connection: {}, list: async () => [session], read: async () => { throw Error('history read'); },
    pendingRequests: () => [{ provider: 'codex', request }], rpc: async (_, message) => calls.push(message) });
  const [pending] = await adapter.pending();
  assert.equal(pending.label, '使用哪一种口径？');
  assert.deepEqual(pending.options, ['季度']);
  await adapter.act('answer', target, { ...pending, answer: '季度' });
  assert.deepEqual(calls[0].answers, { unit: ['季度'] });
  session.createdAt = 6;
  await assert.rejects(adapter.act('answer', target, { ...pending, answer: '季度' }), /变化|过期/);
  assert.equal(calls.length, 1);
});
