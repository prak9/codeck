import fs from 'node:fs/promises';
import path from 'node:path';
import { sessionExecutionState, executionLabel, turnStatusLabel } from '../public/execution-status.js';
import { userMessageText, threadExecutionState } from '../public/agent-model.js';

const HELP = '可以直接说：看看 research 的进展、让 report 继续，或新开任务研究 XX。\n也支持 /sessions、/use 会话名、/status、/stop。回复通知会回到原会话。';
const key = t => JSON.stringify([t.provider, t.threadId, t.tmuxSession]);
const terminal = status => ['completed', 'failed', 'errored', 'interrupted'].includes(status);
export function sessionTarget(sessions, name) {
  const s = sessions.find(s => s.name === name);
  if (!s?.agent?.id || !['codex', 'claude', 'qodercli'].includes(s.agent.kind)) throw new Error('会话不存在或尚未进入 Agent；不会向 Shell 发送。');
  return { provider: s.agent.kind, threadId: s.agent.id, tmuxSession: s.name };
}
export function splitTelegramText(text) {
  let rest = String(text || '本轮无文本输出，请查看网页。').toWellFormed();
  const parts = [];
  while (rest.length) {
    let n = Math.min(4000, rest.length);
    if (n < rest.length && /[\uD800-\uDBFF]/.test(rest[n - 1]) && /[\uDC00-\uDFFF]/.test(rest[n])) n--;
    parts.push(rest.slice(0, n)); rest = rest.slice(n);
  }
  return parts;
}
function output(turn) {
  const messages = (turn?.items || []).filter(i => i.type === 'agentMessage' && typeof i.text === 'string');
  return (messages.some(i => i.phase === 'final_answer') ? messages.filter(i => i.phase === 'final_answer') : messages).map(i => i.text).join('\n\n');
}

