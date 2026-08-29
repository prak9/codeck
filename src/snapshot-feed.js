import crypto from 'node:crypto';

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
        inFlight: null,
        timer: null,
        invalidated: false,
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
          entry.fingerprint = fingerprint;
          entry.sequence += 1;
          entry.latest = { epoch, sequence: entry.sequence, snapshot };
          for (const subscriber of entry.subscribers) subscriber.onSnapshot(entry.latest);
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
        if (!entry.subscribers.size) {
          entry.fingerprint = null;
          entry.latest = null;
        }
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
    const subscriber = { onSnapshot, onError };
    entry.subscribers.add(subscriber);
    if (entry.latest) queueMicrotask(() => {
      if (!closed && entry.subscribers.has(subscriber)) onSnapshot(entry.latest);
    });
    refresh(resource).catch(() => {});
    return () => {
      entry.subscribers.delete(subscriber);
      if (!entry.subscribers.size) {
        clearScheduled(entry);
        entry.fingerprint = null;
        entry.latest = null;
      }
    };
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
      entry.subscribers.clear();
    }
    entries.clear();
  }

  return { epoch, subscribe, refresh, refreshSubscribed, invalidate, close };
}
