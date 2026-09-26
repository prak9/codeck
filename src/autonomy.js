import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { autonomyKey, isAutonomyObservation } from '../public/remote-autonomy.js';
import { autonomousWorkInstructions, handoffRequirements, humanOutputRequirements } from './autonomy-instructions.js';
import { receiptInstructions, readReceipt } from './autonomy-receipt.js';

const ACTIVE = new Set(['configuring', 'running', 'exiting']);
const TERMINAL = new Set(['completed', 'error', 'off']);
const needsPoll = run => ['running', 'exiting'].includes(run.status) && run.paneId
  && (run.pending || run.exchange || run.waitingForBackground);
const textField = (value, max = 4000) => typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : null;
const userText = item => typeof item.content === 'string' ? item.content
  : (item.content || []).filter(part => part.type === 'text').map(part => part.text).join('\n');

function targetIsValid(target) {
  return ['codex', 'claude', 'qodercli'].includes(target?.provider)
    && /^[\w.:-]{1,128}$/u.test(target.threadId || '') && !target.threadId.startsWith('tmux:')
    && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/u.test(target.tmuxSession || '');
}

function resultFor(thread, exchange) {
  const entries = (thread?.turns || []).flatMap(turn => (turn.items || []).map(item => ({ turn, item })));
  const anchor = entries.findLastIndex(({ item }) => item.type === 'userMessage' && !item.delivery
    && userText(item).trim() === exchange.text.trim());
  if (anchor < 0) return {};
  const tail = entries.slice(anchor + 1);
  const interaction = tail.some(({ item }) => item.type === 'userMessage' && !item.delivery
    && !isAutonomyObservation(userText(item).trim()));
  const observation = tail.findIndex(({ item }) => item.type === 'userMessage');
  const work = observation < 0 ? tail : tail.slice(0, observation);
  const latest = work.at(-1)?.turn || entries[anchor].turn;
  const conversation = tail.at(-1)?.turn || latest;
  if (interaction) return { interaction: true,
    closed: conversation.status === 'completed' && latest.status !== 'inProgress',
    live: conversation.status === 'inProgress' || latest.status === 'inProgress'
      || (conversation.status === 'interrupted' && conversation.completedAt == null) };
  if (conversation !== latest && conversation.status === 'inProgress') return { live: true };
  return { closed: latest?.status === 'completed', live: latest?.status === 'inProgress'
    || (latest?.status === 'interrupted' && latest.completedAt == null) };
}

function exchangePrompt(run, kind, text, nonce, receiptFile) {
  const context = { nonce, phase: kind, round: run.round, plan: run.plan, reason: run.reason,
    noProgress: run.noProgress, deadline: run.deadline, checkpoint: run.checkpoint, best: run.best };
  const rules = `这是 Codeck 管理的自主任务，不扩大原任务权限；不自动批准权限或擅自提交、推送、部署、删除资源。用户新指令优先。
先检查项目指令和当前环境可用的相关 Skill；适用时读取 SKILL.md 并遵循工作流，简短说明采用的 Skill。不要臆造已安装 Skill，不扩大权限、目标或预算。
对话只输出自然语言，机器状态通过独立回执提交。不要输出协议 JSON 或回执文件内容。
自主模式只是围绕目标的迭代循环，不妨碍普通对话。正常回应用户提问、补充和纠正，优先处理当前交互后继续既定目标；进度问询不重置目标或预算。不要把用户发消息本身当作退出自主模式。
${humanOutputRequirements}
上下文：${JSON.stringify(context)}`;
  const instruction = kind === 'summary'
    ? `自主执行已中断。${handoffRequirements}\n下一步仅作为建议，不续跑、不开始新工作、不停止后台任务。${receiptInstructions(receiptFile, true)}`
    : `${autonomousWorkInstructions(run)}
执行第 ${run.round}/${run.plan.maxRounds ?? '∞'} 轮。在已确认目标和边界内主动推进，不等待用户逐步派活。每轮完成一段有验证价值的工作，可连续使用工具、验证和调整，再交回结果，由 Codeck 调度下一轮。不要创建另一套自动续跑或原生 Goal。
目标、完成标准和权限边界保持不变，步骤与探索方向可根据证据自主调整；预算中的费用/token仅是参考，无法精确计量时说明。轮数和截止时间由 Codeck 控制。
${receiptInstructions(receiptFile)}
正常实验失败不等于error：先诊断并尝试替代方法，用continue交回下一步。wait仅用于后台任务；缺少必要条件且无法自行解决时用blocked，可安全恢复的错误不要报error。达标、预算结束、受阻、出错或退出时必须向用户输出交接。${handoffRequirements}
先复现或建立基线，分开记录原有失败与本次引入的问题。每轮只解决一个关键问题，说明假设、预期观察和实际结果；否定假设也可以是进展。
验证对应具体代码版本或资料标识，不得降低已确认目标或验收标准。分别保存最佳已验证成果与当前尝试，不擅自清理用户改动。
回执 baseline 记录起点和原有失败，version 记录版本，verification 记录方法与结果，current 记录未完成尝试；可靠成果填写 best-version、best-evidence、best-artifact。这些是你的证据报告，不代表 Codeck 独立验证。`;
  return `${text}\n\n<codeck-autonomy-context>\n${rules}\n${instruction}\n</codeck-autonomy-context>`;
}

