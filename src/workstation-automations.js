import { workstationTargetMatches, workstationError } from './workstation-store.js';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { access, constants, lstat, readdir } from 'node:fs/promises';
import { createTelegramTask } from './telegram-task.js';
import { sessionTarget } from './telegram-sessions.js';
import { runPrecheck } from './conditional-tasks.js';
import { userMessageText } from '../public/agent-model.js';
import { sessionExecutionState } from '../public/execution-status.js';
import { checkAutomationTimer, nextCalendarDue } from './workstation-automation-schedule.js';

function problem(message, status = 400) { return workstationError(status, message); }

function targetOf(session) {
  if (!session.agent?.id || !['codex', 'claude', 'qodercli'].includes(session.agent.kind)) throw problem('请选择支持调度且具有对话身份的会话', 409);
  const { provider, threadId } = sessionTarget([session], session.name);
  if (!Number.isSafeInteger(session.createdAt)) throw problem('会话创建身份不可用', 409);
  return { session: session.name, createdAt: session.createdAt, provider, threadId };
}

function matches(a, b) {
  return a && b && a.session === b.session && a.createdAt === b.createdAt && a.provider === b.provider && a.threadId === b.threadId;
}

export function createWorkstationAutomations({ store, tracking, listSessions, send, wake, scriptDirectory,
  create = createTelegramTask, now = Date.now, precheck = runPrecheck }) {
  const manual = new Map();
  let binding = null;
  function get(id) {
    const timer = store.getTimer(id);
    if (!timer) throw problem('规则不存在', 404);
    return timer;
  }

  function describe(timer) {
    const plan = timer.payload?.workstation;
    return { reason: timer.reason, sessionName: timer.sessionName, provider: timer.provider, cwd: timer.cwd,
      dueAt: timer.dueAt, mode: plan?.script ? 'script' : plan?.taskId ? 'follow_up' : plan ? 'independent' : 'legacy',
      enabled: timer.status === 'active', check: timer.check, recurrenceMs: timer.recurrenceMs,
      calendar: timer.payload?.calendar || null, taskId: plan?.taskId || null, botId: plan?.botId || null };
  }

  async function installedScript(bot, name) {
    if (!bot || !scriptDirectory || typeof name !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) throw problem('请选择该 Bot 已安装的脚本');
    const file = path.join(scriptDirectory, bot.id, name);
    try {
      if (!(await lstat(file)).isFile()) throw problem('Bot 脚本必须是普通文件');
      await access(file, constants.X_OK);
    } catch (error) { if (['ENOENT', 'EACCES'].includes(error.code)) throw problem('Bot 脚本未安装或不可执行'); throw error; }
    return file;
  }

  async function scriptOptions() {
    if (!scriptDirectory) return [];
    const groups = await Promise.all(tracking.telegramChannels().map(async channel => {
      const bot = tracking.bot(channel.botId);
      const directory = path.join(scriptDirectory, bot.id);
      let files;
      try { files = await readdir(directory, { withFileTypes: true }); }
      catch (error) { if (error.code === 'ENOENT') return []; throw error; }
      const options = [];
      for (const file of files) {
        if (!file.isFile() || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(file.name)) continue;
        try { await access(path.join(directory, file.name), constants.X_OK); }
        catch (error) { if (['ENOENT', 'EACCES'].includes(error.code)) continue; throw error; }
        options.push({ botId: bot.id, script: file.name, channelId: channel.id, username: channel.username });
      }
      return options;
    }));
    return groups.flat();
  }

  async function draft(input, prior = null) {
    if (!input || typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 2000 || input.reason.includes('\0')) {
      throw problem('请输入不超过 2000 字的任务说明');
    }
    const bot = input.botId ? tracking.bot(input.botId) : null;
    if (input.botId && !bot) throw problem('Bot 不存在或已解除绑定', 409);
    const task = input.taskId ? tracking.task(input.taskId) : null;
    let script;
    if (input.script != null) {
      if (input.taskId) throw problem('Bot 脚本不能同时作为会话跟进');
      await installedScript(bot, input.script);
      const channel = tracking.telegramChannels().find(c => c.botId === bot.id && c.id === input.channelId);
      if (!channel) throw problem('Telegram 与 Bot 的绑定不匹配', 409);
      script = { script: input.script, channelId: channel.id };
    }
    if (input.taskId && !task) throw problem('跟进任务不存在', 404);
    const expected = task?.runs?.at(-1)?.target || task?.target || bot?.target || input.target;
    if (task && !['planned', 'active'].includes(task.status)) throw problem('任务已结束，请选择进行中的任务', 409);
    if (task && bot && task.botId !== bot.id) throw problem('所选 Bot 未绑定该任务', 409);
    if (input.target && !matches(expected, input.target)) throw problem('选择的目标与当前执行身份不一致', 409);
    const legacy = prior && !prior.payload?.workstation;
    if (legacy && (bot || task || script)) throw problem('原有提醒请选择会话或原有提醒入口');
    let sessionName = expected?.session || input.sessionName, target, cwd, scopeKey;
    if (legacy && !sessionName) {
      ({ sessionName, cwd, scopeKey } = prior);
    } else if (script && matches(expected, prior?.payload?.workstation?.target) && prior.payload.workstation.botId === bot.id) {
      target = expected;
      cwd = prior.cwd;
    } else {
      const session = (await listSessions()).find(row => row.name === sessionName);
      if (!session) throw problem('请先选择已绑定 Agent 的会话', 409);
      target = targetOf(session);
      if (expected && !matches(expected, target)) throw problem('会话身份已变化，请重新选择', 409);
      cwd = session.agent?.cwd || session.cwd;
      if (!cwd || !path.isAbsolute(cwd)) throw problem('项目目录尚未识别，请选择有明确工作目录的会话', 409);
      if (legacy) scopeKey = 'session:' + target.session;
    }
    if (target && input.sessionName && input.sessionName !== target.session) throw problem('会话和目标不符', 409);
    const check = input.check ?? null;
    if (check !== null && (!Array.isArray(check) || !check.length || check.some(v => typeof v !== 'string' || v.includes('\0')) || !path.isAbsolute(check[0]))) {
      throw problem('条件检查须为命令参数数组，首项使用可执行文件绝对路径');
    }
    if (check && (!cwd || !path.isAbsolute(cwd))) throw problem('请为条件检查选择有工作目录的会话');
    const calendar = input.calendar ?? null;
    if (calendar && (input.recurrenceMs != null || typeof calendar.weekdays !== 'boolean' && calendar.weekdays !== undefined)) {
      throw problem('请选择一个重复周期并检查工作日选项');
    }
    const recurrenceMs = calendar ? 86_400_000 : input.recurrenceMs ?? null;
    if (recurrenceMs !== null && (!Number.isSafeInteger(recurrenceMs) || recurrenceMs < 10_000)) throw problem('重复间隔至少为 10 秒');
    if (task && recurrenceMs !== null) throw problem('跟进已有任务请选择一次性时间');
    const keepDue = prior && input.dueAt == null && prior.recurrenceMs === recurrenceMs
      && (prior.payload?.calendar?.time ?? null) === (calendar?.time ?? null)
      && (prior.payload?.calendar?.timeZone ?? null) === (calendar?.timeZone ?? null)
      && Boolean(prior.payload?.calendar?.weekdays) === Boolean(calendar?.weekdays);
    let dueAt;
    try { dueAt = keepDue ? prior.dueAt : calendar ? nextCalendarDue(calendar, now()) : input.dueAt ?? (recurrenceMs && now() + recurrenceMs); }
    catch (error) { throw problem(error.message); }
    if (!Number.isSafeInteger(dueAt) || dueAt <= 0) throw problem('请提供检查时间');
    const payload = { ...prior?.payload };
    if (calendar) payload.calendar = calendar; else delete payload.calendar;
    if (!legacy) payload.workstation = { target, cwd, botId: bot?.id || null, taskId: task?.id || null, ...script };
    return { kind: recurrenceMs !== null ? 'schedule' : 'follow_up', reason: input.reason.trim(), sessionName,
      provider: target?.provider ?? prior?.provider, threadId: target?.threadId ?? prior?.threadId,
      cwd, check, recurrenceMs, dueAt, status: 'active', payload, ...(legacy && { scopeKey }), keepDue };

  }

  function runs(id) {
    get(id);
    return store.db.prepare(`
      SELECT c.due_at AS dueAt, c.checked_at AS checkedAt, c.status, c.event_id AS eventId, c.occurrence,
        origin.task_id AS taskId, origin.session_name AS sessionName,
        CASE WHEN origin.dispatch_status='confirmed' THEN 'confirmed' WHEN e.status IN ('failed','unknown') THEN e.status
          ELSE COALESCE(origin.dispatch_status,e.status) END AS dispatchStatus,
        CASE WHEN origin.dispatch_status='confirmed' THEN NULL ELSE COALESCE(c.error,e.error,origin.error) END AS error
      FROM timer_checks c LEFT JOIN events e ON e.id=c.event_id
      LEFT JOIN timer_checks origin ON origin.event_id=c.event_id AND origin.status='enqueued'
      WHERE c.timer_id=? ORDER BY c.checked_at DESC,c.rowid DESC LIMIT 100
    `).all(id);
  }

  const bindingQuery = `SELECT c.*,e.payload_json FROM timer_checks c JOIN events e ON e.id=c.event_id
    WHERE c.task_id IS NULL AND c.status='enqueued' AND c.pane_id IS NOT NULL`;
  function bind(row, session) {
    const plan = JSON.parse(row.payload_json);
    const matchesPane = session?.paneId === row.pane_id && session.createdAt >= row.launched_after - 999 && session.createdAt <= row.launched_before;
    if (!matchesPane || !session.agent?.id || session.agent.kind !== plan.provider) {
      if (row.dispatch_status === 'launched' && now() - row.launched_before >= 120_000) {
        store.db.prepare("UPDATE timer_checks SET dispatch_status='unknown',error=? WHERE timer_id=? AND occurrence=?")
          .run('已创建会话，等待核实原执行身份；请检查该会话', row.timer_id, row.occurrence);
      }
      return;
    }
    const target = targetOf(session), botId = plan.workstation.botId;
    const task = tracking.trackTask({ title: plan.reason.slice(0, 256), target, botId: botId && tracking.bot(botId) ? botId : null,
      anchor: 'automation:' + row.event_id, status: 'active' });
    tracking.recordRun(task.id, { id: row.event_id, target, status: 'launched', summary: '独立会话已启动' });
    store.db.prepare("UPDATE timer_checks SET task_id=?,dispatch_status='launched',error=NULL WHERE timer_id=? AND occurrence=?")
      .run(task.id, row.timer_id, row.occurrence);
  }
  async function reconcileBindings() {
    const pending = store.db.prepare(bindingQuery + " AND c.dispatch_status='launched'").all();
    if (!pending.length) return;
    const sessions = await listSessions();
    for (const row of pending) bind(row, sessions.find(s => s.name === row.session_name));
  }
  function observeThread(session, thread) {
    if (!session?.agent?.id || thread?.id !== session.agent.id || thread.historyLoading || thread.historyError) return;
    // Opening the original session also reconciles an unusually slow startup without launching anything.
    for (const row of store.db.prepare(bindingQuery + ' AND c.session_name=?').all(session.name)) bind(row, session);
    const pending = store.db.prepare(`SELECT c.task_id,c.event_id,e.command_id FROM timer_checks c JOIN events e ON e.id=c.event_id
      WHERE c.session_name=? AND c.status='enqueued' AND c.dispatch_status IS NOT 'confirmed' AND c.task_id IS NOT NULL AND e.command_id IS NOT NULL`).all(session.name);
    if (!pending.length) return;
    const received = new Set([...(thread.receivedDeliveryIds || []), ...(thread.deliveryConfirmations || []).filter(r => r.itemId).map(r => r.commandId)]);
    for (const turn of thread.turns || []) {
      if (turn.deliveryOnly) continue;
      for (const item of turn.items || []) {
        if (item.type !== 'userMessage' || item.delivery || String(item.id).startsWith('delivery:')) continue;
        const match = /\n调度请求标识：(automation-evt-[0-9a-f-]+)$/.exec(userMessageText(item));
        if (match) received.add(match[1]);
      }
    }
    for (const row of pending) {
      if (!received.has(row.command_id)) continue;
      const run = tracking.task(row.task_id)?.runs.find(r => r.id === row.event_id);
      if (!run || !workstationTargetMatches(session, run.target)) continue;
      tracking.recordRun(row.task_id, { ...run, status: 'confirmed', summary: '已从会话输入记录确认收到任务' });
      store.db.prepare("UPDATE timer_checks SET dispatch_status='confirmed',error=NULL WHERE event_id=? AND status='enqueued'").run(row.event_id);
    }
  }
  function reconcile() {
    binding ||= reconcileBindings().finally(() => { binding = null; });
    return binding;
  }

  async function dispatch(scopeKey, batch, helpers) {
    const [event] = batch, p = event.payload, plan = p.workstation;
    if (batch.length !== 1 || event.source !== 'timer' || scopeKey !== 'workstation:' + p.timerId || !plan
      || !store.db.prepare("SELECT 1 FROM timer_checks WHERE event_id=? AND status='enqueued'").get(event.id)) {
      throw new Error('调度事件缺少已登记的规则检查');
    }
    const bot = plan.botId ? tracking.bot(plan.botId) : null;
    if (plan.botId && (!bot || !plan.taskId && !matches(bot.target, plan.target))) throw new Error('Bot 绑定已变化，任务未派发');
    if (plan.script) {
      const executable = await installedScript(bot, plan.script);
      if (!matches(tracking.bot(bot.id)?.target, plan.target) || !tracking.telegramChannels().some(c => c.id === plan.channelId && c.botId === bot.id)) {
        throw new Error('Telegram 绑定已变化，脚本未执行');
      }
      if (get(p.timerId).status === 'paused') {
        store.db.prepare("UPDATE timer_checks SET dispatch_status='skipped' WHERE event_id=? AND status='enqueued'").run(event.id);
        return { status: 'done' };
      }
      helpers.markSubmitting('script-' + event.id);
      const result = await new Promise((resolve, reject) => {
        const child = spawn(executable, [], {
          cwd: path.dirname(executable), stdio: 'ignore', env: { HOME: process.env.HOME, PATH: process.env.PATH, LANG: process.env.LANG || 'C.UTF-8' },
        });
        child.once('error', () => reject(new Error('无法启动 Bot 脚本，请检查安装和权限')));
        child.once('close', (code) => resolve(code));
      });
      const status = result === 0 ? 'done' : result === 3 ? 'skipped' : result === null || result === 4 ? 'unknown' : 'failed';
      const error = status === 'failed' ? '脚本执行失败，退出码 ' + result : status === 'unknown' ? '脚本结果待核实，请检查投递回执' : null;
      store.db.prepare('UPDATE timer_checks SET dispatch_status=?,error=? WHERE event_id=? AND status=\'enqueued\'').run(status, error, event.id);
      return { status: status === 'skipped' ? 'done' : status, error };
    }
    const sessions = await listSessions();
    const task = plan.taskId ? tracking.task(plan.taskId) : null;
    if (plan.taskId && (!task || !['active', 'planned'].includes(task.status) || !matches(task.runs?.at(-1)?.target || task.target, plan.target))) throw new Error('任务执行目标已变化，未发送');
    const main = sessions.find(s => s.name === plan.target.session);
    if (!workstationTargetMatches(main, plan.target)) throw new Error('原会话身份已变化，任务未派发');
    const commandId = 'automation-' + event.id;
    const assignment = bot && !task ? [bot.purpose && 'Bot 职责：' + bot.purpose, bot.instructions && 'Bot 偏好：' + bot.instructions].filter(Boolean) : [];
    const text = [p.reason, ...assignment].join('\n') + (p.eventKey ? '\n检查事件：' + p.eventKey : '') + '\n调度请求标识：' + commandId;
    if (task) {
      store.db.prepare("UPDATE timer_checks SET task_id=?,session_name=? WHERE event_id=? AND status='enqueued'").run(task.id, main.name, event.id);
      if (sessionExecutionState(main) !== 'idle') return { status: 'requeue' };
      const target = sessionTarget([main], main.name);
      helpers.markSubmitting(commandId);
      tracking.recordRun(task.id, { id: event.id, target: plan.target, status: 'unknown', summary: '已开始投递，等待回执' });
      const result = await send({ target, text, commandId });
      if (tracking.task(task.id).runs.find(run => run.id === event.id)?.status === 'confirmed') return { status: 'done' };
      const status = result?.submissionStatus === 'submitted' ? 'submitted' : 'unknown';
      tracking.recordRun(task.id, { id: event.id, target: plan.target, status });
      store.db.prepare("UPDATE timer_checks SET dispatch_status=? WHERE event_id=? AND status='enqueued'").run(status, event.id);
      return status === 'unknown' ? { status, error: '投递结果未知，请检查原会话' } : { status: 'done' };
    }
    const name = 'auto-' + event.id.replace(/^evt-/, '');
    if (sessions.some(s => s.name === name)) throw new Error('独立任务会话名已存在，请核实任务历史');
    const at = now();
    store.db.prepare("UPDATE timer_checks SET session_name=?,launched_after=? WHERE event_id=? AND status='enqueued'").run(name, at, event.id);
    helpers.markSubmitting(commandId);
    const launched = await create({ name, provider: p.provider, cwd: plan.cwd, text });
    if (launched.tmuxSession !== name || !/^%\d+$/.test(launched.paneId || '') || launched.provider !== p.provider) {
      throw new Error('独立会话创建结果待核实');
    }
    store.db.prepare("UPDATE timer_checks SET pane_id=?,launched_before=?,dispatch_status='launched' WHERE event_id=? AND status='enqueued'")
      .run(launched.paneId, now(), event.id);
    return { status: 'done' };
  }

  function checkVersion(timer, expected) {
    if (expected !== (timer.payload.version ?? 0)) throw problem('规则已修改，请返回列表重新打开', 409);
  }

  function revise(timer, mutation) {
    store.db.exec('BEGIN IMMEDIATE');
    try {
      // A claimed legacy event shares its worker with other reminders. Only unclaimed legacy work is withdrawn.
      const ids = store.db.prepare(`UPDATE events SET status='done',dedupe_key=NULL,lease_owner=NULL,lease_until=NULL,processed_at=?,updated_at=?
        WHERE id IN (SELECT event_id FROM timer_checks WHERE timer_id=? AND status='enqueued') AND command_id IS NULL
        AND (status='pending' OR (scope_key=? AND status='processing')) RETURNING id`).all(now(), now(), timer.id, 'workstation:' + timer.id);
      const cancel = store.db.prepare("UPDATE timer_checks SET dispatch_status='cancelled' WHERE event_id=? AND status='enqueued'");
      for (const row of ids) cancel.run(row.id);
      const value = mutation();
      store.db.exec('COMMIT');
      return value;
    } catch (error) { store.db.exec('ROLLBACK'); throw error; }
  }

  return { list: () => store.listTimers(), runs, dispatch, reconcile, observeThread, scriptOptions,
    async preview(input) { return describe(typeof input === 'string' ? get(input) : await draft(input)); },
    async previewUpdate(id, input) { return describe(await draft(input, get(id))); },
    async update(id, input) {
      const original = get(id);
      checkVersion(original, input?.version);
      const options = await draft(input, original);
      const live = get(id);
      checkVersion(live, input.version);
      if (live.status === 'done') throw problem('这条规则已结束，可复制为新规则', 409);
      options.payload.version = input.version + 1;
      if (live.payload.workstation?.fingerprint) options.payload.workstation.fingerprint = live.payload.workstation.fingerprint;
      return revise(live, () => store.putTimer({ ...options, id, scopeKey: options.scopeKey ?? live.scopeKey,
        status: live.status, dueAt: options.keepDue ? live.dueAt : options.dueAt, now: now() }));
    },
    remove(id, version) {
      const timer = get(id);
      checkVersion(timer, version);
      return revise(timer, () => store.removeTimer(id));
    },
    async create(input) {
      const requestId = input?.requestId;
      if (requestId != null && (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(requestId))) throw problem('保存请求标识无效');
      const digest = value => createHash('sha256').update(value).digest('hex');
      const id = 'ws-' + (requestId ? digest(requestId) : randomUUID());
      const target = input?.target, calendar = input?.calendar;
      const fingerprint = requestId && digest(JSON.stringify([input.reason, input.sessionName, input.botId, input.taskId, input.dueAt, input.recurrenceMs,
        target?.session, target?.provider, target?.threadId, target?.createdAt, calendar?.time, calendar?.timeZone, calendar?.weekdays === true, input.check,
        ...(input.script != null ? [input.script, input.channelId] : [])]));
      function saved() {
        const rule = requestId && store.getTimer(id);
        if (rule && rule.payload.workstation?.fingerprint !== fingerprint) throw problem('同一保存请求标识已用于另一份规则', 409);
        return rule;
      }
      const prior = saved();
      if (prior) return prior;
      const options = await draft(input);
      store.db.exec('BEGIN IMMEDIATE');
      try {
        if (requestId) options.payload.workstation.fingerprint = fingerprint;
        const rule = saved() || store.putTimer({ ...options, id, scopeKey: 'workstation:' + id, now: now() });
        store.db.exec('COMMIT');
        return rule;
      } catch (error) { store.db.exec('ROLLBACK'); throw error; }
    },
    setEnabled(id, enabled) {
      const timer = get(id);
      if (typeof enabled !== 'boolean') throw problem('请选择暂停或启用');
      if (timer.status === 'done') throw problem('本次定时已结束，请创建新的跟进', 409);
      if ((timer.status === 'active') === enabled) return timer;
      const change = () => store.updateTimerState(id, { status: enabled ? 'active' : 'paused', now: Math.max(now(), timer.updatedAt + 1) });
      return enabled ? change() : revise(timer, change);
    },
    async runNow(id, requestId) {
      if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,96}$/.test(requestId)) throw problem('缺少本次执行的请求标识');
      const timer = get(id);
      if (timer.status !== 'active') throw problem('规则未启用', 409);
      const key = id + ':' + requestId;
      if (!manual.has(key)) manual.set(key, checkAutomationTimer(store, timer, { precheck, now, requestId }).then(result => {
        if (result.inserted) Promise.resolve(wake(timer.scopeKey)).catch(() => {});
        return result;
      }).finally(() => manual.delete(key)));
      return manual.get(key);
    } };
}
