import { createHash } from 'node:crypto';

const day = 86_400_000;

// Compare local wall times, including both offsets around a clock transition.
// A missing local time is skipped. A repeated local time fires on its first occurrence.
export function nextCalendarDue(calendar, after) {
  if (!calendar || !/^([01]\d|2[0-3]):[0-5]\d$/.test(calendar.time) || typeof calendar.timeZone !== 'string' || !calendar.timeZone.trim()) {
    throw new Error('请提供 HH:MM 格式的时间和时区');
  }
  const clock = new Intl.DateTimeFormat('en-GB', { timeZone: calendar.timeZone, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  function localStamp(instant) {
    const parts = Object.fromEntries(clock.formatToParts(instant).map(({ type, value }) => [type, value]));
    return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
  }
  const [hour, minute] = calendar.time.split(':').map(Number);
  const today = Math.floor(localStamp(after) / day) * day;
  for (let i = 0; i < 8; i++) {
    const wall = today + i * day + (hour * 60 + minute) * 60_000;
    const weekday = new Date(wall).getUTCDay();
    if (calendar.weekdays && (weekday === 6 || weekday === 0)) continue;
    const offsets = [wall - day, wall + day].map(instant => localStamp(instant) - instant);
    const instants = offsets.map(offset => wall - offset).filter(instant => localStamp(instant) === wall);
    const first = Math.min(...instants);
    if (Number.isFinite(first) && first > after) return first;
  }
  throw new Error('无法确定下一次执行时间，请检查规则的时区');
}

// Advance the due time, reserve the event and publish its check result in one
// transaction. An asynchronous condition can finish after pause or deletion.
export async function checkAutomationTimer(store, timer, { now, precheck, requestId = null }) {
  const occurrence = requestId ? 'manual:' + requestId : 'due:' + timer.dueAt + ':revision:' + timer.updatedAt;
  const existing = () => store.db.prepare('SELECT status, event_id AS eventId FROM timer_checks WHERE timer_id=? AND occurrence=?').get(timer.id, occurrence);
  const checked = requestId && existing();
  if (checked) return { ...checked, inserted: false };
  let eventKey = null, error = null;
  try {
    if (timer.check) eventKey = await precheck({ check: timer.check, cwd: timer.cwd });
  } catch (cause) { error = cause.message || String(cause); }
  const at = now();
  const dueAt = requestId ? at : timer.dueAt;
  const work = timer.scopeKey === 'workstation:' + timer.id;
  store.db.exec('BEGIN IMMEDIATE');
  try {
    const duplicate = requestId && existing();
    if (duplicate) {
      store.db.exec('COMMIT');
      return { ...duplicate, inserted: false };
    }
    const live = store.getTimer(timer.id);
    if (!live || live.status !== 'active' || live.payload.version !== timer.payload.version || live.updatedAt !== timer.updatedAt || live.dueAt !== timer.dueAt) {
      store.db.exec('COMMIT');
      return { status: 'cancelled', inserted: false, eventId: null };
    }
    let status = error ? 'check_error' : 'skipped', eventId = null;
    if (!error && (!timer.check || eventKey)) {
      const prefix = 'timer:' + timer.id + ':';
      const key = eventKey ? 'check:' + eventKey : requestId ? occurrence : 'due:' + timer.dueAt;
      const dedupeKey = prefix.length + key.length <= 256 ? prefix + key
        : prefix + 'sha256:' + createHash('sha256').update(key).digest('hex');
      const result = store.enqueueEvent({ scopeKey: timer.scopeKey, source: 'timer', dedupeKey, now: at,
        payload: { timerId: timer.id, timerKind: timer.kind, reason: timer.reason, sessionName: timer.sessionName,
          provider: timer.provider, threadId: timer.threadId, eventKey, ...timer.payload } });
      eventId = result.event.id;
      status = result.inserted ? 'enqueued' : 'deduped';
    }
    if (!requestId) {
      const nextDue = timer.kind !== 'schedule' ? timer.dueAt : (work || timer.payload.version) && timer.payload.calendar
        ? nextCalendarDue(timer.payload.calendar, at) : Math.max(at, timer.dueAt) + timer.recurrenceMs;
      store.updateTimerState(timer.id, { dueAt: nextDue, status: timer.kind === 'follow_up' ? 'done' : 'active',
        lastStatus: status, lastError: error, ...(eventId ? { lastFiredAt: at } : {}), now: at });
    }
    store.db.prepare('INSERT OR IGNORE INTO timer_checks(timer_id, occurrence, due_at, checked_at, status, error, event_id) VALUES(?,?,?,?,?,?,?)')
      .run(timer.id, occurrence, dueAt, at, status, error, eventId);
    store.db.exec('COMMIT');
    return { status, eventId, inserted: status === 'enqueued' };
  } catch (cause) {
    store.db.exec('ROLLBACK');
    throw cause;
  }
}
