import test from 'node:test';
import assert from 'node:assert/strict';
import { createSnapshotFeed } from '../src/snapshot-feed.js';

test('one snapshot load fans out to every subscriber and only changed values advance sequence', async () => {
  let value = { sessions: [{ name: 'codeck', status: 'done' }] };
  let loads = 0;
  const scheduled = [];
  const feed = createSnapshotFeed(async () => {
    loads += 1;
    return value;
  }, {
    epoch: 'epoch-1',
    intervalMs: 750,
    schedule: (callback) => {
      scheduled.push(callback);
      return callback;
    },
    cancel: () => {},
  });
  const first = [];
  const second = [];
  const unsubscribeFirst = feed.subscribe('sessions', (event) => first.push(event));
  const unsubscribeSecond = feed.subscribe('sessions', (event) => second.push(event));

  await feed.refresh('sessions');

  assert.equal(loads, 1);
  assert.deepEqual(first, [{ epoch: 'epoch-1', sequence: 1, snapshot: value }]);
  assert.deepEqual(second, first);
  assert.equal(scheduled.length, 1);

  await feed.refresh('sessions');
  assert.equal(loads, 2);
  assert.equal(first.length, 1);

  value = { sessions: [{ name: 'codeck', status: 'working' }] };
  await feed.refresh('sessions');
  assert.equal(first.at(-1).sequence, 2);
  assert.equal(second.at(-1).snapshot.sessions[0].status, 'working');

  unsubscribeFirst();
  unsubscribeSecond();
  feed.close();
});

test('snapshot feed coalesces concurrent refreshes and reports recoverable loader errors', async () => {
  let release;
  let fail = true;
  let loads = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const errors = [];
  const feed = createSnapshotFeed(async () => {
    loads += 1;
    await gate;
    if (fail) throw new Error('tmux unavailable');
    return { sessions: [] };
  }, {
    epoch: 'epoch-2',
    schedule: () => 1,
    cancel: () => {},
  });
  feed.subscribe('sessions', () => {}, (error) => errors.push(error.message));

  const first = feed.refresh('sessions');
  const concurrent = feed.refresh('sessions');
  release();
  await assert.rejects(first, /tmux unavailable/);
  await assert.rejects(concurrent, /tmux unavailable/);
  assert.equal(loads, 1);
  assert.deepEqual(errors, ['tmux unavailable']);

  fail = false;
  const recovered = await feed.refresh('sessions');
  assert.equal(recovered.sequence, 1);
  assert.deepEqual(recovered.snapshot, { sessions: [] });
  feed.close();
});

test('an idle resource drops its snapshot without resetting the stream sequence', async () => {
  let value = { turns: [{ id: 'turn-1' }] };
  const feed = createSnapshotFeed(() => value, {
    epoch: 'epoch-3', schedule: () => 1, cancel: () => {},
  });
  const first = [];
  const unsubscribe = feed.subscribe('thread-1', (event) => first.push(event));
  await feed.refresh('thread-1');
  unsubscribe();

  value = { turns: [{ id: 'turn-1' }, { id: 'turn-2' }] };
  const second = [];
  feed.subscribe('thread-1', (event) => second.push(event));
  await feed.refresh('thread-1');

  assert.equal(first[0].sequence, 1);
  assert.equal(second[0].sequence, 2);
  assert.equal(second[0].snapshot.turns.length, 2);
  feed.close();
});

test('a recovered feed republishes an unchanged snapshot after an error', async () => {
  let fail = false;
  const events = [];
  const errors = [];
  const snapshot = { sessions: [{ name: 'codeck' }] };
  const feed = createSnapshotFeed(async () => {
    if (fail) throw new Error('temporary failure');
    return snapshot;
  }, { epoch: 'epoch-4', schedule: () => 1, cancel: () => {} });
  feed.subscribe('sessions', (event) => events.push(event), (error) => errors.push(error.message));
  await feed.refresh('sessions');

  fail = true;
  await assert.rejects(feed.refresh('sessions'), /temporary failure/);
  fail = false;
  await feed.refresh('sessions');

  assert.deepEqual(errors, ['temporary failure']);
  assert.deepEqual(events.map((event) => event.sequence), [1, 2]);
  feed.close();
});

test('an invalidation during a load performs a fresh load instead of publishing stale state only', async () => {
  let releaseFirst;
  let loads = 0;
  let value = 'before';
  const firstLoad = new Promise((resolve) => { releaseFirst = resolve; });
  const events = [];
  const feed = createSnapshotFeed(async () => {
    loads += 1;
    const captured = value;
    if (loads === 1) await firstLoad;
    return { value: captured };
  }, { epoch: 'epoch-5', schedule: () => 1, cancel: () => {} });
  feed.subscribe('sessions', (event) => events.push(event));
  await Promise.resolve();
  assert.equal(loads, 1);
  value = 'after';
  const invalidated = feed.invalidate('sessions');
  releaseFirst();
  await invalidated;
  for (let attempt = 0; attempt < 20 && events.at(-1)?.snapshot.value !== 'after'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  assert.equal(loads, 2);
  assert.equal(events.length, 1);
  assert.equal(events.at(-1).snapshot.value, 'after');
  feed.close();
});

test('snapshot feed selects its next interval from the latest snapshot', async () => {
  let active = false;
  const delays = [];
  const feed = createSnapshotFeed(() => ({ active }), {
    intervalMs: (snapshot) => snapshot?.active ? 750 : 5_000,
    schedule: (callback, delay) => {
      delays.push(delay);
      return callback;
    },
    cancel: () => {},
  });
  feed.subscribe('sessions', () => {});
  await feed.refresh('sessions');
  assert.equal(delays.at(-1), 5_000);

  active = true;
  await feed.refresh('sessions');
  assert.equal(delays.at(-1), 750);
  feed.close();
});

test('snapshot feed can wake only matching subscribed resources', async () => {
  const loads = new Map();
  const feed = createSnapshotFeed((resource) => {
    loads.set(resource, (loads.get(resource) || 0) + 1);
    return { resource };
  }, { schedule: () => 1, cancel: () => {} });
  feed.subscribe('thread-1', () => {});
  feed.subscribe('thread-2', () => {});
  await Promise.all([feed.refresh('thread-1'), feed.refresh('thread-2')]);
  const before = new Map(loads);

  await feed.refreshSubscribed((resource) => resource === 'thread-2');

  assert.equal(loads.get('thread-1'), before.get('thread-1'));
  assert.equal(loads.get('thread-2'), before.get('thread-2') + 1);
  feed.close();
});
