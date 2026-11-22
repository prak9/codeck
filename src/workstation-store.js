import { randomUUID } from 'node:crypto';

export const workstationError = (status, message) => Object.assign(new Error(message), { status });

function field(value, label, max, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim())) {
    throw workstationError(400, `${label}格式无效，最长 ${max} 字`);
  }
  return value.trim();
}

function canonicalTarget(target) {
  if (!Number.isSafeInteger(target?.createdAt) || target.createdAt <= 0) throw workstationError(400, '缺少会话创建身份');
  return { session: field(target.session, '会话', 256), createdAt: target.createdAt,
    provider: field(target.provider, 'Agent', 80), threadId: field(target.threadId, '对话', 1024) };
}

export function workstationTargetMatches(session, target) {
  return Boolean(session && target?.threadId && session.name === target.session && session.createdAt === target.createdAt
    && session.agent?.kind === target.provider && session.agent?.id === target.threadId);
}

function taskRecord(row, runs) {
  return { id: row.id, title: row.title, target: JSON.parse(row.target), anchor: row.anchor, botId: row.bot_id,
    status: row.status, progress: row.progress, outputs: JSON.parse(row.outputs), updates: JSON.parse(row.updates), runs,
    createdAt: row.created_at, updatedAt: row.updated_at };
}

function botRecord(row) {
  return row && { id: row.id, name: row.name, purpose: row.purpose, instructions: row.instructions,
    target: JSON.parse(row.target), createdAt: row.created_at };
}

function runRecord(row) {
  return { id: row.id, status: row.status, target: JSON.parse(row.target), summary: row.summary, createdAt: row.created_at, updatedAt: row.updated_at };
}

const taskStatuses = new Set(['planned', 'active', 'delivered', 'stopped']);

