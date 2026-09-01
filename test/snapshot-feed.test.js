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

test('a cursor subscriber replays contiguous thread patches without another full snapshot', async () => {
  const initialText = 'x'.repeat(2_000);
  let value = { thread: { id: 'thread-1', turns: [{ id: 'turn-1', text: initialText }] } };
  const feed = createSnapshotFeed(() => value, {
    epoch: 'epoch-v2', intervalMs: 60_000, schedule: () => 1, cancel: () => {},
  });
  const live = [];
  const unsubscribe = feed.subscribeFrom('thread-1', null, (frame) => live.push(frame));
  await feed.refresh('thread-1');
  await Promise.resolve();
  assert.equal(live[0].kind, 'snapshot');
  const firstCursor = { epoch: live[0].epoch, sequence: live[0].sequence };

  value = { thread: { id: 'thread-1', turns: [{ id: 'turn-1', text: `${initialText} world` }] } };
  await feed.refresh('thread-1');
  assert.equal(live.at(-1).kind, 'delta');
  assert.equal(live.at(-1).baseSequence, firstCursor.sequence);
  unsubscribe();

  const resumed = [];
  feed.subscribeFrom('thread-1', firstCursor, (frame) => resumed.push(frame));
  await Promise.resolve();
  assert.deepEqual(resumed.map((frame) => frame.kind), ['delta', 'synchronized']);
  assert.equal(resumed[0].sequence, 2);
  assert.equal(resumed[1].sequence, 2);
  feed.close();
});

test('a cursor older than the bounded journal falls back to one current snapshot', async () => {
  let value = { value: 'one' };
  const feed = createSnapshotFeed(() => value, {
    epoch: 'epoch-gap', journalLimit: 1, intervalMs: 60_000,
    schedule: () => 1, cancel: () => {},
  });
  const live = [];
  const unsubscribe = feed.subscribeFrom('resource', null, (frame) => live.push(frame));
  await feed.refresh('resource');
  const staleCursor = { epoch: 'epoch-gap', sequence: 1 };
  value = { value: 'two' };
  await feed.refresh('resource');
  value = { value: 'three' };
  await feed.refresh('resource');
  unsubscribe();

  const resumed = [];
  feed.subscribeFrom('resource', staleCursor, (frame) => resumed.push(frame));
  await Promise.resolve();
  assert.deepEqual(resumed.map((frame) => frame.kind), ['snapshot', 'synchronized']);
  assert.equal(resumed[0].sequence, 3);
  assert.deepEqual(resumed[0].snapshot, value);
  feed.close();
});

test('an exact cursor resumes with synchronization only and remains resumable while retained', async () => {
  const feed = createSnapshotFeed(() => ({ value: 'stable' }), {
    epoch: 'epoch-current', intervalMs: 60_000, schedule: () => 1, cancel: () => {},
  });
  const initial = [];
  const unsubscribe = feed.subscribeFrom('resource', null, (frame) => initial.push(frame));
  await feed.refresh('resource');
  const cursor = { epoch: 'epoch-current', sequence: 1 };
  unsubscribe();
  assert.equal(feed.canResume('resource', cursor), true);

  const resumed = [];
  feed.subscribeFrom('resource', cursor, (frame) => resumed.push(frame));
  await Promise.resolve();
  assert.deepEqual(resumed.map((frame) => frame.kind), ['synchronized']);
  assert.equal(resumed[0].sequence, 1);
  feed.close();
});

test('a full frame resets the journal so it cannot evict newer deltas', async () => {
  // 会话列表的全量帧是增量帧的数倍大; 让它留在 journal 里只会把后面的增量帧
  // 挤出字节上限, 反而把本可续订的客户端逼回全量。
  let value = { list: [{ id: 'a', text: 'x' }] };
  const feed = createSnapshotFeed(async () => structuredClone(value), {
    intervalMs: 5, patchRatio: 0.9,
  });
  const frames = [];
  const stop = feed.subscribeFrom('resource', null, (frame) => frames.push(frame));
  await feed.refresh('resource');

  value = { list: [{ id: 'a', text: 'x' }, { id: 'b', text: 'y'.repeat(400) }] };
  await feed.refresh('resource');
  value = { list: [{ id: 'a', text: 'x+' }, { id: 'b', text: 'y'.repeat(400) }] };
  await feed.refresh('resource');

  const stats = feed.stats();
  assert.ok(stats.journal.resource >= 1, 'the journal keeps the frames after the last full one');
  stop();
  feed.close();
});

