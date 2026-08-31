import crypto from 'node:crypto';
import { createSnapshotPatch } from '../public/snapshot-patch.js';

function defaultResourceKey(resource) {
  return typeof resource === 'string' ? resource : JSON.stringify(resource);
}

function defaultSchedule(callback, delay) {
  const timer = setTimeout(callback, delay);
  timer.unref?.();
  return timer;
}

export function createSnapshotFeed(loadSnapshot, {
  epoch = crypto.randomUUID(),
  intervalMs = 1_000,
  journalLimit = 128,
  journalBytes = 8 * 1024 * 1024,
  retentionMs = 60_000,
  maxPatchOperations = 512,
  patchRatio = 0.9,
  resourceKey = defaultResourceKey,
  serialize = JSON.stringify,
  schedule = defaultSchedule,
  cancel = clearTimeout,
} = {}) {
  const entries = new Map();
  let closed = false;

  function entryFor(resource) {
    const key = resourceKey(resource);
    let entry = entries.get(key);
    if (!entry) {
      entry = {
        key,
        resource,
        subscribers: new Set(),
        sequence: 0,
        fingerprint: null,
        latest: null,
        journal: [],
        journalBytes: 0,
        inFlight: null,
        timer: null,
        idleTimer: null,
        invalidated: false,
        retainOnIdle: false,
      };
      entries.set(key, entry);
    }
    return entry;
  }

  function clearScheduled(entry) {
    if (entry.timer == null) return;
    cancel(entry.timer);
    entry.timer = null;
  }

  function clearIdle(entry) {
    if (entry.idleTimer == null) return;
    cancel(entry.idleTimer);
    entry.idleTimer = null;
  }

  function dropSnapshot(entry) {
    entry.fingerprint = null;
    entry.latest = null;
    entry.journal = [];
    entry.journalBytes = 0;
  }

  function retainOrDrop(entry) {
    if (entry.subscribers.size) return;
    clearScheduled(entry);
    if (!entry.retainOnIdle || !Number.isFinite(retentionMs) || retentionMs <= 0) {
      dropSnapshot(entry);
      return;
    }
    clearIdle(entry);
    entry.idleTimer = schedule(() => {
      entry.idleTimer = null;
      if (entry.subscribers.size) return;
      dropSnapshot(entry);
      if (entries.get(entry.key) === entry) entries.delete(entry.key);
    }, retentionMs);
  }

  function scheduleNext(entry) {
    if (closed || !entry.subscribers.size || entry.timer != null || entry.inFlight) return;
    const configuredInterval = typeof intervalMs === 'function'
      ? intervalMs(entry.latest?.snapshot, entry.resource)
      : intervalMs;
    const delay = Number.isFinite(configuredInterval) && configuredInterval >= 0
      ? configuredInterval
      : 1_000;
    entry.timer = schedule(() => {
      entry.timer = null;
      refresh(entry.resource).catch(() => {});
    }, delay);
  }

  function notifyError(entry, error) {
    for (const subscriber of entry.subscribers) subscriber.onError(error);
  }

  function frameBytes(frame, serializedSnapshot, serializedPatch) {
    if (frame.kind === 'snapshot') return Buffer.byteLength(serializedSnapshot);
    return Buffer.byteLength(serializedPatch);
  }

  function appendJournal(entry, frame, serializedSnapshot, serializedPatch = '') {
    const stored = frame.kind === 'snapshot'
      ? frame
      : { ...frame, patch: JSON.parse(serializedPatch) };
    const bytes = frameBytes(stored, serializedSnapshot, serializedPatch);
    entry.journal.push({ ...stored, bytes });
    entry.journalBytes += bytes;
    const countLimit = Number.isSafeInteger(journalLimit) && journalLimit > 0 ? journalLimit : 128;
    const byteLimit = Number.isFinite(journalBytes) && journalBytes > 0 ? journalBytes : 8 * 1024 * 1024;
    while (entry.journal.length > 1
      && (entry.journal.length > countLimit || entry.journalBytes > byteLimit)) {
      entry.journalBytes -= entry.journal.shift().bytes;
    }
  }

  function createFrame(entry, snapshot, serializedSnapshot) {
    const previous = entry.latest;
    const sequence = entry.sequence + 1;
    if (previous) {
      let patch = null;
      try {
        patch = createSnapshotPatch(previous.snapshot, snapshot, { maxOperations: maxPatchOperations });
      } catch { /* A full frame remains the safe fallback. */ }
      if (patch) {
        const serializedPatch = JSON.stringify(patch);
        if (Buffer.byteLength(serializedPatch) < Buffer.byteLength(serializedSnapshot) * patchRatio) {
          return {
            frame: {
              kind: 'delta', epoch, sequence, baseSequence: previous.sequence, patch,
            },
            serializedPatch,
          };
        }
      }
    }
    return {
      frame: { kind: 'snapshot', epoch, sequence, snapshot },
      serializedPatch: '',
    };
  }

  function publish(entry, frame, snapshot) {
    for (const subscriber of entry.subscribers) {
      if (subscriber.mode === 'snapshot') {
        subscriber.onSnapshot(entry.latest);
      } else {
        const message = { ...frame, snapshot };
        if (subscriber.ready) subscriber.onSnapshot(message);
        else subscriber.pending.push(message);
      }
    }
  }

  function refresh(resource) {
    if (closed) return Promise.reject(new Error('Snapshot feed is closed'));
    const entry = entryFor(resource);
    if (entry.inFlight) return entry.inFlight;
    clearScheduled(entry);
    entry.invalidated = false;
    const request = Promise.resolve()
      .then(() => loadSnapshot(entry.resource))
      .then((snapshot) => {
        if (entry.invalidated) return entry.latest;
        const fingerprint = serialize(snapshot);
        if (fingerprint !== entry.fingerprint) {
          const { frame, serializedPatch } = createFrame(entry, snapshot, fingerprint);
          entry.fingerprint = fingerprint;
          entry.sequence = frame.sequence;
          entry.latest = { epoch, sequence: entry.sequence, snapshot };
          appendJournal(entry, frame, fingerprint, serializedPatch);
          publish(entry, frame, snapshot);
        }
        return entry.latest;
      })
      .catch((error) => {
        entry.fingerprint = null;
        notifyError(entry, error);
        throw error;
      })
      .finally(() => {
        if (entry.inFlight === request) entry.inFlight = null;
        if (!entry.subscribers.size) retainOrDrop(entry);
        if (entry.invalidated && entry.subscribers.size) {
          queueMicrotask(() => refresh(entry.resource).catch(() => {}));
        } else {
          scheduleNext(entry);
        }
      });
    entry.inFlight = request;
    return request;
  }

  function subscribe(resource, onSnapshot, onError = () => {}) {
    if (closed) throw new Error('Snapshot feed is closed');
    const entry = entryFor(resource);
    clearIdle(entry);
    const subscriber = { mode: 'snapshot', onSnapshot, onError };
    entry.subscribers.add(subscriber);
    if (entry.latest) queueMicrotask(() => {
      if (!closed && entry.subscribers.has(subscriber)) onSnapshot(entry.latest);
    });
    refresh(resource).catch(() => {});
    return () => {
      entry.subscribers.delete(subscriber);
      if (!entry.subscribers.size) retainOrDrop(entry);
    };
  }

  function normalizedCursor(cursor) {
    if (!cursor || typeof cursor.epoch !== 'string' || !cursor.epoch) return null;
    if (!Number.isSafeInteger(cursor.sequence) || cursor.sequence < 0) return null;
    return { epoch: cursor.epoch, sequence: cursor.sequence };
  }

  function fullFrame(entry) {
    return {
      kind: 'snapshot', epoch, sequence: entry.latest.sequence,
      snapshot: entry.latest.snapshot,
    };
  }

  function resumeFrames(entry, cursor) {
    if (!entry.latest) return [];
    const current = normalizedCursor(cursor);
    if (!current || current.epoch !== epoch || current.sequence > entry.latest.sequence) {
      return [fullFrame(entry)];
    }
    if (current.sequence === entry.latest.sequence) return [];
    const frames = entry.journal.filter((frame) => frame.sequence > current.sequence);
    let expected = current.sequence + 1;
    for (const frame of frames) {
      if (frame.sequence !== expected) return [fullFrame(entry)];
      expected += 1;
    }
    if (!frames.length || expected - 1 !== entry.latest.sequence) return [fullFrame(entry)];
    return frames.map(({ bytes: _bytes, ...frame }) => frame);
  }

  function subscribeFrom(resource, cursor, onSnapshot, onError = () => {}) {
    if (closed) throw new Error('Snapshot feed is closed');
    const entry = entryFor(resource);
    clearIdle(entry);
    entry.retainOnIdle = true;
    const initial = resumeFrames(entry, cursor);
    const initialSequence = entry.latest?.sequence || 0;
    const subscriber = {
      mode: 'delta', onSnapshot, onError, ready: false, pending: [],
    };
    entry.subscribers.add(subscriber);
    queueMicrotask(() => {
      if (closed || !entry.subscribers.has(subscriber)) return;
      let deliveredSequence = normalizedCursor(cursor)?.epoch === epoch
        ? normalizedCursor(cursor).sequence
        : 0;
      for (const frame of initial) {
        onSnapshot(frame);
        deliveredSequence = frame.sequence;
      }
      subscriber.ready = true;
      for (const frame of subscriber.pending.splice(0)) {
        if (frame.sequence <= deliveredSequence) continue;
        onSnapshot(frame);
        deliveredSequence = frame.sequence;
      }
      if (entry.latest) {
        onSnapshot({
          kind: 'synchronized', epoch, sequence: entry.latest.sequence,
          snapshot: entry.latest.snapshot,
        });
      }
    });
    refresh(resource).catch(() => {});
    return () => {
      entry.subscribers.delete(subscriber);
      subscriber.pending.length = 0;
      if (!entry.subscribers.size) retainOrDrop(entry);
    };
  }

  function canResume(resource, cursor) {
    const entry = entries.get(resourceKey(resource));
    const current = normalizedCursor(cursor);
    return Boolean(entry?.latest && current?.epoch === epoch
      && current.sequence <= entry.latest.sequence);
  }

  function invalidate(resource) {
    const entry = entryFor(resource);
    entry.fingerprint = null;
    entry.invalidated = true;
    if (entry.subscribers.size) return refresh(resource);
    return Promise.resolve(entry.latest);
  }

  function refreshSubscribed(matches = () => true) {
    if (closed) return Promise.reject(new Error('Snapshot feed is closed'));
    return Promise.all([...entries.values()]
      .filter((entry) => entry.subscribers.size && matches(entry.resource))
      .map((entry) => refresh(entry.resource)));
  }

  function close() {
    if (closed) return;
    closed = true;
    for (const entry of entries.values()) {
      clearScheduled(entry);
      clearIdle(entry);
      entry.subscribers.clear();
    }
    entries.clear();
  }

  return {
    epoch, subscribe, subscribeFrom, canResume,
    refresh, refreshSubscribed, invalidate, close,
  };
}