export class AutonomyController extends EventEmitter {
  constructor({ readSession, readThread, suggestDefinition, prepare, send, stop, file, now = Date.now, schedule = setTimeout, cancel = clearTimeout, definitionTimeoutMs = 20_000 }) {
    super();
    Object.assign(this, { readSession, readThread, suggestDefinition, prepare, send, stop, file, now, schedule, cancel });
    this.definitionTimeoutMs = definitionTimeoutMs;
    this.receiptDirectory = file ? path.join(path.dirname(file), 'autonomy-results') : path.join(os.tmpdir(), `codeck-autonomy-results-${process.pid}`);
    this.runs = new Map(); this.polls = new Map(); this.definitionLoads = new Map(); this.timer = null; this.closed = false;
    if (file && fs.existsSync(file)) {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (![1, 2].includes(saved.version) || !Array.isArray(saved.runs)) throw new Error('自主任务存档格式无效');
      for (const old of saved.runs) {
        if (!targetIsValid(old.target) || !Number.isSafeInteger(old.round) || old.round < 0) continue;
        // Import facts, never runtime instructions. No pending send or suspended
        // exchange can be revived by startup, a browser subscription or A.
        const run = { id: old.id, target: old.target, round: old.round,
          status: TERMINAL.has(old.status) ? old.status : 'off',
          plan: old.plan || null, summary: old.summary || '', next: old.next || '',
          checkpoint: old.checkpoint || null, best: old.best || null, evidence: old.evidence || '',
          reason: TERMINAL.has(old.status) ? old.reason || '' : '服务已重启，自主执行已退出；不会重放旧任务，请按 A 重新设置。',
          startedAt: old.startedAt ?? null, stoppedAt: old.stoppedAt ?? this.now(),
          remainingMs: old.remainingMs ?? (old.deadline == null ? null : Math.max(0, old.deadline - this.now())),
          handoff: old.handoff || null, deadline: null, generation: 0, setup: false, requestId: null,
          pending: null, exchange: null, noProgress: old.noProgress || 0 };
        this.runs.set(autonomyKey(run.target), run);
      }
      this.persist();
    }
  }
  snapshot(target) {
    const run = this.runs.get(autonomyKey(target));
    if (!run) return null;
    const { exchange, pending, generation, paneId, idleSince, waitingForBackground, ...view } = run;
    return structuredClone(view);
  }
  snapshots() { return [...this.runs.values()].map(run => this.snapshot(run.target)); }
  persist() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 2, runs: [...this.runs.values()] }), { mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }
  changed(run) {
    const load = this.definitionLoads.get(autonomyKey(run.target));
    if (load && (!run.setup || run.requestId !== load.requestId)) load.abort.abort();
    if (TERMINAL.has(run.status) && run.plan) {
      run.stoppedAt ??= this.now();
      run.remainingMs ??= run.deadline == null ? null : Math.max(0, run.deadline - run.stoppedAt);
      run.handoff = { goal: run.plan.goal, summary: run.summary, reason: run.reason,
        checkpoint: run.checkpoint || null, best: run.best || null, next: run.next || '', round: run.round, remainingMs: run.remainingMs };
    }
    run.updatedAt = this.now(); this.persist(); this.emit('change', this.snapshot(run.target)); this.wake();
  }
  wake() {
    if (this.closed || this.timer || ![...this.runs.values()].some(needsPoll)) return;
    this.timer = this.schedule(() => {
      this.timer = null; this.tick().catch(() => {}); this.wake();
    }, 2000);
    this.timer?.unref?.();
  }
  async start(target) {
    if (!targetIsValid(target)) throw new Error('自主迭代需要已绑定的 Agent 会话');
    const key = autonomyKey(target), old = this.runs.get(key);
    if (old?.status === 'configuring' && old.setup && old.requestId) {
      if (old.definition?.error && !old.definition.loading) {
        old.definition.loading = true; this.loadDefinitionSuggestions(old); this.changed(old);
      }
      return this.snapshot(target);
    }
    const run = { id: crypto.randomUUID(), target: { ...target }, round: 0, status: 'configuring',
      setup: false, requestId: null, plan: null, summary: '', next: '', reason: '', noProgress: 0,
      startedAt: null, deadline: null, generation: 0, pending: null, exchange: null };
    this.runs.set(key, run); this.changed(run);
    const current = () => !this.closed && this.runs.get(key) === run && run.generation === 0 && run.status === 'configuring';
    try {
      const session = await this.readSession(target);
      if (!current()) return this.snapshot(target);
      if (!this.sameSession(run, session, false)) throw new Error('会话身份已变化，请刷新');
      run.paneId = session.agent.paneId;
      await this.stop?.({ ...target, paneId: run.paneId }, current, { stopBackground: false });
      if (!current()) return this.snapshot(target);
      const stopped = await this.readSession(target);
      if (!current()) return this.snapshot(target);
      if (!this.sameSession(run, stopped) || stopped.hasRunningProcess || stopped.agent.question) throw new Error('当前执行尚未中断，请检查终端后重试');
      run.setup = true; run.requestId = crypto.randomUUID(); run.definition = { fieldsVersion: 5, loading: true };
      this.loadDefinitionSuggestions(run); this.changed(run); return this.snapshot(target);
    } catch (error) {
      if (current()) { this.fail(target, error.message); throw error; }
      return this.snapshot(target);
    }
  }
  async loadDefinitionSuggestions(run) {
    const requestId = run.requestId, key = autonomyKey(run.target), abort = new AbortController();
    this.definitionLoads.get(key)?.abort.abort(); this.definitionLoads.set(key, { requestId, abort });
    const current = () => !this.closed && this.runs.get(key) === run && run.setup && run.requestId === requestId;
    const timeout = setTimeout(() => abort.abort(new DOMException('任务提取超时', 'TimeoutError')), this.definitionTimeoutMs);
    let onAbort;
    const cancelled = new Promise((_, reject) => {
      onAbort = () => reject(abort.signal.reason);
      abort.signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      const extraction = (async () => {
        const result = await this.readThread(run.target, undefined, {
          waitForReady: true, turnLimit: 1, definitionOnly: true, signal: abort.signal,
        });
        abort.signal.throwIfAborted();
        if (!current()) return;
        if (!this.suggestDefinition || result?.thread?.historyLoading || result?.thread?.historyError) throw new Error('任务提取不可用');
        return this.suggestDefinition({ provider: run.target.provider, thread: result.thread, signal: abort.signal });
      })();
      const definition = await Promise.race([extraction, cancelled]);
      if (!current()) return;
      Object.assign(run.definition, definition, { error: '' });
    } catch (error) {
      if (current()) run.definition.error = error.code === 'MODEL_AUTH_REQUIRED'
        ? '模型登录已失效，请重新登录；也可手动填写。'
        : error.name === 'TimeoutError' ? '提取超时，可直接手动填写。' : '暂未提取成功，可手动填写。';
    } finally {
      clearTimeout(timeout); abort.signal.removeEventListener('abort', onAbort);
      if (this.definitionLoads.get(key)?.abort === abort) this.definitionLoads.delete(key);
    }
    if (current()) { run.definition.loading = false; this.changed(run); }
  }
  async respond(target, { requestId, answers }) {
    const run = this.runs.get(autonomyKey(target));
    if (!requestId || run?.requestId !== requestId || run.status !== 'configuring' || !run.setup) throw new Error('目标已变化，请重新打开 A');
    const keys = ['goal', 'strategy', 'acceptance', 'budget', 'constraints'];
    if (!answers || Object.keys(answers).length !== keys.length || keys.some(key => !Array.isArray(answers[key])
      || answers[key].length !== 1 || typeof answers[key][0] !== 'string' || answers[key][0].length > 4000)) throw new Error('任务定义格式无效');
    const values = Object.fromEntries(keys.map(key => [key, answers[key][0].trim()]));
    if (!values.goal || !values.strategy || !values.acceptance) throw new Error('请填写目标、策略和验证方法');
    const match = /^(?:(\d+)\s*轮)?\s*(?:[/／,，]\s*)?(?:(\d+)\s*分钟)?$/u.exec(values.budget);
    if (values.budget && values.budget !== '不限' && (!match || (!match[1] && !match[2]))) throw new Error('预算请填写正整数轮数或分钟，留空表示不限');
    const maxRounds = match?.[1] ? Number(match[1]) : null, minutes = match?.[2] ? Number(match[2]) : null;
    if ([maxRounds, minutes].some(value => value !== null && (!Number.isSafeInteger(value) || value < 1))
      || (minutes !== null && !Number.isSafeInteger(minutes * 60000))) throw new Error('预算须为可表示的正整数，留空表示不限');
    run.plan = { goal: values.goal, strategy: values.strategy, acceptance: values.acceptance, constraints: values.constraints,
      preferences: values.constraints || '继承当前项目和既有权限；根据每轮证据自主调整方法。', maxRounds, minutes, advisoryBudget: '' };
    run.setup = false; run.requestId = null; run.startedAt = this.now();
    run.deadline = minutes == null ? null : this.now() + minutes * 60000;
    run.status = 'running'; run.pending = { kind: 'round', replaceTask: true, replaceDraft: true, text: '按确认的任务定义开始自主执行。' };
    this.changed(run); return this.snapshot(target);
  }
  async finish(target, reason = '用户退出') {
    const run = this.runs.get(autonomyKey(target));
    if (!run || TERMINAL.has(run.status) || run.status === 'exiting') return this.snapshot(target);
    if (!run.plan) return this.exit(target, reason);
    run.generation++; const generation = run.generation;
    run.status = 'exiting'; run.pending = null; run.exchange = null; run.waitingForBackground = false;
    run.requestId = null; run.setup = false; run.reason = reason;
    run.stoppedAt = this.now(); run.remainingMs = run.deadline == null ? null : Math.max(0, run.deadline - this.now()); run.deadline = null;
    this.changed(run);
    const current = () => !this.closed && this.runs.get(autonomyKey(target)) === run && run.generation === generation && run.status === 'exiting';
    try {
      const session = await this.readSession(target);
      if (!current()) return this.snapshot(target);
      if (!this.sameSession(run, session)) throw new Error('会话身份已变化，请刷新');
      await this.stop?.({ ...target, paneId: run.paneId }, current, { stopBackground: false });
      if (!current()) return this.snapshot(target);
      const stopped = await this.readSession(target);
      if (!current()) return this.snapshot(target);
      if (!this.sameSession(run, stopped) || stopped.hasRunningProcess || stopped.agent.question) throw new Error('当前执行尚未中断，未发送总结');
      run.pending = { kind: 'summary', text: `${reason}，退出自主模式，请总结当前进展和结果，然后结束。` };
      this.changed(run); return this.snapshot(target);
    } catch (error) {
      if (current()) { this.fail(target, `退出未完成：${error.message}`); throw error; }
      return this.snapshot(target);
    }
  }
  end(target, status, reason) {
    const run = this.runs.get(autonomyKey(target));
    if (!run) return null;
    run.generation++; run.status = status; run.reason = reason;
    run.pending = null; run.exchange = null; run.requestId = null; run.setup = false; run.waitingForBackground = false;
    this.changed(run); return this.snapshot(target);
  }
  fail(target, reason) { return this.end(target, 'error', reason); }
  exit(target, reason = '自主执行已退出；当前工作可继续收尾。') {
    const run = this.runs.get(autonomyKey(target));
    return run && ACTIVE.has(run.status) ? this.end(target, 'off', reason) : this.snapshot(target);
  }
  exitSession(sessionName, reason = '用户已接管终端，自主执行已退出。') {
    for (const run of this.runs.values()) if (run.target.tmuxSession === sessionName) this.exit(run.target, reason);
  }
  async interrupt(target, operation, { verified = false } = {}) {
    const run = this.runs.get(autonomyKey(target)), active = run && ACTIVE.has(run.status);
    if (run?.status === 'exiting') throw new Error('正在退出，请等待结果');
    if (active) this.exit(target, '用户中断，自主执行已退出。');
    try {
      const result = await operation();
      if (active && this.runs.get(autonomyKey(target)) === run && run.status === 'off') {
        run.reason = verified ? '已停止当前执行，自主模式已退出。' : '已发送停止请求，自主模式已退出。'; this.changed(run);
      }
      return result;
    } catch (error) {
      if (active && this.runs.get(autonomyKey(target)) === run && run.status === 'off') this.fail(target, `停止未确认：${error.message}`);
      throw error;
    }
  }
  sameSession(run, session, checkPane = true) {
    return session?.name === run.target.tmuxSession && session.agent?.kind === run.target.provider
      && session.agent.id === run.target.threadId && /^%\d+$/u.test(session.agent.paneId || '')
      && (!checkPane || run.paneId === session.agent.paneId);
  }
  tick() {
    if (this.closed) return Promise.resolve();
    return Promise.all([...this.runs.values()].filter(needsPoll).map(run => {
      const key = autonomyKey(run.target);
      if (this.polls.has(key)) return this.polls.get(key);
      const generation = run.generation;
      const poll = this.poll(run).catch(error => {
        if (!this.closed && this.runs.get(key) === run && run.generation === generation && ACTIVE.has(run.status)) this.fail(run.target, error.message);
      }).finally(() => { if (this.polls.get(key) === poll) this.polls.delete(key); });
      this.polls.set(key, poll); return poll;
    }));
  }
  async poll(run) {
    const exchange = run.exchange, pending = run.pending, generation = run.generation;
    const current = () => !this.closed && this.runs.get(autonomyKey(run.target)) === run && ACTIVE.has(run.status)
      && run.generation === generation && run.exchange === exchange && run.pending === pending;
    let session = await this.readSession(run.target).catch(error => { if (current()) throw error; });
    if (!current()) return;
    if (!this.sameSession(run, session)) { this.fail(run.target, '会话身份或 pane 已变化'); return; }
    if (run.status === 'running' && ((run.deadline != null && this.now() >= run.deadline)
      || (pending?.kind === 'round' && run.plan.maxRounds != null && run.round >= run.plan.maxRounds))) {
      await this.finish(run.target, '预算已耗尽'); return;
    }
    if (session.agent.question) return;
    if (pending?.replaceTask) {
      await this.stop?.({ ...run.target, paneId: run.paneId }, current, { stopBackground: true, replaceDraft: true }).catch(error => { if (current()) throw error; });
      if (!current()) return;
      session = await this.readSession(run.target).catch(error => { if (current()) throw error; });
      if (!current()) return;
      if (!this.sameSession(run, session)) { this.fail(run.target, '会话身份或 pane 已变化'); return; }
      if (session.hasRunningProcess || session.agent.hasBackgroundProcess || session.agent.question) {
        this.fail(run.target, '旧任务尚未停止，新目标未启动；请检查终端后重新设置'); return;
      }
      pending.replaceTask = false;
    }
    const needsDelivery = run.target.provider === 'qodercli' && exchange && !exchange.receivedAt;
    if (session.hasRunningProcess && pending?.kind !== 'summary' && exchange?.kind !== 'summary' && !needsDelivery) {
      run.idleSince = null; return;
    }
    if (pending) {
      if (pending.kind === 'round' && session.agent.hasBackgroundProcess) return;
      const nonce = crypto.randomUUID();
      if (pending.kind === 'round') run.round++;
      fs.mkdirSync(this.receiptDirectory, { recursive: true, mode: 0o700 });
      const receiptFile = path.join(this.receiptDirectory, `${nonce}.json`);
      const next = { kind: pending.kind, nonce, commandId: nonce, sentAt: this.now(), receiptFile,
        text: exchangePrompt(run, pending.kind, pending.text, nonce, receiptFile) };
      run.pending = null; run.exchange = next; run.idleSince = null;
      this.changed(run); // Reserve durably before a terminal side effect.
      const guard = () => !this.closed && this.runs.get(autonomyKey(run.target)) === run && ACTIVE.has(run.status)
        && run.generation === generation && run.exchange === next;
      next.deliveryBaseline = await Promise.resolve().then(() => this.prepare?.(run.target, next.text, next.commandId))
        .catch(error => { if (guard()) throw error; });
      if (!guard()) return;
      next.sentAt = this.now(); this.changed(run);
      const result = await this.send({ ...run.target, paneId: run.paneId }, next.text, guard, {
        requireIdle: pending.kind === 'round', nonInterrupting: true, replaceDraft: pending.replaceDraft === true, deferDraft: true,
        commandId: next.commandId, deliveryBaseline: next.deliveryBaseline,
      }).catch(error => { if (guard()) throw error; });
      if (!guard()) return;
      if (result?.submissionStatus === 'deferred') {
        run.exchange = null; run.pending = pending;
        if (pending.kind === 'round') run.round--;
        this.changed(run); return;
      }
      next.deliveryState = result?.submissionStatus || 'attempted'; this.changed(run);
      if (result?.submissionStatus === 'not-sent') this.fail(run.target, '输入框未就绪，自主消息未注入；请先处理草稿或弹窗');
      else if (result?.submissionStatus === 'unconfirmed') this.fail(run.target, '发送未确认，自主执行已退出；不会自动重发');
      return;
    }
    if (!exchange) {
      if (run.waitingForBackground && !session.agent.hasBackgroundProcess) {
        run.waitingForBackground = false; run.pending = { kind: 'round', text: '后台工作已结束，请核查结果并继续既定目标。' }; this.changed(run);
      }
      return;
    }
    // A display snapshot can predate receipt registration. At the delivery deadline,
    // await an actual receipt-aware read before deciding that delivery failed.
    const result = await this.readThread(run.target, exchange, {
      waitForReady: needsDelivery && this.now() - exchange.sentAt >= 30_000,
    }).catch(error => { if (current()) throw error; });
    if (!current()) return;
    const thread = result?.thread;
    const received = (thread?.turns || []).some(turn => (turn.items || []).some(item =>
      item.type === 'userMessage' && !item.delivery && userText(item).trim() === exchange.text.trim()))
      || thread?.receivedDeliveryIds?.includes(exchange.commandId)
      || thread?.deliveryConfirmations?.some(item => item.commandId === exchange.commandId);
    if (received && !exchange.receivedAt) { exchange.receivedAt = this.now(); this.changed(run); }
    if (run.target.provider === 'qodercli' && !exchange.receivedAt && this.now() - exchange.sentAt >= 30_000) {
      this.fail(run.target, '自主消息未确认送达，请检查终端；不会自动重发'); return;
    }
    if (thread?.historyLoading || thread?.historyError) {
      run.idleSince ??= this.now();
      if (this.now() - run.idleSince >= (thread.historyError ? 30_000 : 120_000)) this.fail(run.target, '对话读取未恢复，自主执行已退出');
      return;
    }
    const found = resultFor(thread, exchange);
    const record = found.closed ? readReceipt(exchange.receiptFile, exchange.nonce) : null;
    if (!record) {
      if (exchange.kind === 'round' && found.interaction && found.closed) {
        // A normal conversation may interrupt the work turn before its receipt.
        // Keep its spent budget and verified checkpoint; continue from that
        // conversation, never replay the interrupted command or claim it succeeded.
        run.exchange = null; run.idleSince = null;
        run.pending = { kind: 'round', text: '结合刚才用户的补充与已完成对话继续既定目标。先检查被打断的工作及其结果，避免重复执行；不重置预算。' };
        this.changed(run); return;
      }
      if (exchange.kind === 'round' && found.live) { run.idleSince = null; return; }
      if (exchange.kind === 'summary') {
        if (this.now() - (exchange.receivedAt ?? exchange.sentAt) >= 120_000) this.fail(run.target, '总结未完成，自主执行已退出；请检查对话');
        return;
      }
      if (session.hasRunningProcess || session.agent.hasBackgroundProcess) { run.idleSince = null; return; }
      run.idleSince ??= this.now();
      if (this.now() - run.idleSince >= 30_000) this.fail(run.target, '未收到可确认的本轮结果，自主执行已退出；请检查对话');
      return;
    }
    if (exchange.kind === 'summary') {
      if (record.status !== 'summary' || !textField(record.summary)) { this.fail(run.target, '总结格式无效，自主执行已退出'); return; }
      run.summary = record.summary; run.next = textField(record.next) || '';
      this.end(run.target, 'off', `${run.reason || '用户退出'}；已总结并退出自主模式`); return;
    }
    if (!['continue', 'complete', 'wait', 'blocked', 'error'].includes(record.status) || !textField(record.summary)
      || (record.status === 'complete' && !textField(record.evidence))
      || (['continue', 'wait'].includes(record.status) && (!textField(record.next) || typeof record.progress !== 'boolean'))) {
      this.fail(run.target, '本轮结果不完整，请检查完成证据或下一步'); return;
    }
    const checkpoint = record.checkpoint;
    if (['continue', 'wait', 'complete'].includes(record.status) && (!checkpoint
      || !['baseline', 'version', 'verification'].every(key => textField(checkpoint[key]))
      || typeof checkpoint.current !== 'string' || checkpoint.current.length > 4000)) {
      this.fail(run.target, '本轮报告缺少基线、版本与验证记录'); return;
    }
    run.exchange = null;
    run.noProgress = record.progress === false || record.summary === run.summary ? run.noProgress + 1 : 0;
    run.summary = record.summary; run.next = textField(record.next) || '';
    if (checkpoint && ['baseline', 'version', 'verification', 'current'].every(key => typeof checkpoint[key] === 'string' && checkpoint[key].length <= 4000)) run.checkpoint = structuredClone(checkpoint);
    if (record.best && ['version', 'evidence', 'artifact'].every(key => textField(record.best[key]))) run.best = structuredClone(record.best);
    if (record.status === 'complete') {
      run.evidence = record.evidence; this.end(run.target, 'completed', 'Agent 报告目标完成'); return;
    }
    if (record.status === 'blocked' || record.status === 'error') {
      this.end(run.target, record.status === 'error' ? 'error' : 'off', record.summary); return;
    }
    if (run.plan.maxRounds != null && run.round >= run.plan.maxRounds) { await this.finish(run.target, '轮数预算已耗尽'); return; }
    if (record.status === 'wait') run.waitingForBackground = true;
    else run.pending = { kind: 'round', text: `继续既定目标。上一轮：${record.summary}\n下一步：${record.next}` };
    this.changed(run);
  }
  close() {
    this.closed = true;
    for (const { abort } of this.definitionLoads.values()) abort.abort();
    this.definitionLoads.clear();
    if (this.timer) this.cancel(this.timer);
    this.timer = null;
  }
}
