export function createSessionSnapshotLoader(loadSessions, {
  maxAgeMs = 750, now = Date.now,
} = {}) {
  let cached;
  let hasCached = false;
  let expiresAt = 0;
  let inFlight = null;
  let generation = 0;

  function get() {
    if (hasCached && now() < expiresAt) return Promise.resolve(cached);
    if (inFlight) return inFlight;
    const requestGeneration = generation;
    let loaded;
    try { loaded = loadSessions(); }
    catch (error) { return Promise.reject(error); }
    const request = Promise.resolve(loaded)
      .then((value) => {
        if (requestGeneration === generation) {
          cached = value;
          hasCached = true;
          expiresAt = now() + maxAgeMs;
        }
        return value;
      })
      .finally(() => {
        if (inFlight === request) inFlight = null;
      });
    inFlight = request;
    return request;
  }

  function invalidate() {
    generation += 1;
    cached = undefined;
    hasCached = false;
    expiresAt = 0;
    inFlight = null;
  }

  return { get, invalidate };
}
