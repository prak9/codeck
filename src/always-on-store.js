import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const VALID_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,95}$/;
const VALID_SOURCES = new Set(['web', 'telegram', 'annotation', 'timer', 'conditional_task', 'webhook', 'approval_resolved', 'worker_receipt', 'system']);
const VALID_EVENT_STATUS = new Set(['pending', 'processing', 'done', 'failed', 'unknown']);
const VALID_TIMER_KINDS = new Set(['follow_up', 'schedule']);
const VALID_TIMER_STATUS = new Set(['active', 'paused', 'done']);
const VALID_PRIORITIES = new Set(['silent', 'digest', 'notify', 'urgent']);
const VALID_CHANNELS = new Set(['web', 'telegram', 'all']);
const VALID_OUTBOX_STATUS = new Set(['pending', 'sent', 'suppressed', 'failed', 'digested']);
const VALID_APPROVAL_RISK = new Set(['guard', 'defer']);
const VALID_APPROVAL_STATUS = new Set(['pending', 'approved', 'rejected', 'expired']);
const VALID_BLUEPRINT_STATUS = new Set(['draft', 'active', 'paused', 'archived']);
const VALID_PROPOSAL_STATUS = new Set(['pending', 'accepted', 'rejected']);
const VALID_ENTITY_KEY = /^[a-zA-Z0-9][a-zA-Z0-9_.:/#-]{0,127}$/;

function parseJson(text, fallback = {}) {
  try { return JSON.parse(text); } catch { return fallback; }
}

function hydrateEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    scopeKey: row.scope_key,
    source: row.source,
    dedupeKey: row.dedupe_key,
    payload: parseJson(row.payload_json, {}),
    status: row.status,
    leaseOwner: row.lease_owner,
    leaseUntil: row.lease_until,
    attempts: row.attempts,
    error: row.error,
    commandId: row.command_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    processedAt: row.processed_at,
  };
}

