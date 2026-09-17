import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexDeliveryRecovery } from '../src/codex-delivery-recovery.js';

const user = (id, text) => ({ id, type: 'userMessage', content: [{ type: 'text', text }] });
const receipt = (commandId = 'command-1') => ({
  threadId: 'thread', commandId, text: '可以', baselineVersion: 2,
  baselineUserMessageId: 'anchor', baselineTurnId: 'turn', baselineMatchingTextCount: 0,
});
const turn = (...items) => ({ id: 'turn', status: 'completed', items });
const tick = () => new Promise(setImmediate);

test('recovers missed completed-turn follow-ups asynchronously, preserving source order', async () => {
  let release;
  const observed = [];
  const calls = [];
  const recovery = new CodexDeliveryRecovery({
    read: async params => {
      calls.push(params);
      if (!params.cursor) return new Promise(resolve => { release = () => resolve({
        data: [{ turnId: 'turn', item: user('actual', '可以') }], nextCursor: 'older',
      }); });
      return { data: [{ turnId: 'turn', item: { id: 'output', type: 'agentMessage', text: 'Earlier' } },
        { turnId: 'turn', item: user('anchor', 'Start') }] };
    },
    observe: (threadId, recovered) => observed.push(recovered),
  });
  recovery.record(receipt());
  const initial = recovery.update('thread', [turn(user('anchor', 'Start'))]);
  assert.deepEqual(initial.deliveryConfirmations, []);
  assert.equal(calls.length, 1);
  recovery.update('thread', [turn(user('anchor', 'Start'))]);
  assert.equal(calls.length, 1, 'coalesce while the page is pending');
  release();
  await tick();
  assert.deepEqual(observed[0].items.map(item => item.id), ['anchor', 'output', 'actual']);
  assert.equal(observed[0].items[1].text, undefined, 'do not retain tool/answer payloads');
  const result = recovery.update('thread', observed);
  assert.deepEqual(result.deliveryConfirmations, [{ commandId: 'command-1', itemId: 'actual' }]);
  assert.equal(calls.every(call => call.turnId === 'turn' && call.limit === 100), true);
  recovery.close();
});

test('two clients with the same baseline cannot claim one actual message twice', () => {
  const recovery = new CodexDeliveryRecovery({ read: async () => ({ data: [] }), observe() {} });
  recovery.record(receipt('command-a'));
  recovery.record(receipt('command-b'));
  const one = recovery.update('thread', [turn(user('anchor', 'Start'), user('actual-1', '可以'))]);
  assert.deepEqual(one.deliveryConfirmations, [], 'ambiguous duplicate sends remain unconfirmed');
  const two = recovery.update('thread', [turn(user('anchor', 'Start'), user('actual-1', '可以'), user('actual-2', '可以'))]);
  assert.deepEqual(two.deliveryConfirmations, [
    { commandId: 'command-a', itemId: 'actual-1' }, { commandId: 'command-b', itemId: 'actual-2' },
  ]);
  recovery.close();
});

test('hung recovery is bounded and becomes unknown without blocking snapshots or resending', async () => {
  let now = 0;
  let reads = 0;
  const recovery = new CodexDeliveryRecovery({
    now: () => now, read: () => { reads++; return new Promise(() => {}); }, observe() {},
  });
  recovery.record(receipt());
  recovery.update('thread', [turn(user('anchor', 'Start'))]);
  now = 61_000;
  for (let i = 0; i < 50; i++) {
    const result = recovery.update('thread', [turn(user('anchor', 'Start'))]);
    assert.deepEqual(result.unconfirmedDeliveryIds, ['command-1']);
  }
  assert.equal(reads, 1);
  recovery.close();
});

test('failed reads back off and can recover later without clearing the receipt', async () => {
  let now = 0;
  let reads = 0;
  const recovery = new CodexDeliveryRecovery({ now: () => now,
    read: async () => { reads++; throw new Error('store busy'); }, observe() {},
  });
  recovery.record(receipt());
  recovery.update('thread', [turn(user('anchor', 'Start'))]);
  await tick();
  recovery.update('thread', [turn(user('anchor', 'Start'))]);
  assert.equal(reads, 1);
  now = 5_000;
  recovery.update('thread', [turn(user('anchor', 'Start'))]);
  await tick();
  assert.equal(reads, 2);
  assert.deepEqual(recovery.update('thread', [turn(user('anchor', 'Start'), user('actual', '可以'))]).deliveryConfirmations,
    [{ commandId: 'command-1', itemId: 'actual' }]);
  recovery.close();
});

test('a late page after close cannot repopulate the cache or publish a refresh', async () => {
  let release;
  let changes = 0;
  const recovery = new CodexDeliveryRecovery({
    read: () => new Promise(resolve => { release = resolve; }),
    observe: () => { changes++; }, changed: () => { changes++; },
  });
  recovery.record(receipt());
  recovery.update('thread', [turn(user('anchor', 'Start'))]);
  recovery.close();
  release({ data: [{ turnId: 'turn', item: user('actual', '可以') }] });
  await tick();
  assert.equal(changes, 0);
});