export class WorkstationStore {
  constructor(db) {
    this.db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS workstation_bots (
        id TEXT PRIMARY KEY, target TEXT NOT NULL UNIQUE, name TEXT NOT NULL, purpose TEXT NOT NULL,
        instructions TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workstation_tasks (
        id TEXT PRIMARY KEY, target TEXT NOT NULL, anchor TEXT NOT NULL, title TEXT NOT NULL,
        bot_id TEXT REFERENCES workstation_bots(id) ON DELETE SET NULL, status TEXT NOT NULL,
        progress TEXT NOT NULL DEFAULT '', outputs TEXT NOT NULL DEFAULT '[]', updates TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(target, anchor)
      );
      CREATE TABLE IF NOT EXISTS workstation_runs (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES workstation_tasks(id), target TEXT NOT NULL,
        status TEXT NOT NULL, summary TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS workstation_runs_task ON workstation_runs(task_id);
      CREATE TABLE IF NOT EXISTS workstation_telegram (
        channel_id TEXT PRIMARY KEY, username TEXT NOT NULL, bot_id TEXT UNIQUE REFERENCES workstation_bots(id) ON DELETE SET NULL,
        revision TEXT NOT NULL, changed_at INTEGER NOT NULL
      );
    `);
    db.exec('BEGIN IMMEDIATE');
    try {
      if (!db.prepare("SELECT 1 FROM pragma_table_info('workstation_bots') WHERE name = 'instructions'").get()) {
        db.exec("ALTER TABLE workstation_bots ADD COLUMN instructions TEXT NOT NULL DEFAULT ''");
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  task(id) {
    const row = this.db.prepare('SELECT * FROM workstation_tasks WHERE id = ?').get(id);
    if (!row) return null;
    const runs = this.db.prepare('SELECT * FROM workstation_runs WHERE task_id = ? ORDER BY rowid').all(id);
    return taskRecord(row, runs.map(runRecord));
  }

  bot(id) {
    return botRecord(this.db.prepare('SELECT * FROM workstation_bots WHERE id = ?').get(id)) || null;
  }

  listBots() {
    return this.db.prepare('SELECT * FROM workstation_bots ORDER BY name, rowid').all().map(botRecord);
  }

  telegramBinding(channelId) {
    const row = this.db.prepare(`SELECT t.revision,t.changed_at,t.bot_id,b.name,b.target FROM workstation_telegram t
      LEFT JOIN workstation_bots b ON b.id=t.bot_id WHERE t.channel_id=?`).get(String(channelId));
    return row ? { key: (row.bot_id || 'detached') + ':' + row.revision, since: row.changed_at, name: row.name,
      target: row.target ? JSON.parse(row.target) : null } : null;
  }

  telegramChannels() {
    return this.db.prepare('SELECT channel_id AS id,username,bot_id AS botId FROM workstation_telegram WHERE bot_id IS NOT NULL').all();
  }

  bindTelegram(botId, { id, username }) {
    if (!this.bot(botId)) throw workstationError(404, '工作台 Bot 不存在');
    const saved = this.db.prepare(`INSERT INTO workstation_telegram(channel_id,username,bot_id,revision,changed_at)
      SELECT ?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM workstation_telegram WHERE bot_id=? AND channel_id<>?)
      ON CONFLICT(channel_id) DO UPDATE SET username=excluded.username,bot_id=excluded.bot_id,
        revision=CASE WHEN workstation_telegram.bot_id IS NULL THEN excluded.revision ELSE workstation_telegram.revision END,
        changed_at=CASE WHEN workstation_telegram.bot_id IS NULL THEN excluded.changed_at ELSE workstation_telegram.changed_at END
      WHERE workstation_telegram.bot_id IS NULL OR workstation_telegram.bot_id=excluded.bot_id RETURNING channel_id`)
      .get(id, username, botId, randomUUID(), Date.now(), botId, id);
    if (!saved) throw workstationError(409, '机器人已有绑定，请先在原 Bot 解除 Telegram 绑定');
  }

  unbindTelegram(botId, channelId, revision) {
    if (!this.db.prepare("UPDATE workstation_telegram SET bot_id=NULL WHERE bot_id=? AND channel_id=? AND (bot_id || ':' || revision)=?")
      .run(botId, channelId, revision).changes) throw workstationError(409, '绑定已变化，请刷新后重试');
  }

  overview() {
    const byTask = new Map();
    for (const run of this.db.prepare('SELECT * FROM workstation_runs ORDER BY rowid').all()) {
      if (!byTask.has(run.task_id)) byTask.set(run.task_id, []);
      byTask.get(run.task_id).push(runRecord(run));
    }
    return {
      tasks: this.db.prepare('SELECT * FROM workstation_tasks ORDER BY updated_at DESC, rowid DESC').all()
        .map(row => taskRecord(row, byTask.get(row.id) || [])),
      bots: this.listBots(),
    };
  }

  createBot({ name, purpose = '', instructions = '', target }) {
    name = field(name, '名称', 256);
    purpose = field(purpose, '职责', 4000, true);
    instructions = field(instructions, '专属偏好', 4000, true);
    const stored = JSON.stringify(canonicalTarget(target));
    this.db.prepare(`INSERT INTO workstation_bots(id,target,name,purpose,instructions,created_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(target) DO NOTHING`).run(randomUUID(), stored, name, purpose, instructions, Date.now());
    const row = this.db.prepare('SELECT * FROM workstation_bots WHERE target = ?').get(stored);
    if (row.name !== name || row.purpose !== purpose || row.instructions !== instructions) throw workstationError(409, '此主对话已绑定其他 Bot');
    return botRecord(row);
  }

  updateBot(id, { purpose, instructions }) {
    if (purpose === undefined && instructions === undefined) throw workstationError(400, '请填写职责或专属偏好');
    const edited = this.db.prepare(`UPDATE workstation_bots SET purpose=coalesce(?,purpose),
      instructions=coalesce(?,instructions) WHERE id=? RETURNING *`).get(
      purpose === undefined ? null : field(purpose, '职责', 4000, true),
      instructions === undefined ? null : field(instructions, '专属偏好', 4000, true), id);
    if (!edited) throw workstationError(404, 'Bot 不存在');
    return botRecord(edited);
  }

  removeBot(id) {
    if (!this.db.prepare('DELETE FROM workstation_bots WHERE id = ?').run(id).changes) throw workstationError(404, 'Bot 不存在');
  }

  trackTask({ title, target, anchor, botId, status = 'planned' }) {
    title = field(title, '标题', 256);
    anchor = field(anchor, '来源', 2048);
    if (!['planned', 'active'].includes(status)) throw workstationError(400, '初始任务状态无效');
    const stored = JSON.stringify(canonicalTarget(target));
    if (botId != null && (typeof botId !== 'string' || !this.bot(botId))) throw workstationError(404, 'Bot 不存在');
    const now = Date.now();
    this.db.prepare(`INSERT INTO workstation_tasks(id,target,anchor,title,bot_id,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(target,anchor) DO NOTHING`).run(randomUUID(), stored, anchor, title, botId ?? null, status, now, now);
    return this.task(this.db.prepare('SELECT id FROM workstation_tasks WHERE target = ? AND anchor = ?').get(stored, anchor).id);
  }

  updateTask(id, { status, progress, output }) {
    if (status !== undefined && !taskStatuses.has(status)) throw workstationError(400, '任务状态无效');
    if (progress !== undefined) progress = field(progress, '进展', 4000, true);
    // Only these synchronous changes share the database write transaction. File IO finishes before entry.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.task(id);
      if (!current) throw workstationError(404, '任务不存在');
      const now = Date.now();
      const newOutput = output && !current.outputs.some(pin => pin.identity === output.identity && pin.itemId === output.itemId && pin.versionId === output.versionId);
      if (newOutput) current.outputs.push(output);
      const nextStatus = status ?? current.status, nextProgress = progress ?? current.progress;
      const changed = nextStatus !== current.status || nextProgress !== current.progress;
      if (changed) current.updates.push({ status: nextStatus, progress: nextProgress, at: now });
      if (changed || newOutput) {
        this.db.prepare(`UPDATE workstation_tasks SET status=?, progress=?, outputs=?, updates=?, updated_at=? WHERE id=?`)
          .run(nextStatus, nextProgress, JSON.stringify(current.outputs), JSON.stringify(current.updates), now, id);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.task(id);
  }

  recordRun(taskId, { id, target, status, summary = '' }) {
    id = field(id, '执行记录', 2048);
    status = field(status, '执行状态', 80);
    summary = field(summary, '执行摘要', 4000, true);
    const stored = JSON.stringify(canonicalTarget(target)), now = Date.now();
    if (!this.db.prepare('SELECT 1 FROM workstation_tasks WHERE id=?').get(taskId)) throw workstationError(404, '任务不存在');
    const result = this.db.prepare(`INSERT INTO workstation_runs(id,task_id,target,status,summary,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status, summary=excluded.summary, updated_at=excluded.updated_at
      WHERE workstation_runs.task_id=excluded.task_id AND workstation_runs.target=excluded.target
      RETURNING *`).get(id, taskId, stored, status, summary, now, now);
    if (!result) throw workstationError(409, '该次执行已绑定另一任务或会话');
    return runRecord(result);
  }
}