function hydrateTimer(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    scopeKey: row.scope_key,
    dueAt: row.due_at,
    recurrenceMs: row.recurrence_ms,
    reason: row.reason,
    sessionName: row.session_name,
    provider: row.provider,
    threadId: row.thread_id,
    cwd: row.cwd,
    check: row.check_cmd_json ? parseJson(row.check_cmd_json, null) : null,
    payload: parseJson(row.payload_json, {}),
    status: row.status,
    lastStatus: row.last_status,
    lastError: row.last_error,
    lastFiredAt: row.last_fired_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function hydrateOutbox(row) {
  if (!row) return null;
  return {
    id: row.id,
    scopeKey: row.scope_key,
    priority: row.priority,
    channel: row.channel,
    dedupeKey: row.dedupe_key,
    title: row.title,
    contentMd: row.content_md,
    meta: parseJson(row.meta_json, {}),
    status: row.status,
    deliverAfter: row.deliver_after,
    attempts: row.attempts,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sentAt: row.sent_at,
  };
}

function hydrateApproval(row) {
  if (!row) return null;
  return {
    id: row.id,
    scopeKey: row.scope_key,
    sessionName: row.session_name,
    provider: row.provider,
    threadId: row.thread_id,
    summary: row.summary,
    action: parseJson(row.action_json, {}),
    risk: row.risk,
    status: row.status,
    decisionNote: row.decision_note,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

function hydrateBlueprint(row) {
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    goal: row.goal,
    processMd: row.process_md,
    tacitRulesMd: row.tacit_rules_md,
    sourceOfTruth: row.source_of_truth,
    doneCriteria: row.done_criteria,
    feedbackSources: parseJson(row.feedback_sources_json, []),
    entityKey: row.entity_key,
    targetSession: row.target_session,
    status: row.status,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function hydrateEntityLink(row) {
  if (!row) return null;
  return {
    id: row.id,
    entityKey: row.entity_key,
    refType: row.ref_type,
    refId: row.ref_id,
    summary: row.summary,
    meta: parseJson(row.meta_json, {}),
    createdAt: row.created_at,
  };
}

function hydrateProposal(row) {
  if (!row) return null;
  return {
    id: row.id,
    blueprintId: row.blueprint_id,
    entityKey: row.entity_key,
    title: row.title,
    rationale: row.rationale,
    suggestedPatch: parseJson(row.suggested_patch_json, {}),
    status: row.status,
    decisionNote: row.decision_note,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

export class AlwaysOnStore {
  constructor(dbFile) {
    if (dbFile !== ':memory:') {
      const dir = path.dirname(dbFile);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    this.dbFile = dbFile;
    this.db = new DatabaseSync(dbFile);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=NORMAL;
      PRAGMA busy_timeout=5000;

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        source TEXT NOT NULL,
        dedupe_key TEXT UNIQUE,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        lease_owner TEXT,
        lease_until INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        command_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        processed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_events_scope_status ON events(scope_key, status, created_at);
      CREATE INDEX IF NOT EXISTS idx_events_status_lease ON events(status, lease_until);

      CREATE TABLE IF NOT EXISTS timers (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        due_at INTEGER NOT NULL,
        recurrence_ms INTEGER,
        reason TEXT NOT NULL,
        session_name TEXT,
        provider TEXT,
        thread_id TEXT,
        cwd TEXT,
        check_cmd_json TEXT,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        last_status TEXT,
        last_error TEXT,
        last_fired_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_timers_status_due ON timers(status, due_at);

      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        priority TEXT NOT NULL,
        channel TEXT NOT NULL,
        dedupe_key TEXT UNIQUE,
        title TEXT NOT NULL,
        content_md TEXT NOT NULL,
        meta_json TEXT NOT NULL,
        status TEXT NOT NULL,
        deliver_after INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        sent_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_outbox_status_deliver ON outbox(status, deliver_after, priority);

      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        session_name TEXT,
        provider TEXT,
        thread_id TEXT,
        summary TEXT NOT NULL,
        action_json TEXT NOT NULL,
        risk TEXT NOT NULL,
        status TEXT NOT NULL,
        decision_note TEXT,
        created_at INTEGER NOT NULL,
        resolved_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_approvals_status_created ON approvals(status, created_at);

      CREATE TABLE IF NOT EXISTS blueprints (
        id TEXT PRIMARY KEY,
        slug TEXT UNIQUE NOT NULL,
        title TEXT NOT NULL,
        goal TEXT NOT NULL,
        process_md TEXT NOT NULL,
        tacit_rules_md TEXT NOT NULL,
        source_of_truth TEXT NOT NULL,
        done_criteria TEXT NOT NULL,
        feedback_sources_json TEXT NOT NULL,
        entity_key TEXT NOT NULL,
        target_session TEXT,
        status TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_blueprints_status_updated ON blueprints(status, updated_at);

      CREATE TABLE IF NOT EXISTS entity_links (
        id TEXT PRIMARY KEY,
        entity_key TEXT NOT NULL,
        ref_type TEXT NOT NULL,
        ref_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        meta_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_entity_links_key_created ON entity_links(entity_key, created_at DESC);

      CREATE TABLE IF NOT EXISTS proposals (
        id TEXT PRIMARY KEY,
        blueprint_id TEXT,
        entity_key TEXT NOT NULL,
        title TEXT NOT NULL,
        rationale TEXT NOT NULL,
        suggested_patch_json TEXT NOT NULL,
        status TEXT NOT NULL,
        decision_note TEXT,
        created_at INTEGER NOT NULL,
        resolved_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_proposals_status_created ON proposals(status, created_at DESC);
    `);
  }

  close() {
    this.db.close();
  }

  enqueueEvent({ id, scopeKey, source, dedupeKey = null, payload = {}, now = Date.now() }) {
    if (typeof scopeKey !== 'string' || !scopeKey.trim() || scopeKey.length > 160) {
      throw new Error('无效的 scopeKey');
    }
    if (!VALID_SOURCES.has(source)) throw new Error('未知的事件来源');
    if (dedupeKey !== null && (typeof dedupeKey !== 'string' || !dedupeKey.trim() || dedupeKey.length > 256)) {
      throw new Error('无效的 dedupeKey');
    }
    const eventId = id || `evt-${crypto.randomUUID()}`;
    const payloadJson = JSON.stringify(payload ?? {});
    if (Buffer.byteLength(payloadJson) > 128 * 1024) throw new Error('事件载荷过大');

    const result = this.db.prepare(`
      INSERT OR IGNORE INTO events
        (id, scope_key, source, dedupe_key, payload_json, status, attempts, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)
    `).run(eventId, scopeKey.trim(), source, dedupeKey ? dedupeKey.trim() : null, payloadJson, now, now);

    if (result.changes === 0 && dedupeKey) {
      const existing = this.db.prepare('SELECT * FROM events WHERE dedupe_key = ?').get(dedupeKey.trim());
      return { inserted: false, event: hydrateEvent(existing) };
    }
    const created = this.db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
    return { inserted: true, event: hydrateEvent(created) };
  }

  recoverExpiredLeases({ now = Date.now() } = {}) {
    const expired = this.db.prepare(`
      SELECT id, command_id FROM events
      WHERE status = 'processing' AND lease_until IS NOT NULL AND lease_until <= ?
    `).all(now);

    let requeued = 0;
    let markedUnknown = 0;
    if (!expired.length) return { requeued, markedUnknown };

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const toPending = this.db.prepare(`
        UPDATE events
        SET status = 'pending', lease_owner = NULL, lease_until = NULL, updated_at = ?
        WHERE id = ? AND status = 'processing'
      `);
      const toUnknown = this.db.prepare(`
        UPDATE events
        SET status = 'unknown', lease_owner = NULL, lease_until = NULL,
            error = '进程中断，投递结果未确认；请核实会话状态，未自动重放',
            updated_at = ?, processed_at = ?
        WHERE id = ? AND status = 'processing'
      `);
      for (const row of expired) {
        if (row.command_id) {
          toUnknown.run(now, now, row.id);
          markedUnknown++;
        } else {
          toPending.run(now, row.id);
          requeued++;
        }
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { requeued, markedUnknown };
  }

  claimBatch({ scopeKey, workerId, leaseMs = 60_000, limit = 10, now = Date.now() }) {
    if (!scopeKey || !workerId) throw new Error('claimBatch 需要 scopeKey 和 workerId');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const active = this.db.prepare(`
        SELECT 1 FROM events
        WHERE scope_key = ? AND status = 'processing' AND (lease_until IS NULL OR lease_until > ?)
        LIMIT 1
      `).get(scopeKey, now);
      if (active) {
        this.db.exec('COMMIT');
        return [];
      }

      const rows = this.db.prepare(`
        SELECT * FROM events
        WHERE scope_key = ? AND status = 'pending'
        ORDER BY created_at ASC, rowid ASC
        LIMIT ?
      `).all(scopeKey, Math.max(1, Math.min(50, limit)));

      if (!rows.length) {
        this.db.exec('COMMIT');
        return [];
      }

      const leaseUntil = now + leaseMs;
      const update = this.db.prepare(`
        UPDATE events
        SET status = 'processing', lease_owner = ?, lease_until = ?, attempts = attempts + 1, updated_at = ?
        WHERE id = ?
      `);
      for (const row of rows) update.run(workerId, leaseUntil, now, row.id);
      this.db.exec('COMMIT');
      return rows.map(row => hydrateEvent({
        ...row,
        status: 'processing',
        lease_owner: workerId,
        lease_until: leaseUntil,
        attempts: row.attempts + 1,
        updated_at: now,
      }));
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  markEventsSubmitting(eventIds, commandId, now = Date.now()) {
    if (!Array.isArray(eventIds) || !eventIds.length || !commandId) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const stmt = this.db.prepare(`
        UPDATE events SET command_id = ?, updated_at = ? WHERE id = ?
      `);
      for (const id of eventIds) stmt.run(commandId, now, id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  completeEvents(eventIds, { status = 'done', error = null, now = Date.now() } = {}) {
    if (!VALID_EVENT_STATUS.has(status)) throw new Error('无效的事件状态');
    if (!Array.isArray(eventIds) || !eventIds.length) return;
    const processedAt = status === 'pending' ? null : now;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const stmt = this.db.prepare(`
        UPDATE events
        SET status = ?, lease_owner = NULL, lease_until = NULL, error = ?, updated_at = ?, processed_at = ?
        WHERE id = ?
      `);
      for (const id of eventIds) stmt.run(status, error, now, processedAt, id);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  pendingScopes() {
    return this.db.prepare(`
      SELECT DISTINCT scope_key FROM events WHERE status = 'pending' ORDER BY scope_key ASC
    `).all().map(r => r.scope_key);
  }

  listEvents({ scopeKey = null, status = null, limit = 50 } = {}) {
    const clauses = [];
    const params = [];
    if (scopeKey) { clauses.push('scope_key = ?'); params.push(scopeKey); }
    if (status) {
      if (!VALID_EVENT_STATUS.has(status)) throw new Error('无效的事件状态过滤');
      clauses.push('status = ?');
      params.push(status);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.prepare(`
      SELECT * FROM events ${where} ORDER BY created_at DESC, rowid DESC LIMIT ?
    `).all(...params, Math.max(1, Math.min(200, limit)));
    return rows.map(hydrateEvent);
  }

  putTimer({
    id,
    kind,
    scopeKey,
    dueAt,
    recurrenceMs = null,
    reason,
    sessionName = null,
    provider = null,
    threadId = null,
    cwd = null,
    check = null,
    payload = {},
    status = 'active',
    now = Date.now(),
  }) {
    const timerId = id || `tmr-${crypto.randomUUID().slice(0, 12)}`;
    if (!VALID_ID.test(timerId)) throw new Error('无效的定时器 ID');
    if (!VALID_TIMER_KINDS.has(kind)) throw new Error('无效的定时器类型');
    if (!VALID_TIMER_STATUS.has(status)) throw new Error('无效的定时器状态');
    if (typeof scopeKey !== 'string' || !scopeKey.trim()) throw new Error('无效的 scopeKey');
    if (!Number.isFinite(dueAt) || dueAt <= 0) throw new Error('无效的到期时间');
    if (kind === 'schedule' && (!Number.isFinite(recurrenceMs) || recurrenceMs < 10_000)) {
      throw new Error('周期定时器 recurrenceMs 至少 10 秒');
    }
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 2000) {
      throw new Error('定时器说明不能为空且不超过 2000 字');
    }
    if (check !== null) {
      if (!Array.isArray(check) || !check.length || check.some(v => typeof v !== 'string' || v.includes('\0')) || !path.isAbsolute(check[0])) {
        throw new Error('无效的预检命令');
      }
      if (!cwd || !path.isAbsolute(cwd)) throw new Error('预检命令需要绝对路径 cwd');
    }

    const existing = this.db.prepare('SELECT created_at FROM timers WHERE id = ?').get(timerId);
    const createdAt = existing ? existing.created_at : now;
    this.db.prepare(`
      INSERT OR REPLACE INTO timers
        (id, kind, scope_key, due_at, recurrence_ms, reason, session_name, provider, thread_id, cwd, check_cmd_json, payload_json, status, last_status, last_error, last_fired_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        COALESCE((SELECT last_status FROM timers WHERE id = ?), NULL),
        COALESCE((SELECT last_error FROM timers WHERE id = ?), NULL),
        COALESCE((SELECT last_fired_at FROM timers WHERE id = ?), NULL),
        ?, ?)
    `).run(
      timerId, kind, scopeKey.trim(), Math.trunc(dueAt), recurrenceMs ? Math.trunc(recurrenceMs) : null,
      reason.trim(), sessionName, provider, threadId, cwd,
      check ? JSON.stringify(check) : null, JSON.stringify(payload ?? {}),
      status, timerId, timerId, timerId, createdAt, now,
    );
    return hydrateTimer(this.db.prepare('SELECT * FROM timers WHERE id = ?').get(timerId));
  }

  getTimer(id) {
    return hydrateTimer(this.db.prepare('SELECT * FROM timers WHERE id = ?').get(id));
  }

  listTimers({ status = null, kind = null, scopeKey = null } = {}) {
    const clauses = [];
    const params = [];
    if (status) { clauses.push('status = ?'); params.push(status); }
    if (kind) { clauses.push('kind = ?'); params.push(kind); }
    if (scopeKey) { clauses.push('scope_key = ?'); params.push(scopeKey); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db.prepare(`SELECT * FROM timers ${where} ORDER BY due_at ASC`).all(...params).map(hydrateTimer);
  }

  dueTimers(now = Date.now()) {
    return this.db.prepare(`
      SELECT * FROM timers WHERE status = 'active' AND due_at <= ? ORDER BY due_at ASC
    `).all(now).map(hydrateTimer);
  }

  updateTimerState(id, { status, dueAt, lastStatus, lastError, lastFiredAt, now = Date.now() }) {
    const current = this.db.prepare('SELECT * FROM timers WHERE id = ?').get(id);
    if (!current) return null;
    const nextStatus = status ?? current.status;
    if (!VALID_TIMER_STATUS.has(nextStatus)) throw new Error('无效的定时器状态');
    this.db.prepare(`
      UPDATE timers
      SET status = ?, due_at = ?, last_status = ?, last_error = ?, last_fired_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      nextStatus,
      dueAt !== undefined ? Math.trunc(dueAt) : current.due_at,
      lastStatus !== undefined ? lastStatus : current.last_status,
      lastError !== undefined ? lastError : current.last_error,
      lastFiredAt !== undefined ? lastFiredAt : current.last_fired_at,
      now,
      id,
    );
    return hydrateTimer(this.db.prepare('SELECT * FROM timers WHERE id = ?').get(id));
  }

  removeTimer(id) {
    const result = this.db.prepare('DELETE FROM timers WHERE id = ?').run(id);
    return result.changes > 0;
  }

  enqueueOutbox({
    id,
    scopeKey = 'butler',
    priority = 'notify',
    channel = 'web',
    dedupeKey = null,
    title,
    contentMd,
    meta = {},
    deliverAfter = Date.now(),
    now = Date.now(),
  }) {
    if (!VALID_PRIORITIES.has(priority)) throw new Error('无效的 Outbox 优先级');
    if (!VALID_CHANNELS.has(channel)) throw new Error('无效的 Outbox 通道');
    if (typeof title !== 'string' || !title.trim()) throw new Error('Outbox 标题不能为空');
    if (typeof contentMd !== 'string') throw new Error('Outbox 内容必须为字符串');
    const outId = id || `out-${crypto.randomUUID()}`;
    const initialStatus = priority === 'silent' ? 'suppressed' : 'pending';

    const result = this.db.prepare(`
      INSERT OR IGNORE INTO outbox
        (id, scope_key, priority, channel, dedupe_key, title, content_md, meta_json, status, deliver_after, attempts, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(
      outId, scopeKey, priority, channel, dedupeKey ? dedupeKey.trim() : null,
      title.trim(), contentMd, JSON.stringify(meta ?? {}), initialStatus, Math.trunc(deliverAfter), now, now,
    );

    if (result.changes === 0 && dedupeKey) {
      const existing = this.db.prepare('SELECT * FROM outbox WHERE dedupe_key = ?').get(dedupeKey.trim());
      return { inserted: false, item: hydrateOutbox(existing) };
    }
    return { inserted: true, item: hydrateOutbox(this.db.prepare('SELECT * FROM outbox WHERE id = ?').get(outId)) };
  }

  listOutbox({ status = null, priority = null, limit = 50 } = {}) {
    const clauses = [];
    const params = [];
    if (status) { clauses.push('status = ?'); params.push(status); }
    if (priority) { clauses.push('priority = ?'); params.push(priority); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db.prepare(`
      SELECT * FROM outbox ${where} ORDER BY created_at DESC, rowid DESC LIMIT ?
    `).all(...params, Math.max(1, Math.min(200, limit))).map(hydrateOutbox);
  }

  updateOutboxStatus(id, { status, error = null, incrementAttempts = false, now = Date.now() }) {
    if (!VALID_OUTBOX_STATUS.has(status)) throw new Error('无效的 Outbox 状态');
    const sentAt = status === 'sent' || status === 'digested' ? now : null;
    this.db.prepare(`
      UPDATE outbox
      SET status = ?, error = ?, attempts = attempts + ?, updated_at = ?, sent_at = COALESCE(?, sent_at)
      WHERE id = ?
    `).run(status, error, incrementAttempts ? 1 : 0, now, sentAt, id);
    return hydrateOutbox(this.db.prepare('SELECT * FROM outbox WHERE id = ?').get(id));
  }

  createApproval({
    id,
    scopeKey,
    sessionName = null,
    provider = null,
    threadId = null,
    summary,
    action = {},
    risk = 'defer',
    now = Date.now(),
  }) {
    if (!VALID_APPROVAL_RISK.has(risk)) throw new Error('无效的审批风险级别');
    if (typeof summary !== 'string' || !summary.trim()) throw new Error('审批摘要不能为空');
    const approvalId = id || `apr-${crypto.randomUUID().slice(0, 12)}`;
    this.db.prepare(`
      INSERT INTO approvals (id, scope_key, session_name, provider, thread_id, summary, action_json, risk, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(approvalId, scopeKey, sessionName, provider, threadId, summary.trim(), JSON.stringify(action ?? {}), risk, now);
    return hydrateApproval(this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId));
  }

  getApproval(id) {
    return hydrateApproval(this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id));
  }

  listApprovals({ status = null, limit = 50 } = {}) {
    const where = status ? 'WHERE status = ?' : '';
    const params = status ? [status] : [];
    return this.db.prepare(`
      SELECT * FROM approvals ${where} ORDER BY created_at DESC LIMIT ?
    `).all(...params, Math.max(1, Math.min(200, limit))).map(hydrateApproval);
  }

  resolveApproval(id, { status, decisionNote = null, now = Date.now() }) {
    if (!['approved', 'rejected', 'expired'].includes(status)) throw new Error('无效的审批结论');
    const result = this.db.prepare(`
      UPDATE approvals
      SET status = ?, decision_note = ?, resolved_at = ?
      WHERE id = ? AND status = 'pending'
    `).run(status, decisionNote, now, id);
    if (result.changes === 0) return null;
    return hydrateApproval(this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id));
  }

  putBlueprint({
    id,
    slug,
    title,
    goal,
    processMd = '',
    tacitRulesMd = '',
    sourceOfTruth = '',
    doneCriteria = '',
    feedbackSources = [],
    entityKey = null,
    targetSession = null,
    status = 'paused',
    now = Date.now(),
  }) {
    const cleanSlug = String(slug || '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(cleanSlug)) throw new Error('无效的蓝图 slug');
    if (typeof title !== 'string' || !title.trim()) throw new Error('蓝图标题不能为空');
    if (typeof goal !== 'string' || !goal.trim()) throw new Error('蓝图终局目标（goal）不能为空');
    if (!VALID_BLUEPRINT_STATUS.has(status)) throw new Error('无效的蓝图状态');
    const cleanEntity = String(entityKey || `mission:${cleanSlug}`).trim();
    if (!VALID_ENTITY_KEY.test(cleanEntity)) throw new Error('无效的 entityKey');

    const existing = this.db.prepare('SELECT * FROM blueprints WHERE slug = ?').get(cleanSlug);
    const bpId = existing ? existing.id : (id || `bp-${crypto.randomUUID().slice(0, 12)}`);
    const nextVersion = existing ? existing.version + 1 : 1;
    const createdAt = existing ? existing.created_at : now;

    this.db.prepare(`
      INSERT OR REPLACE INTO blueprints
        (id, slug, title, goal, process_md, tacit_rules_md, source_of_truth, done_criteria, feedback_sources_json, entity_key, target_session, status, version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      bpId, cleanSlug, title.trim(), goal.trim(), String(processMd ?? ''), String(tacitRulesMd ?? ''),
      String(sourceOfTruth ?? ''), String(doneCriteria ?? ''), JSON.stringify(Array.isArray(feedbackSources) ? feedbackSources : []),
      cleanEntity, targetSession || null, status, nextVersion, createdAt, now,
    );
    return hydrateBlueprint(this.db.prepare('SELECT * FROM blueprints WHERE id = ?').get(bpId));
  }

  getBlueprintBySlug(slug) {
    return hydrateBlueprint(this.db.prepare('SELECT * FROM blueprints WHERE slug = ?').get(String(slug || '').trim().toLowerCase()));
  }

  getBlueprintById(id) {
    return hydrateBlueprint(this.db.prepare('SELECT * FROM blueprints WHERE id = ?').get(id));
  }

  listBlueprints({ status = null, limit = 50 } = {}) {
    const where = status ? 'WHERE status = ?' : '';
    const params = status ? [status] : [];
    return this.db.prepare(`SELECT * FROM blueprints ${where} ORDER BY updated_at DESC LIMIT ?`).all(...params, Math.max(1, Math.min(200, limit))).map(hydrateBlueprint);
  }

  updateBlueprintStatus(slug, status, now = Date.now()) {
    if (!VALID_BLUEPRINT_STATUS.has(status)) throw new Error('无效的蓝图状态');
    const result = this.db.prepare('UPDATE blueprints SET status = ?, updated_at = ? WHERE slug = ?').run(status, now, String(slug || '').trim().toLowerCase());
    if (result.changes === 0) return null;
    return this.getBlueprintBySlug(slug);
  }

  addEntityLink({ id, entityKey, refType, refId, summary, meta = {}, now = Date.now() }) {
    const cleanKey = String(entityKey || '').trim();
    if (!VALID_ENTITY_KEY.test(cleanKey)) throw new Error('无效的 entityKey');
    if (typeof refType !== 'string' || !refType.trim()) throw new Error('refType 不能为空');
    if (typeof refId !== 'string' || !refId.trim()) throw new Error('refId 不能为空');
    const linkId = id || `ent-${crypto.randomUUID().slice(0, 12)}`;
    this.db.prepare(`
      INSERT INTO entity_links (id, entity_key, ref_type, ref_id, summary, meta_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(linkId, cleanKey, refType.trim(), refId.trim(), String(summary || '').trim(), JSON.stringify(meta ?? {}), now);
    return hydrateEntityLink(this.db.prepare('SELECT * FROM entity_links WHERE id = ?').get(linkId));
  }

  listEntityLinks({ entityKey = null, refType = null, limit = 50 } = {}) {
    const clauses = [];
    const params = [];
    if (entityKey) { clauses.push('entity_key = ?'); params.push(entityKey); }
    if (refType) { clauses.push('ref_type = ?'); params.push(refType); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db.prepare(`SELECT * FROM entity_links ${where} ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(...params, Math.max(1, Math.min(200, limit))).map(hydrateEntityLink);
  }

  listEntityKeys(limit = 50) {
    return this.db.prepare(`
      SELECT entity_key, COUNT(*) AS count, MAX(created_at) AS last_at
      FROM entity_links
      GROUP BY entity_key
      ORDER BY last_at DESC
      LIMIT ?
    `).all(Math.max(1, Math.min(200, limit))).map(r => ({ entityKey: r.entity_key, count: r.count, lastAt: r.last_at }));
  }

  createProposal({ id, blueprintId = null, entityKey, title, rationale, suggestedPatch = {}, now = Date.now() }) {
    const cleanKey = String(entityKey || '').trim();
    if (!VALID_ENTITY_KEY.test(cleanKey)) throw new Error('无效的 entityKey');
    if (typeof title !== 'string' || !title.trim()) throw new Error('提案标题不能为空');
    const propId = id || `prop-${crypto.randomUUID().slice(0, 12)}`;
    this.db.prepare(`
      INSERT INTO proposals (id, blueprint_id, entity_key, title, rationale, suggested_patch_json, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(propId, blueprintId, cleanKey, title.trim(), String(rationale || '').trim(), JSON.stringify(suggestedPatch ?? {}), now);
    return hydrateProposal(this.db.prepare('SELECT * FROM proposals WHERE id = ?').get(propId));
  }

  listProposals({ status = null, blueprintId = null, limit = 50 } = {}) {
    const clauses = [];
    const params = [];
    if (status) {
      if (!VALID_PROPOSAL_STATUS.has(status)) throw new Error('无效的提案状态');
      clauses.push('status = ?'); params.push(status);
    }
    if (blueprintId) { clauses.push('blueprint_id = ?'); params.push(blueprintId); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db.prepare(`SELECT * FROM proposals ${where} ORDER BY created_at DESC LIMIT ?`).all(...params, Math.max(1, Math.min(200, limit))).map(hydrateProposal);
  }

  resolveProposal(id, { status, decisionNote = null, now = Date.now() }) {
    if (!['accepted', 'rejected'].includes(status)) throw new Error('无效的提案结论');
    const result = this.db.prepare(`
      UPDATE proposals SET status = ?, decision_note = ?, resolved_at = ?
      WHERE id = ? AND status = 'pending'
    `).run(status, decisionNote, now, id);
    if (result.changes === 0) return null;
    return hydrateProposal(this.db.prepare('SELECT * FROM proposals WHERE id = ?').get(id));
  }

  stats() {
    const count = (sql, ...p) => this.db.prepare(sql).get(...p)?.c || 0;
    return {
      events: {
        pending: count("SELECT COUNT(*) AS c FROM events WHERE status = 'pending'"),
        processing: count("SELECT COUNT(*) AS c FROM events WHERE status = 'processing'"),
        unknown: count("SELECT COUNT(*) AS c FROM events WHERE status = 'unknown'"),
        failed: count("SELECT COUNT(*) AS c FROM events WHERE status = 'failed'"),
      },
      timers: {
        active: count("SELECT COUNT(*) AS c FROM timers WHERE status = 'active'"),
        paused: count("SELECT COUNT(*) AS c FROM timers WHERE status = 'paused'"),
      },
      outbox: {
        pending: count("SELECT COUNT(*) AS c FROM outbox WHERE status = 'pending'"),
        urgentPending: count("SELECT COUNT(*) AS c FROM outbox WHERE status = 'pending' AND priority = 'urgent'"),
        digestPending: count("SELECT COUNT(*) AS c FROM outbox WHERE status = 'pending' AND priority = 'digest'"),
      },
      approvals: {
        pending: count("SELECT COUNT(*) AS c FROM approvals WHERE status = 'pending'"),
      },
      blueprints: {
        active: count("SELECT COUNT(*) AS c FROM blueprints WHERE status = 'active'"),
        paused: count("SELECT COUNT(*) AS c FROM blueprints WHERE status = 'paused'"),
      },
      proposals: {
        pending: count("SELECT COUNT(*) AS c FROM proposals WHERE status = 'pending'"),
      },
    };
  }
}