// A serialized durable inbox/outbox, not an Agent or a task scheduler.
export class TelegramSessions {
  constructor({ directory, ownerId, botId, api, sessions, understand, now = Date.now, webUrl, signal }) {
    Object.assign(this, { directory, ownerId, botId, api, sessions, understand, now, webUrl, signal });
    this.file = path.join(directory, 'sessions.json');
    this.state = { ownerId, botId, offset: 0, inbox: [], outbox: [], bindings: {}, selected: null, watches: {} };
    this.pending = null;
    this.nextScan = 0;
  }
  async load() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.directory, 0o700);
    try {
      const saved = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (saved.ownerId !== this.ownerId || saved.botId !== this.botId || !Number.isSafeInteger(saved.offset)
        || !Array.isArray(saved.inbox) || !Array.isArray(saved.outbox) || !saved.bindings || !saved.watches) throw new Error('Telegram 存档身份或格式不一致');
      this.state = saved;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // Retain the old control archive, and carry only the confirmed offset.
      try {
        const old = JSON.parse(await fs.readFile(path.join(this.directory, 'state.json'), 'utf8'));
        if (old.ownerId !== this.ownerId || old.botId !== this.botId || !Number.isSafeInteger(old.offset)) throw new Error('旧存档身份不一致');
        this.state.offset = old.offset;
      } catch (legacyError) { if (legacyError.code !== 'ENOENT') throw legacyError; }
      await this.change(() => {});
    }
  }
  async change(update) {
    const state = structuredClone(this.state); update(state);
    await fs.writeFile(`${this.file}.tmp`, JSON.stringify(state), { mode: 0o600 });
    await fs.rename(`${this.file}.tmp`, this.file); this.state = state;
  }
  queue(state, id, text, target = null, replyTo = null, interaction = null) {
    if (state.outbox.some(m => m.id === id)) return;
    state.outbox.push({ id, chunks: splitTelegramText(text), index: 0, target, replyTo, interaction });
  }
  async notice(entry, text, target = null) {
    await this.change(s => { s.inbox.find(e => e.id === entry.id).status = 'done'; this.queue(s, `input:${entry.id}`, text, target, entry.messageId); });
  }
  tick() {
    if (!this.pending) this.pending = this.run().finally(() => { this.pending = null; });
    return this.pending;
  }
  async run() {
    const updates = await this.api('getUpdates', { offset: this.state.offset, limit: 100, timeout: this.state.outbox.length ? 2 : 10, allowed_updates: ['message'] });
    if (!Array.isArray(updates)) throw new Error('Invalid updates');
    if (updates.length) await this.change(s => {
      for (const u of [...updates].sort((a, b) => a.update_id - b.update_id)) {
        if (!Number.isSafeInteger(u.update_id) || u.update_id < s.offset) continue;
        const m = u.message;
        if (m?.from?.id === this.ownerId && !m.from.is_bot && m.chat?.type === 'private' && m.chat.id === this.ownerId && Number.isSafeInteger(m.message_id)) {
          s.inbox.push({ id: u.update_id, messageId: m.message_id, text: m.text?.trim() || '', replyTo: m.reply_to_message?.message_id, status: 'received' });
        }
        s.offset = u.update_id + 1;
      }
    });
    // A crash after journaling a mutation must never replay it.
    for (const e of this.state.inbox.filter(e => e.status === 'dispatching')) await this.notice(e, `操作结果未确认，请检查 ${e.action?.name || e.target?.tmuxSession || '原会话'}；不会自动重发或重复创建。`, e.target);
    for (const e of this.state.inbox.filter(e => e.status === 'received')) { this.signal?.throwIfAborted(); await this.dispatch(e); }
    if (this.now() >= this.nextScan) { await this.scan(); this.nextScan = this.now() + 10_000; }
    await this.flush();
    if (this.state.inbox.length > 200) await this.change(s => { s.inbox = s.inbox.filter((e, i) => e.status !== 'done' || i >= s.inbox.length - 200); });
  }
  async resolve(entry) {
    const binding = entry.replyTo != null ? this.state.bindings[entry.replyTo] : null;
    if (entry.replyTo != null && !binding?.target) throw new Error('这条回复无法关联原会话，请用 /use 重新选择后发送新消息。');
    const target = binding?.target || this.state.selected;
    if (!target) throw new Error('请先用 /sessions 查看，再用 /use 会话名 选择。');
    const live = await this.liveTarget(target);
    return { target: live, interaction: binding?.interaction };
  }
  async liveTarget(target) {
    const sessions = await this.sessions.list();
    const live = sessionTarget(sessions, target.tmuxSession);
    const session = sessions.find(s => s.name === target.tmuxSession);
    if (target.threadId ? key(live) !== key(target) : !target.paneId || session.paneId !== target.paneId || live.provider !== target.provider) {
      throw new Error('会话身份已变化，请重新选择；没有发送。');
    }
    return live;
  }
  async watch(target) {
    let snapshot;
    try { snapshot = await this.sessions.read(target); } catch { /* Baseline when history becomes available. */ }
    const ready = snapshot?.thread && !snapshot.thread.historyLoading && !snapshot.thread.historyError;
    await this.change(s => { s.watches[key(target)] = { target, seen: ready ? (snapshot.thread.turns || []).filter(t => terminal(t.status)).map(t => t.id) : null, interactions: [] }; });
  }
  async route(entry) {
    const binding = entry.replyTo != null ? this.state.bindings[entry.replyTo] : null;
    if (entry.replyTo != null && !binding) return this.notice(entry, '无法关联这条回复，请发新消息说明会话或任务。');
    let selected = binding?.target || this.state.selected;
    if (selected) {
      try { selected = await this.liveTarget(selected); }
      catch (error) { if (binding) throw error; selected = null; }
    }
    const context = { text: entry.text, sessions: await this.sessions.list(), selected, replyTarget: binding?.target,
      clarification: this.state.clarification };
    const plan = await this.understand(context, { signal: this.signal });
    if (plan.clarification) {
      await this.change(s => { s.clarification = { original: s.clarification?.original || entry.text, question: plan.clarification,
        answers: [...(s.clarification?.answers || []), ...(s.clarification ? [entry.text] : [])] }; });
      return this.notice(entry, plan.clarification);
    }
    const children = plan.actions.map((action, i) => ({ id: `${entry.id}-${i}`, messageId: entry.messageId,
      text: action.text || '', action: action.kind === 'create' ? { ...action, name: `tg-${entry.id}-${i}` } : action, status: 'received' }));
    await this.change(s => { s.clarification = null; s.inbox.find(e => e.id === entry.id).status = 'done'; s.inbox.push(...children); });
    for (const child of children) { this.signal?.throwIfAborted(); await this.dispatch(child); }
  }
  async dispatchAction(entry) {
    const a = entry.action;
    if (a.kind === 'list') return this.dispatch({ ...entry, action: null, text: '/sessions' });
    if (a.kind === 'create') {
      await this.change(s => { s.inbox.find(e => e.id === entry.id).status = 'dispatching'; });
      this.signal?.throwIfAborted();
      try {
        const target = await this.sessions.create(a);
        await this.change(s => {
          s.inbox.find(e => e.id === entry.id).target = target; s.selected = target;
          s.watches[key(target)] = { target, seen: [], interactions: [], createdAt: this.now() };
        });
        return await this.notice(entry, `已创建 ${target.tmuxSession}，正在启动 ${target.provider} 执行：\n${a.text}`, target);
      } catch (error) { return this.notice(entry, error.notStarted ? `未创建 ${a.name}：${error.message}`
        : `新会话 ${a.name} 的启动结果未确认，请检查会话列表；不会重复创建。`); }
    }
    const target = await this.liveTarget(a.target);
    if (a.kind === 'select') return this.dispatch({ ...entry, action: null, text: `/use ${target.tmuxSession}` });
    if (a.kind === 'watch' || a.kind === 'unwatch') return this.dispatch({ ...entry, action: null, text: `/${a.kind} ${target.tmuxSession}` });
    if (!this.state.watches[key(target)]) await this.watch(target);
    await this.change(s => { s.selected = target; });
    // Bind this step explicitly rather than relying on later changes to selection.
    return this.dispatch({ ...entry, action: null, direct: true, directTarget: target,
      text: a.kind === 'status' ? '/status' : a.kind === 'stop' ? '/stop' : a.text });
  }
  async dispatch(entry) {
    let text = entry.text;
    try {
      if (entry.action) return await this.dispatchAction(entry);
      if (this.state.clarification && /^(取消|算了|cancel)$/i.test(text)) {
        await this.change(s => { s.clarification = null; }); return this.notice(entry, '已取消这次规划，没有执行任务。');
      }
      const interaction = entry.replyTo != null ? this.state.bindings[entry.replyTo]?.interaction : null;
      if (interaction && !text.startsWith('/')) {
        if (interaction.kind === 'approval') {
          if (/^(同意|确认|可以|批准|ok|yes)$/i.test(text)) text = '/approve';
          else if (/^(拒绝|不同意|不可以|no)$/i.test(text)) text = '/deny';
        } else text = `/answer ${text}`;
      }
      if (this.understand && text && !text.startsWith('/') && !interaction && !entry.direct) return await this.route(entry);
      if (!text || ['/start', '/help'].includes(text)) return await this.notice(entry, HELP);
      if (text === '/sessions') {
        const list = (await this.sessions.list()).filter(s => ['codex', 'claude', 'qodercli'].includes(s.agent?.kind));
        return await this.notice(entry, list.map(s => `${s.name} · ${executionLabel(sessionExecutionState(s))}`).join('\n') || '暂无 Agent 会话。');
      }
      const command = text.match(/^\/(use|watch|unwatch)\s+(.+)$/);
      if (command) {
        const [, verb, name] = command;
        if (verb === 'unwatch') {
          await this.change(s => { for (const [k, w] of Object.entries(s.watches)) if (w.target.tmuxSession === name) delete s.watches[k]; });
          return await this.notice(entry, `已取消 ${name} 的通知。`);
        }
        const target = sessionTarget(await this.sessions.list(), name);
        if (!this.state.watches[key(target)]) await this.watch(target);
        if (verb === 'use') await this.change(s => { s.selected = target; });
        return await this.notice(entry, `${verb === 'use' ? '已选择并订阅' : '已订阅'} ${name}。`, target);
      }
      const resolved = entry.directTarget ? { target: await this.liveTarget(entry.directTarget) } : await this.resolve(entry);
      const { target, interaction: nativeInteraction } = resolved;
      if (text === '/status') {
        const result = await this.sessions.read(target);
        if (result.thread?.historyLoading || result.thread?.historyError) return await this.notice(entry, '历史尚未就绪，请稍后再查。', target);
        const turn = result.thread?.turns?.at(-1);
        return await this.notice(entry, `[${target.tmuxSession}] ${executionLabel(threadExecutionState(result.thread))} · ${turnStatusLabel(turn?.status)}\n${output(turn) || '暂无文本输出。'}`, target);
      }
      let kind = 'send', args = { text: `来自 Telegram（消息 ${entry.id}）\n${text}` };
      if (text === '/stop') { kind = 'stop'; args = {}; }
      else if (/^\/(approve|deny)$/.test(text)) {
        if (!nativeInteraction || nativeInteraction.kind !== 'approval') throw new Error('请直接回复一条待审批通知，使用 /approve 或 /deny。');
        kind = 'approve'; args = { ...nativeInteraction, decision: text === '/approve' ? 'accept' : 'decline' };
      } else if (text.startsWith('/answer ')) {
        if (!nativeInteraction || nativeInteraction.kind !== 'question') throw new Error('请直接回复一条待回答通知，使用 /answer 选项或答案。');
        kind = 'answer'; args = { ...nativeInteraction, answer: text.slice(8).trim() };
      } else if (text.startsWith('/')) throw new Error(HELP);
      else if (nativeInteraction) throw new Error('这是原生交互通知，请按通知中的 /answer、/approve 或 /deny 指令回复。');
      await this.change(s => Object.assign(s.inbox.find(e => e.id === entry.id), { status: 'dispatching', target, kind, args }));
      this.signal?.throwIfAborted();
      try {
        const result = await this.sessions.act(kind, target, { ...args, commandId: `telegram-${this.botId}-${entry.id}` });
        const status = result?.submissionStatus;
        await this.notice(entry, kind === 'send'
          ? `[${target.tmuxSession}] ${status === 'submitted' ? '已尝试发送，等待会话回执；不要重复发送。' : '发送未确认，请检查终端；不会自动重发。'}`
          : `[${target.tmuxSession}] 操作已处理。`, target);
        if (kind === 'send') await this.change(s => { s.inbox.find(e => e.id === entry.id).delivery = { text: args.text, at: this.now(), confirmed: false }; });
        this.nextScan = 0;
      } catch { await this.notice(entry, `[${target.tmuxSession}] 操作结果未确认，请检查原会话；不会自动重发。`, target); }
    } catch (error) {
      // Read/validation failures cannot have injected a mutation.
      if (this.state.inbox.find(e => e.id === entry.id)?.status === 'dispatching') throw error;
      await this.notice(entry, error.message || '操作失败。');
    }
  }
  async scan() {
    for (const watch of Object.values(this.state.watches)) {
      let target = watch.target;
      let snapshot;
      try {
        const live = await this.liveTarget(target);
        if (!target.threadId) {
          const old = target;
          await this.change(s => {
            s.watches[key(live)] = { ...s.watches[key(old)], target: live }; delete s.watches[key(old)];
            if (s.selected && key(s.selected) === key(old)) s.selected = live;
            for (const b of Object.values(s.bindings)) if (b.target && key(b.target) === key(old)) b.target = live;
          });
          target = live;
        }
        snapshot = await this.sessions.read(target);
      } catch {
        if (!target.threadId && !watch.readinessWarned && this.now() - watch.createdAt >= 60_000) {
          await this.change(s => {
            const w = s.watches[key(target)]; if (!w) return;
            w.readinessWarned = true;
            this.queue(s, `${key(target)}:startup`, `[${target.tmuxSession}] Agent 尚未就绪，请检查终端；会话已保留，不会重复启动任务。`, target);
          });
        }
        continue;
      }
      const thread = snapshot?.thread;
      if (!thread || thread.historyLoading || thread.historyError) continue;
      await this.change(s => {
        const w = s.watches[key(target)]; if (!w) return;
        if (w.seen === null) w.seen = (thread.turns || []).filter(t => terminal(t.status)).map(t => t.id);
        for (const turn of thread.turns || []) {
          if (!terminal(turn.status) || w.seen.includes(turn.id)) continue;
          const label = turnStatusLabel(turn.status);
          this.queue(s, `${key(target)}:${turn.id}:end`, `[${target.tmuxSession}] ${label}\n${output(turn) || '暂无文本输出，请查看终端。'}`, target);
          w.seen.push(turn.id);
        }
        w.seen = w.seen.slice(-200);
        for (const interaction of snapshot.interactions || []) {
          const id = `${interaction.kind}:${interaction.id}`;
          if (w.interactions.includes(id)) continue;
          this.queue(s, `${key(target)}:${id}`, `[${target.tmuxSession}] 待确认\n${interaction.text}`, target, null, interaction);
          w.interactions.push(id);
        }
        w.interactions = w.interactions.slice(-100);
        for (const e of s.inbox) {
          if (!e.delivery || e.delivery.confirmed || !e.target || key(e.target) !== key(target)) continue;
          const received = thread.turns?.some(t => t.items?.some(i => i.type === 'userMessage' && userMessageText(i) === e.delivery.text && !i.delivery));
          if (received) { e.delivery.confirmed = true; this.queue(s, `receipt:${e.id}`, `[${target.tmuxSession}] 已确认收到消息。`, target, e.messageId); }
        }
      });
    }
  }
  async flush() {
    while (this.state.outbox.length) {
      const m = this.state.outbox[0];
      const href = this.webUrl && m.target ? new URL(`/remote.html?session=${encodeURIComponent(m.target.tmuxSession)}`, this.webUrl).href : this.webUrl;
      const result = await this.api('sendMessage', { chat_id: this.ownerId, text: m.chunks[m.index],
        ...(m.replyTo ? { reply_parameters: { message_id: m.replyTo, allow_sending_without_reply: true } } : {}),
        ...(m.index ? { disable_notification: true } : {}),
        ...(href ? { reply_markup: { inline_keyboard: [[{ text: '打开会话', url: href }]] } } : {}),
      });
      await this.change(s => {
        if (Number.isSafeInteger(result.message_id)) s.bindings[result.message_id] = { target: m.target, interaction: m.interaction };
        const ids = Object.keys(s.bindings); for (const id of ids.slice(0, Math.max(0, ids.length - 1000))) delete s.bindings[id];
        if (++s.outbox[0].index === s.outbox[0].chunks.length) s.outbox.shift();
      });
    }
  }
}
