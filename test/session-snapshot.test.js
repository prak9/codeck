import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionSnapshotLoader } from '../src/session-snapshot.js';

test('coalesces concurrent session snapshots and reuses the short-lived result', async () => {
  let calls = 0;
  let release;
  let now = 1_000;
  const gate = new Promise((resolve) => { release = resolve; });
  const snapshots = createSessionSnapshotLoader(async () => {
    calls += 1;
    await gate;
    return [{ name: `session-${calls}` }];
  }, { maxAgeMs: 750, now: () => now });

  const first = snapshots.get();
  const concurrent = snapshots.get();
  assert.equal(calls, 1);
  release();
  assert.equal(await concurrent, await first);
  assert.deepEqual(await snapshots.get(), [{ name: 'session-1' }]);
  assert.equal(calls, 1);

  now += 751;
  assert.deepEqual(await snapshots.get(), [{ name: 'session-2' }]);
  assert.equal(calls, 2);
});

test('invalidation prevents an older in-flight snapshot from being cached', async () => {
  const releases = [];
  let calls = 0;
  const snapshots = createSessionSnapshotLoader(() => new Promise((resolve) => {
    calls += 1;
    const call = calls;
    releases.push(() => resolve([{ name: `session-${call}` }]));
  }));

  const stale = snapshots.get();
  snapshots.invalidate();
  const fresh = snapshots.get();
  releases[0]();
  releases[1]();
  assert.deepEqual(await stale, [{ name: 'session-1' }]);
  assert.deepEqual(await fresh, [{ name: 'session-2' }]);
  assert.deepEqual(await snapshots.get(), [{ name: 'session-2' }]);
  assert.equal(calls, 2);
});

test('does not cache a failed session snapshot', async () => {
  let calls = 0;
  const snapshots = createSessionSnapshotLoader(async () => {
    calls += 1;
    if (calls === 1) throw new Error('tmux unavailable');
    return [{ name: 'recovered' }];
  });

  await assert.rejects(snapshots.get(), /tmux unavailable/);
  assert.deepEqual(await snapshots.get(), [{ name: 'recovered' }]);
});