test('repeated cursors and excessive pages stop without committing incomplete placement evidence', async () => {
  for (const repeated of [true, false]) {
    let reads = 0;
    let observations = 0;
    const recovery = new CodexDeliveryRecovery({
      read: async () => ({ data: [], nextCursor: repeated ? (++reads, 'same') : String(++reads) }),
      observe: () => { observations++; },
    });
    recovery.record(receipt());
    recovery.update('thread', [turn(user('anchor', 'Start'))]);
    await tick();
    assert.equal(reads, repeated ? 2 : 32);
    assert.equal(observations, 0);
    recovery.close();
  }
});

test('cached old messages cannot confirm an input just because the live anchor left the window', () => {
  const recovery = new CodexDeliveryRecovery({ read: async () => ({ data: [] }), observe() {} });
  recovery.record(receipt());
  const cached = new Map([
    ['turn', { items: [user('anchor', 'Start')] }],
    ['older', { items: [user('wrong', '可以')] }],
  ]);
  const result = recovery.update('thread', [{ id: 'latest', items: [] }], cached);
  assert.deepEqual(result.deliveryConfirmations, []);
  cached.get('turn').items.push(user('actual', '可以'));
  assert.deepEqual(recovery.update('thread', [{ id: 'latest', items: [] }], cached).deliveryConfirmations,
    [{ commandId: 'command-1', itemId: 'actual' }]);
  recovery.close();
});

test('a new send during an old read cannot lose its immediate recovery attempt', async () => {
  let now = 0;
  let release;
  let reads = 0;
  const recovery = new CodexDeliveryRecovery({ now: () => now,
    read: () => { reads++; return new Promise(resolve => { release = resolve; }); }, observe() {},
  });
  recovery.record(receipt('command-a'));
  recovery.update('thread', [turn(user('anchor', 'Start'))]);
  recovery.record(receipt('command-b'));
  release({ data: [] });
  await tick();
  recovery.update('thread', [turn(user('anchor', 'Start'))]);
  assert.equal(reads, 2, 'new send is not put into the old job backoff');
  recovery.close();
  release({ data: [] });
  await tick();
});

test('overlapping baselines cannot assign the same user to two different command groups', () => {
  const recovery = new CodexDeliveryRecovery({ read: async () => ({ data: [] }), observe() {} });
  recovery.record(receipt('command-a'));
  recovery.record({ ...receipt('command-b'), baselineUserMessageId: 'second-anchor' });
  const result = recovery.update('thread', [turn(
    user('anchor', 'Start'), user('second-anchor', 'Another input'), user('actual', '可以'),
  )]);
  assert.deepEqual(result.deliveryConfirmations, []);
  recovery.close();
});

test('the read deadline releases the recovery slot and retries back off without permanently stopping', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0;
  let reads = 0;
  const recovery = new CodexDeliveryRecovery({ now: () => now,
    read: (_, { signal }) => new Promise((resolve, reject) => {
      reads++;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }), observe() {},
  });
  recovery.record(receipt());
  for (let attempt = 0; attempt < 10; attempt++) {
    recovery.update('thread', [turn(user('anchor', 'Start'))]);
    t.mock.timers.tick(10_000);
    await tick();
    now += 70_000;
  }
  assert.equal(reads, 10);
  assert.equal(recovery.active, null);
  assert.deepEqual(recovery.snapshot('thread').unconfirmedDeliveryIds, ['command-1']);
  recovery.close();
});

test('a 33-page turn resumes at page 33 instead of discarding the first 32 pages', async () => {
  let now = 0;
  const cursors = [];
  const observed = [];
  const recovery = new CodexDeliveryRecovery({ now: () => now,
    read: async ({ cursor }) => {
      const page = Number(cursor || 0);
      cursors.push(page);
      return { data: [{ turnId: 'turn', item: page === 0 ? user('actual', '可以')
        : page === 32 ? user('anchor', 'Start') : { id: `tool-${page}`, type: 'commandExecution' } }],
      nextCursor: page < 32 ? String(page + 1) : null };
    }, observe: (_, turn) => observed.push(turn),
  });
  recovery.record(receipt());
  recovery.update('thread', [turn(user('anchor', 'Start'))]);
  await tick();
  assert.equal(cursors.length, 32);
  assert.equal(observed.length, 0);
  now = 70_000;
  recovery.record({ ...receipt('command-new'), text: 'another input' });
  recovery.update('thread', [turn(user('anchor', 'Start'))]);
  await tick();
  assert.equal(cursors.length, 33);
  assert.equal(cursors.at(-1), 32);
  assert.deepEqual(recovery.update('thread', observed).deliveryConfirmations,
    [{ commandId: 'command-1', itemId: 'actual' }]);
  recovery.close();
});

test('a transcript appearing after eight empty reads still converges without a resend', async () => {
  let now = 0;
  let reads = 0;
  let recovered;
  const recovery = new CodexDeliveryRecovery({ now: () => now,
    read: async () => ({ data: (++reads > 8 ? [user('actual', '可以'), user('anchor', 'Start')]
      : [user('anchor', 'Start')]).map(item => ({ turnId: 'turn', item })) }),
    observe: (_, turn) => { recovered = turn; },
  });
  recovery.record(receipt());
  for (let attempt = 0; attempt < 9; attempt++) {
    recovery.update('thread', [recovered || turn(user('anchor', 'Start'))]);
    await tick();
    now += 70_000;
  }
  assert.equal(reads, 9);
  assert.deepEqual(recovery.update('thread', [recovered]).deliveryConfirmations,
    [{ commandId: 'command-1', itemId: 'actual' }]);
  recovery.close();
});
