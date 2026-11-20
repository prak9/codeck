import crypto from 'node:crypto';
import { runPrecheck } from './conditional-tasks.js';

export function parseDurationMs(input) {
  if (typeof input === 'number' && Number.isFinite(input) && input > 0) return Math.trunc(input);
  const raw = String(input || '').trim();
  const match = raw.match(/^(\d+(?:\.\d+)?)\s*(s|sec|m|min|h|hr|d|day)$/i);
  if (!match) return null;
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  const factor = unit.startsWith('s') ? 1000
    : unit.startsWith('m') ? 60_000
    : unit.startsWith('h') ? 3_600_000
    : 86_400_000;
  const ms = Math.trunc(value * factor);
  return ms > 0 ? ms : null;
}

export function createAlwaysOnRuntime({
  store,
  handleScope,
  precheck = runPrecheck,
  now = Date.now,
  leaseMs = 60_000,
  batchLimit = 10,
  batchWindowMs = 0,
  workerId = `worker-${crypto.randomUUID().slice(0, 8)}`,
  logger = console,
}) {
  const activeScopes = new Set();
  const pendingWakes = new Map();
  let timerTicking = null;
  let closed = false;

  async function drainScope(scopeKey) {
    if (closed || activeScopes.has(scopeKey)) return;
    activeScopes.add(scopeKey);
    try {
      while (!closed) {
        const batch = store.claimBatch({ scopeKey, workerId, leaseMs, limit: batchLimit, now: now() });
        if (!batch.length) break;
        const ids = batch.map(e => e.id);
        let finalized = false;
        const helpers = {
          markSubmitting: (commandId, targetIds = ids) => {
            store.markEventsSubmitting(targetIds, commandId, now());
          },
          requeue: (targetIds = ids) => {
            store.completeEvents(targetIds, { status: 'pending', error: null, now: now() });
            finalized = true;
          },
          markUnknown: (message, targetIds = ids) => {
            store.completeEvents(targetIds, { status: 'unknown', error: message || '投递结果未确认', now: now() });
            finalized = true;
          },
          complete: (targetIds = ids) => {
            store.completeEvents(targetIds, { status: 'done', error: null, now: now() });
            finalized = true;
          },
        };
        try {
          const outcome = await handleScope(scopeKey, batch, helpers);
          if (!finalized) {
            if (outcome?.status === 'requeue') {
              store.completeEvents(ids, { status: 'pending', error: null, now: now() });
              break;
            } else if (outcome?.status === 'unknown') {
              store.completeEvents(ids, { status: 'unknown', error: outcome.error || '投递结果未确认', now: now() });
            } else {
              store.completeEvents(ids, { status: 'done', error: null, now: now() });
            }
          }
        } catch (error) {
          if (!finalized) {
            // Check if any event already crossed the external-effect boundary.
            const refreshed = ids.map(id => store.db.prepare('SELECT id, command_id FROM events WHERE id = ?').get(id));
            const submittedIds = refreshed.filter(r => r?.command_id).map(r => r.id);
            const unsubmittedIds = refreshed.filter(r => r && !r.command_id).map(r => r.id);
            if (submittedIds.length) {
              store.completeEvents(submittedIds, {
                status: 'unknown',
                error: error?.message || '投递异常，结果未确认，未自动重放',
                now: now(),
              });
            }
            if (unsubmittedIds.length) {
              store.completeEvents(unsubmittedIds, {
                status: 'failed',
                error: error?.message || '事件处理失败',
                now: now(),
              });
            }
          }
          logger.warn?.(`AlwaysOn worker [${scopeKey}]: ${error?.message || error}`);
          break;
        }
      }
    } finally {
      activeScopes.delete(scopeKey);
    }
  }

  function wake(scopeKey) {
    if (closed) return Promise.resolve();
    if (batchWindowMs <= 0) return drainScope(scopeKey);
    if (pendingWakes.has(scopeKey)) return pendingWakes.get(scopeKey);
    const promise = new Promise(resolve => {
      const t = setTimeout(() => {
        pendingWakes.delete(scopeKey);
        drainScope(scopeKey).finally(resolve);
      }, batchWindowMs);
      t.unref?.();
    });
    pendingWakes.set(scopeKey, promise);
    return promise;
  }

  async function enqueueAndWake(eventInput) {
    const result = store.enqueueEvent({ ...eventInput, now: now() });
    if (result.inserted) wake(result.event.scopeKey).catch(() => {});
    return result;
  }

  async function tickTimers() {
    if (closed) return { fired: 0, skipped: 0, errors: 0 };
    if (timerTicking) return timerTicking;
    timerTicking = (async () => {
      const currentNow = now();
      store.recoverExpiredLeases({ now: currentNow });
      const due = store.dueTimers(currentNow);
      let fired = 0;
      let skipped = 0;
      let errors = 0;
      for (const timer of due) {
        if (closed) break;
        const nextDue = timer.kind === 'schedule'
          ? Math.max(currentNow + timer.recurrenceMs, timer.dueAt + timer.recurrenceMs)
          : timer.dueAt;
        try {
          let eventKey = null;
          if (timer.check) {
            eventKey = await precheck({ check: timer.check, cwd: timer.cwd });
            if (!eventKey) {
              store.updateTimerState(timer.id, {
                status: timer.kind === 'follow_up' ? 'done' : 'active',
                dueAt: nextDue,
                lastStatus: 'skipped',
                lastError: null,
                now: now(),
              });
              skipped++;
              continue;
            }
          }

          const dedupeKey = eventKey
            ? `timer:${timer.id}:check:${eventKey}`
            : `timer:${timer.id}:due:${timer.dueAt}`;
          const enqueued = store.enqueueEvent({
            scopeKey: timer.scopeKey,
            source: 'timer',
            dedupeKey,
            payload: {
              timerId: timer.id,
              timerKind: timer.kind,
              reason: timer.reason,
              sessionName: timer.sessionName,
              provider: timer.provider,
              threadId: timer.threadId,
              eventKey,
              ...timer.payload,
            },
            now: now(),
          });

          store.updateTimerState(timer.id, {
            status: timer.kind === 'follow_up' ? 'done' : 'active',
            dueAt: nextDue,
            lastStatus: enqueued.inserted ? 'enqueued' : 'deduped',
            lastError: null,
            lastFiredAt: now(),
            now: now(),
          });

          if (enqueued.inserted) {
            fired++;
            wake(timer.scopeKey).catch(() => {});
          } else {
            skipped++;
          }
        } catch (error) {
          errors++;
          store.updateTimerState(timer.id, {
            status: timer.kind === 'follow_up' ? 'done' : 'active',
            dueAt: nextDue,
            lastStatus: 'check_error',
            lastError: error?.message || String(error),
            now: now(),
          });
        }
      }
      // Also wake any recovered pending scopes.
      for (const scopeKey of store.pendingScopes()) {
        if (!activeScopes.has(scopeKey)) wake(scopeKey).catch(() => {});
      }
      return { fired, skipped, errors };
    })().finally(() => { timerTicking = null; });
    return timerTicking;
  }

  function recoverOnStartup() {
    const recovered = store.recoverExpiredLeases({ now: now() });
    for (const scopeKey of store.pendingScopes()) wake(scopeKey).catch(() => {});
    return recovered;
  }

  function close() {
    closed = true;
    pendingWakes.clear();
  }

  return {
    enqueueAndWake,
    wake,
    drainScope,
    tickTimers,
    recoverOnStartup,
    close,
  };
}