test('the feed counts full and delta frames so the saving is measurable', async () => {
  let value = { list: [{ id: 'a', text: 'x'.repeat(200) }] };
  const feed = createSnapshotFeed(async () => structuredClone(value), { intervalMs: 5 });
  const stop = feed.subscribeFrom('resource', null, () => {});
  await feed.refresh('resource');
  value = { list: [{ id: 'a', text: 'x'.repeat(200) + '!' }] };
  await feed.refresh('resource');

  const stats = feed.stats();
  assert.equal(stats.frames.snapshot.count, 1);
  assert.equal(stats.frames.delta.count, 1);
  assert.ok(stats.frames.snapshot.bytes > stats.frames.delta.bytes);
  stop();
  feed.close();
});

test('a watched resource falls back to a slow heartbeat instead of tight polling', async () => {
  // 现在的延迟下限就是轮询间隔 (活跃 thread 350ms), 处理耗时再怎么压也改不了它。
  // 能被订阅的资源 (transcript 文件可以 fs.watch) 应该改由事件驱动, 轮询退成兜底。
  const scheduled = [];
  let fire = null;
  let disposed = 0;
  const feed = createSnapshotFeed(async () => ({ n: 1 }), {
    intervalMs: 350,
    watchedIntervalMs: 8_000,
    watch: (resource, onChange) => { fire = onChange; return () => { disposed += 1; }; },
    schedule: (callback, delay) => { scheduled.push(delay); return scheduled.length; },
    cancel: () => {},
  });

  const stop = feed.subscribeFrom('thread', null, () => {});
  await feed.refresh('thread');
  assert.ok(scheduled.includes(8_000), `被监听的资源应使用兜底心跳, 实际: ${scheduled}`);
  assert.ok(!scheduled.includes(350), '不应再按紧凑间隔轮询');
  assert.equal(typeof fire, 'function', '必须把变更回调交给监听方');

  stop();
  assert.equal(disposed, 1, '没有订阅者就要停掉监听');
  feed.close();
});

test('an unwatchable resource keeps its original cadence', async () => {
  // 找不到可监听的文件 (例如身份未确认) 时必须原样退回轮询, 不能变慢。
  const scheduled = [];
  const feed = createSnapshotFeed(async () => ({ n: 1 }), {
    intervalMs: 350,
    watchedIntervalMs: 8_000,
    watch: () => null,
    schedule: (callback, delay) => { scheduled.push(delay); return scheduled.length; },
    cancel: () => {},
  });
  const stop = feed.subscribeFrom('thread', null, () => {});
  await feed.refresh('thread');
  assert.ok(scheduled.includes(350), `无法监听时应保持原节奏, 实际: ${scheduled}`);
  stop();
  feed.close();
});

test('a watch event refreshes immediately rather than waiting for the next tick', async () => {
  let value = { n: 1 };
  let fire = null;
  const frames = [];
  const feed = createSnapshotFeed(async () => structuredClone(value), {
    intervalMs: 350,
    watchedIntervalMs: 8_000,
    watch: (resource, onChange) => { fire = onChange; return () => {}; },
  });
  const stop = feed.subscribeFrom('thread', null, (frame) => frames.push(frame));
  await feed.refresh('thread');

  value = { n: 2 };
  await fire();
  assert.ok(frames.some((f) => f.snapshot?.n === 2 || f.kind === 'delta'), '变更事件应立刻产出新帧');
  stop();
  feed.close();
});
