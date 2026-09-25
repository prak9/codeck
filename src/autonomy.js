import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { autonomyKey, isProgressPrompt, isAutonomyObservation, AUTONOMY_DECISIONS } from '../public/remote-autonomy.js';

const ACTIVE = new Set(['configuring', 'confirming', 'switching', 'queued', 'running', 'waiting', 'blocked']);
const TERMINAL = new Set(['completed', 'limit']);
const CONFIRM = /^(?:开始|开始执行|确认|确认开始|确认执行|继续|继续执行|按你建议的来|按你的建议来|就按这个来)[。！!\s]*$/u;
const PAUSE = /^(?:暂停|停止|先暂停|先停止)[。！!\s]*$/u;
const needsPoll = run => ACTIVE.has(run.status) && Boolean(run.paneId)
  && Boolean(run.pending || run.exchange || run.status === 'waiting' || run.status === 'blocked');

function targetIsValid(target) {
  return ['codex', 'claude', 'qodercli'].includes(target?.provider)
    && /^[\w.:-]{1,128}$/u.test(target.threadId || '') && !target.threadId.startsWith('tmux:')
    && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/u.test(target.tmuxSession || '');
}
function textField(value, max = 4000) {
  return typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : null;
}
function validPlan(value) {
  if (!value || !textField(value.goal) || !textField(value.acceptance) || !textField(value.preferences)
    || (value.maxRounds !== null && (!Number.isSafeInteger(value.maxRounds) || value.maxRounds < 1))
    || (value.minutes != null && (!Number.isSafeInteger(value.minutes) || value.minutes < 1))
    || (value.advisoryBudget != null && typeof value.advisoryBudget !== 'string')) return null;
  return { goal: value.goal.trim(), acceptance: value.acceptance.trim(), preferences: value.preferences.trim(),
    maxRounds: value.maxRounds, minutes: value.minutes ?? null, advisoryBudget: (value.advisoryBudget || '').slice(0, 1000) };
}
function userText(item) {
  return typeof item.content === 'string' ? item.content
    : (item.content || []).filter(part => part.type === 'text').map(part => part.text).join('\n');
}

function validQuestions(value) {
  if (!Array.isArray(value) || !value.length || value.length > 3) return null;
  const ids = new Set(); const questions = [];
  for (const question of value) {
    if (!/^[\w-]{1,40}$/u.test(question?.id || '') || ids.has(question.id)
      || !textField(question.header, 40) || !textField(question.question, 1000)
      || !Array.isArray(question.options) || question.options.length < 2 || question.options.length > 4) return null;
    ids.add(question.id);
    const options = question.options.map(option => typeof option === 'string' ? { label: option } : option);
    if (options.some(option => !textField(option?.label, 200)
      || (option.description != null && (typeof option.description !== 'string' || option.description.length > 500)))
      || new Set(options.map(option => option.label)).size !== options.length) return null;
    questions.push({ id: question.id, header: question.header, question: question.question,
      options: options.map(option => ({ label: option.label, description: option.description || '' })), isOther: true });
  }
  return questions;
}

function resultFor(thread, exchange) {
  const turns = thread?.turns || [];
  const entries = turns.flatMap(turn => (turn.items || []).map(item => ({ turn, item })));
  const anchor = entries.findLastIndex(({ item }) => item.type === 'userMessage' && !item.delivery
    && userText(item).trim() === exchange.text.trim());
  if (anchor < 0) return {};
  const tail = entries.slice(anchor + 1);
  if (tail.some(({ item }) => item.type === 'userMessage' && !item.delivery
    && !isAutonomyObservation(userText(item).trim()))) return { takeover: true };
  const last = tail.findLast(({ item }) => item.type === 'agentMessage');
  const progress = tail.findIndex(({ item }) => item.type === 'userMessage');
  // A later, read-only progress answer need not repeat an already-final result.
  const beforeProgress = progress < 0 ? null : tail.slice(0, progress).findLast(({ item }) => item.type === 'agentMessage');
  for (const entry of [last, beforeProgress]) {
    if (!entry || entry.turn.status !== 'completed') continue;
    const match = /(?:^|\n)```codeck-autonomy\s*\n([^]*?)\n```\s*$/u.exec(entry.item.text || '');
    if (!match || match[1].length > 20_000) continue;
    try {
      const record = JSON.parse(match[1]);
      if (record?.nonce === exchange.nonce) return { record };
    } catch { /* Missing or malformed records time out safely. */ }
  }
  return {};
}

function exchangePrompt(run, kind, text, nonce) {
  const context = { nonce, phase: kind, round: run.round, plan: run.plan, proposed: run.proposal,
    noProgress: run.noProgress };
  const rules = `这是 Codeck 管理的自主任务，不扩大原任务权限；不自动批准权限或擅自提交、推送、部署、删除资源。用户新指令优先。
本轮只工作一次，然后交回结果，由 Codeck 决定下一轮，不要自行无限循环。不要创建另一套自动续跑或原生 Goal。
先用自然语言回答，最后单独输出一个 codeck-autonomy fenced JSON block，nonce 必须原样返回。不要在工具输出、引用或示例中输出结果块。
预算中的费用/token仅是参考，无法精确计量时必须明确说明。轮数和截止时间由 Codeck 控制。
上下文：${JSON.stringify(context)}`;
  const instruction = kind === 'config'
    ? `当前是配置，不要开始新目标的实际工作，也不要取消旧任务；只有用户确认执行新目标后才切换。主动询问用户目标、完成标准、预算（轮数/时间/费用）及偏好（质量/速度、汇报频率、必须询问的边界）。将理解的目标拆成具体子目标及各自完成标准，不用笼统概括替代。只补问缺失信息，给出建议默认值（5轮），不要反复填问卷。
信息不足时用弹窗选择题询问，基于已有对话提供具体目标/预算/偏好选项，不要求用户重写上下文。每次1–3题，每题2–4项，最推荐的放第一项；Codeck自动提供自定义回答。输出 {"nonce":"${nonce}","status":"ask","questions":[{"id":"goal","header":"目标","question":"这次推进哪项具体目标？","options":[{"label":"具体目标一","description":"完成标准"},{"label":"具体目标二","description":"完成标准"}]}]}。id用字母数字或短横线，勿调用原生提问工具替代此协议。
预算题必须提供“不设预算，直到目标完成或出错”选项。用户明确选择不设预算时，maxRounds和minutes均为null，费用/token不设置上限，不再反复追问预算；未明确选择时仍建议5轮。null是明确的无上限，不是缺失字段。只有用户明确确认后才能从有限预算改为无上限。
信息齐全时简短总结约定，Codeck会弹窗让用户确认；输出 {"nonce":"${nonce}","status":"ready","plan":{"goal":"具体拆解的目标","acceptance":"逐项完成标准","maxRounds":5,"minutes":null,"preferences":"偏好和权限边界","advisoryBudget":"参考费用/token预算或空字符串"}}。maxRounds 为整数时是总上限，包含已使用的 ${run.round} 轮；为null时不限轮数。调整方向不能偷偷增加预算。`
    : `执行第 ${run.round}/${run.plan.maxRounds ?? '∞'} 轮。只推进已确认目标，验证结果；完成就结束，不为凑轮次增加任务。无预算上限时持续推进至完成或出错，但每轮仍交回Codeck调度。
目标、完成标准和权限边界保持不变，初始方案与步骤不是固定路线。每轮根据证据复盘，自主调整探索方向、假设、方法和优先级；边界内的调整不必反复请求批准。没有结论或假设被否定不等于任务出错，不因固定的无进展轮数停下；应吸取结果换方法验证，不机械重复。无法提出有价值且可执行的下一步时，用blocked说明原因；更换目标、扩大权限或增加用户明确设置的预算须先确认。
输出 {"nonce":"${nonce}","status":"continue|complete|wait|blocked|error","summary":"本轮进展或阻塞","progress":true,"next":"下一步（continue/wait必填）","evidence":"完成证据（complete必填）"}。
选择一个真实 status；没有新进展时 progress=false。wait仅用于正在运行的后台任务，不要无休止询问进度；需要用户决定或授权时blocked，发生错误时error并说明原因，不自行反复重试。达到轮数上限时在正文汇总剩余事项。`;
  return `${text}\n\n<codeck-autonomy-context>\n${rules}\n${instruction}\n</codeck-autonomy-context>`;
}

export class AutonomyController extends EventEmitter {
  constructor({ readSession, readThread, prepare, send, stop, file, now = Date.now, schedule = setTimeout, cancel = clearTimeout }) {
    super();
    Object.assign(this, { readSession, readThread, prepare, send, stop, file, now, schedule, cancel });
    this.runs = new Map(); this.timer = null; this.polls = new Map(); this.closed = false;
    this.legacyConfigurations = new Map();
    if (file && fs.existsSync(file)) {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.runs)) throw new Error('自主任务存档格式无效');
      for (const run of saved.runs) {
        if (!targetIsValid(run.target) || !Number.isSafeInteger(run.round) || run.round < 0
          || (run.plan && !validPlan(run.plan)) || (run.proposal && !validPlan(run.proposal))) continue;
        if (run.status === 'stopping') run.suspended = null;
        else if (!TERMINAL.has(run.status) && run.status !== 'paused') run.suspended = {
          status: run.status, exchange: run.exchange, pending: run.pending, questions: run.questions,
        };
        run.exchange = null; run.pending = null; run.questions = null; run.requestId = null;
        if (!TERMINAL.has(run.status)) { run.status = 'paused'; run.reason = '服务已重启，请核对终端后继续；不会重发上一轮'; }
        this.runs.set(autonomyKey(run.target), run);
      }
      this.persist();
    }
  }

  snapshot(target) {
    const run = this.runs.get(autonomyKey(target));
    if (!run) return null;
    const { exchange, pending, suspended, generation, paneId, idleSince, ...view } = run;
    return structuredClone(view);
  }
  snapshots() { return [...this.runs.values()].map(run => this.snapshot(run.target)); }
  restoreProposal(target, thread) {
    const run = this.runs.get(autonomyKey(target));
    if (!run || run.status !== 'paused' || run.round !== 0 || run.plan || run.proposal || run.exchange || run.pending
      || thread?.id !== target.threadId || thread.historyLoading || thread.historyError) return;
    // A failed send check/restart can lose the exchange while its final reply is
    // already in the transcript. Recover only the latest unambiguous setup, never work.
    const input = (thread.turns || []).flatMap(turn => turn.items || []).findLast(item => (
      item.type === 'userMessage' && !item.delivery && !isProgressPrompt(userText(item).trim())
    ));
    if (!input) return;
    const text = userText(input);
    const block = /\n\n<codeck-autonomy-context>\n([^]*?)\n<\/codeck-autonomy-context>\s*$/u.exec(text);
    const encoded = block && /^上下文：(\{[^\n]+\})$/mu.exec(block[1]);
    if (!encoded) return;
    let context;
    try { context = JSON.parse(encoded[1]); } catch { return; }
    if (context.phase !== 'config' || context.round !== run.round || context.plan
      || !/^[\w-]{8,128}$/u.test(context.nonce || '')) return;
    const { record } = resultFor(thread, { text, nonce: context.nonce });
    const proposal = record?.status === 'ready' && validPlan(record.plan);
    const questions = record?.status === 'ask' && validQuestions(record.questions);
    if (!proposal && !questions) return;
    run.proposal = proposal || null; run.questions = questions || null;
    run.suspended = null;
    run.status = proposal ? 'confirming' : 'configuring'; run.requestId = crypto.randomUUID();
    run.reason = ''; run.confirmAfterConfig = false;
    this.changed(run);
  }
  persist() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, runs: [...this.runs.values()] }), { mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }
  changed(run) {
    run.updatedAt = this.now();
    this.persist();
    this.emit('change', this.snapshot(run.target));
    this.wake();
  }
  wake() {
    if (this.closed || this.timer || ![...this.runs.values()].some(needsPoll)) return;
    this.timer = this.schedule(() => {
      this.timer = null;
      this.tick().catch(() => {});
      this.wake();
    }, 2000);
    this.timer?.unref?.();
  }
  async start(target) {
    if (!targetIsValid(target)) throw new Error('自主迭代需要已绑定的 Agent 会话，请等待会话就绪');
    const old = this.runs.get(autonomyKey(target));
    if (old?.status === 'stopping') throw new Error('正在停止任务，请等待结果后再继续');
    if (old && ACTIVE.has(old.status)) return this.snapshot(target);
    if (old?.status === 'paused') {
      const legacy = old.suspended?.exchange;
      if (target.provider === 'qodercli' && legacy?.kind === 'config' && !legacy.commandId && !legacy.receivedAt
        && !old.proposal && !old.suspended?.questions?.length) {
        const key = autonomyKey(target);
        if (!this.legacyConfigurations.has(key)) {
          const recovery = this.restartLegacyConfiguration(old, legacy)
            .finally(() => { if (this.legacyConfigurations.get(key) === recovery) this.legacyConfigurations.delete(key); });
          this.legacyConfigurations.set(key, recovery);
        }
        return this.legacyConfigurations.get(key);
      }
      if (old.proposal) {
        old.status = 'confirming'; old.requestId = crypto.randomUUID(); this.changed(old); return this.snapshot(target);
      }
      return this.message(target, '继续');
    }
    if (this.runs.size >= 100 && !old) throw new Error('自主任务记录已达上限');
    // Reserve before awaiting identity: double clicks cannot create two runs.
    const run = { id: crypto.randomUUID(), target: { ...target }, round: 0, status: 'configuring',
      plan: null, proposal: null, reason: '', summary: '', noProgress: 0, startedAt: null, deadline: null,
      pending: { kind: 'config', text: '请先和我确认自主迭代的目标、预算及偏好，确认前不要开始执行。' }, exchange: null };
    this.runs.set(autonomyKey(target), run);
    try {
      const session = await this.readSession(target);
      if (!this.sameSession(run, session, false)) throw new Error('会话身份已变化，请刷新');
      run.paneId = session.agent.paneId;
      this.changed(run);
    } catch (error) { this.pause(target, error.message); throw error; }
    return this.snapshot(target);
  }
  async restartLegacyConfiguration(run, exchange) {
    const generation = run.generation;
    const result = await this.readThread(run.target);
    if (this.closed || run.status !== 'paused' || run.generation !== generation
      || run.suspended?.exchange !== exchange) return this.snapshot(run.target);
    const thread = result?.thread;
    if (!thread || thread.historyLoading || thread.historyError || (thread.id && thread.id !== run.target.threadId)) {
      throw new Error('旧配置历史尚未读全，请稍后再点击 A；未重新发送');
    }
    const found = resultFor(thread, exchange);
    if (found.takeover) throw new Error('旧配置后已有新的人工指令，请明确新的配置要求');
    const proposal = found.record?.status === 'ready' && validPlan(found.record.plan);
    const questions = found.record?.status === 'ask' && validQuestions(found.record.questions);
    const alreadyReceived = (thread.turns || []).some(turn => (turn.items || []).some(item =>
      item.type === 'userMessage' && !item.delivery && userText(item).trim() === exchange.text.trim()));
    if (!proposal && !questions && (alreadyReceived || found.record)) {
      throw new Error('无法确认旧配置未送达，请检查对话后明确新的配置要求；未重新发送');
    }
    // This migration is authorized only by start/A, never startup, polling or round resume.
    run.generation = (run.generation || 0) + 1;
    run.suspended = null; run.exchange = null; run.reason = ''; run.idleSince = null;
    run.confirmAfterConfig = false;
    run.proposal = proposal || null; run.questions = questions || null;
    run.requestId = proposal || questions ? crypto.randomUUID() : null;
    run.status = proposal ? 'confirming' : 'configuring';
    run.pending = proposal || questions ? null : { kind: 'config', text: exchange.text.split('\n\n<codeck-autonomy-context>')[0] };
    this.changed(run);
    return this.snapshot(run.target);
  }
  pause(target, reason = '已暂停自动续跑，当前执行可继续收尾') {
    const run = this.runs.get(autonomyKey(target));
    if (!run || TERMINAL.has(run.status) || run.status === 'stopping') return this.snapshot(target);
    if (run.status !== 'paused') run.suspended = structuredClone({
      status: run.status, pending: run.pending, exchange: run.exchange, questions: run.questions,
    });
    run.generation = (run.generation || 0) + 1;
    run.status = 'paused'; run.reason = reason; run.pending = null; run.exchange = null;
    run.questions = null; run.requestId = null;
    this.changed(run);
    return this.snapshot(target);
  }
  pauseSession(sessionName, reason = '用户已在终端接管，请确认方向后继续') {
    for (const run of this.runs.values()) if (run.target.tmuxSession === sessionName && ACTIVE.has(run.status)) this.pause(run.target, reason);
  }
  async interrupt(target, operation, { verified = false } = {}) {
    const run = this.runs.get(autonomyKey(target));
    if (run?.status === 'stopping') throw new Error('正在停止任务，请等待结果');
    if (run && !TERMINAL.has(run.status)) {
      this.pause(target);
      // Explicit interruption abandons the old exchange, unlike toggling A.
      run.suspended = null; run.status = 'stopping'; run.reason = '';
      this.changed(run);
    }
    try {
      const result = await operation();
      if (run?.status === 'stopping') {
        run.status = 'paused';
        run.reason = verified ? '已停止当前执行，自动续跑关闭' : '已发送停止请求，自动续跑关闭';
        this.changed(run);
      }
      return result;
    } catch (error) {
      if (run?.status === 'stopping') {
        run.status = 'paused'; run.reason = `停止未确认：${error.message}`; this.changed(run);
      }
      throw error;
    }
  }
  async message(target, text) {
    const run = this.runs.get(autonomyKey(target));
    if (!run || TERMINAL.has(run.status)) throw new Error('请先点击 Ⓐ 配置自主任务');
    if (run.status === 'stopping') throw new Error('正在停止任务，请等待结果后调整目标');
    if (!textField(text, 90_000)) throw new Error('消息为空或过长');
    if (PAUSE.test(text.trim())) return this.pause(target);
    if (CONFIRM.test(text.trim()) && !run.proposal && run.plan && ACTIVE.has(run.status)) return this.snapshot(target);
    if (CONFIRM.test(text.trim()) && !run.proposal && run.status === 'paused') {
      const saved = run.suspended;
      if (saved) {
        // New object identities invalidate a poll started before pause/resume.
        run.pending = structuredClone(saved.pending || null);
        run.exchange = structuredClone(saved.exchange || null);
        run.questions = structuredClone(saved.questions || null);
        run.status = saved.status === 'blocked' || saved.status === 'switching'
          ? run.pending ? 'queued' : run.exchange ? 'running' : 'waiting' : saved.status;
        if (run.plan && !run.pending && !run.exchange && !run.questions) run.status = 'waiting';
        if (run.questions) run.requestId = crypto.randomUUID();
      } else if (run.plan) {
        // Legacy paused records lost their exchange. Wait for current work to end
        // before a bounded result check; never cancel or replay the old prompt.
        run.status = 'waiting';
      }
      if (saved || run.plan) {
        run.generation = (run.generation || 0) + 1;
        run.suspended = null; run.reason = ''; run.idleSince = null;
        this.changed(run); return this.snapshot(target);
      }
    }
    // Invalidating first wins against a tick waiting on transcript or tmux I/O.
    run.generation = (run.generation || 0) + 1;
    run.exchange = null; run.pending = null; run.suspended = null; run.reason = ''; run.idleSince = null;
    run.questions = null; run.requestId = null;
    if (CONFIRM.test(text.trim()) && (run.proposal || run.plan)) {
      run.plan = run.proposal || run.plan; run.proposal = null;
      if (run.startedAt === null) run.startedAt = this.now();
      run.deadline = run.plan.minutes == null ? null : run.startedAt + run.plan.minutes * 60_000;
      run.status = 'queued'; run.pending = { kind: 'round', replaceTask: true,
        text: '旧任务已取消，不再继续旧方向。只按本次确认的目标和预算执行自主迭代。' };
    } else {
      run.status = 'configuring'; run.proposal = null;
      run.confirmAfterConfig = /(?:，|,|。|\s)(?:继续|继续执行)[。！!\s]*$/u.test(text.trim())
        || /^(?:按你建议的来|按你的建议来|就按这个来)[。！!\s]*$/u.test(text.trim());
      run.pending = { kind: 'config', text };
    }
    this.changed(run); return this.snapshot(target);
  }
  async respond(target, { requestId, answers }) {
    const run = this.runs.get(autonomyKey(target));
    if (!requestId || run?.requestId !== requestId || !['configuring', 'confirming'].includes(run.status)) {
      throw new Error('问题或目标已变化，请重新打开 Ⓐ');
    }
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw new Error('请完成选择');
    if (run.status === 'confirming' && run.proposal) {
      const decision = answers.decision?.length === 1 && answers.decision[0];
      if (!AUTONOMY_DECISIONS.includes(decision) || Object.keys(answers).length !== 1) throw new Error('请选择下一步');
      if (decision === AUTONOMY_DECISIONS[2]) return this.pause(target);
      return this.message(target, decision === AUTONOMY_DECISIONS[0] ? '开始' : '请将需要调整的目标或预算做成选择题，确认前不要执行。');
    }
    if (!run.questions?.length || Object.keys(answers).length !== run.questions.length) throw new Error('请完成所有问题');
    const text = run.questions.map(question => {
      const answer = answers[question.id];
      if (!Array.isArray(answer) || answer.length !== 1 || !textField(answer[0])) throw new Error(`请回答“${question.header}”`);
      return `${question.header}：${answer[0].trim()}`;
    }).join('\n');
    return this.message(target, text);
  }
  sameSession(run, session, checkPane = true) {
    return session?.name === run.target.tmuxSession && session.agent?.kind === run.target.provider
      && session.agent.id === run.target.threadId && /^%\d+$/u.test(session.agent.paneId || '')
      && (!checkPane || run.paneId === session.agent.paneId);
  }
  limit(run) {
    const roundLimit = run.plan?.maxRounds != null && run.round >= run.plan.maxRounds;
    if (run.plan && (roundLimit || (run.deadline != null && this.now() >= run.deadline))) {
      run.status = 'limit'; run.reason = roundLimit ? '已达轮数上限' : '已达时间上限';
      run.pending = null; run.exchange = null; this.changed(run); return true;
    }
    return false;
  }
  tick() {
    if (this.closed) return Promise.resolve();
    return Promise.all([...this.runs.values()].filter(needsPoll).map(run => {
      const key = autonomyKey(run.target);
      if (this.polls.has(key)) return this.polls.get(key);
      const poll = (async () => {
        try { await this.poll(run); }
        catch (error) {
          try { this.pause(run.target, `自主任务已暂停：${error.message}`); }
          catch { run.status = 'paused'; run.pending = null; run.exchange = null; }
        }
      })().finally(() => { if (this.polls.get(key) === poll) this.polls.delete(key); });
      this.polls.set(key, poll);
      return poll;
    }));
  }
  async poll(run) {
    const exchange = run.exchange; const pending = run.pending;
    const generation = run.generation;
    const current = () => !this.closed && ACTIVE.has(run.status) && run.generation === generation
      && run.exchange === exchange && run.pending === pending;
    let session = await this.readSession(run.target).catch(error => { if (current()) throw error; });
    if (!current()) return;
    if (!this.sameSession(run, session)) { this.pause(run.target, '会话身份或 pane 已变化'); return; }
    if (run.deadline != null && this.now() >= run.deadline) { this.limit(run); return; }
    if (session.agent.question) {
      if (run.status !== 'blocked') { run.status = 'blocked'; this.changed(run); }
      return;
    }
    if (run.status === 'blocked') {
      run.status = (pending || exchange)?.kind === 'config' ? 'configuring'
        : pending ? 'queued' : exchange ? 'running' : 'waiting';
      this.changed(run);
    }
    if (pending?.replaceTask) {
      if (this.limit(run)) return;
      run.status = 'switching'; this.changed(run);
      await this.stop?.({ ...run.target, paneId: run.paneId }, current)
        .catch(error => { if (current()) throw error; });
      if (!current()) return;
      session = await this.readSession(run.target).catch(error => { if (current()) throw error; });
      if (!current()) return;
      if (!this.sameSession(run, session)) { this.pause(run.target, '会话身份或 pane 已变化'); return; }
      if (session.hasRunningProcess || session.agent.hasBackgroundProcess || session.agent.question) {
        this.pause(run.target, '旧任务尚未停止，新目标未启动；请先停止旧任务后再次确认'); return;
      }
      pending.replaceTask = false;
      run.status = 'queued'; this.changed(run);
    }
    const needsDelivery = run.target.provider === 'qodercli' && exchange && !exchange.receivedAt;
    if (session.hasRunningProcess && pending?.kind !== 'config' && exchange?.kind !== 'config' && !needsDelivery) {
      run.idleSince = null; return;
    }
    if (pending) {
      if (pending.kind === 'round' && session.agent.hasBackgroundProcess) return;
      if (pending.kind === 'round' && this.limit(run)) return;
      const nonce = crypto.randomUUID();
      if (pending.kind === 'round') run.round += 1;
      const next = { kind: pending.kind, nonce, commandId: nonce, sentAt: this.now(), text: exchangePrompt(run, pending.kind, pending.text, nonce) };
      run.pending = null; run.exchange = next; run.status = pending.kind === 'round' ? 'running' : 'configuring';
      run.idleSince = null;
      this.changed(run); // Durable reservation precedes any terminal side effect.
      const guard = () => !this.closed && ACTIVE.has(run.status) && run.generation === generation && run.exchange === next;
      next.deliveryBaseline = await Promise.resolve().then(() => this.prepare?.(run.target, next.text, next.commandId))
        .catch(error => { if (guard()) throw error; });
      if (!guard()) return;
      next.sentAt = this.now();
      this.changed(run); // Persist the input boundary before any terminal write.
      const result = await this.send({ ...run.target, paneId: run.paneId }, next.text, guard, {
        requireIdle: pending.kind === 'round', nonInterrupting: true,
        commandId: next.commandId, deliveryBaseline: next.deliveryBaseline,
      })
        .catch(error => { if (guard()) throw error; });
      if (!guard()) return;
      if (result?.submissionStatus === 'unconfirmed') this.pause(run.target, '发送未确认，请检查终端；不会自动重发');
      return;
    }
    if (!exchange) {
      if (run.status === 'waiting' && !session.agent.hasBackgroundProcess) {
        run.status = 'queued'; run.pending = { kind: 'round', text: '后台工作已结束，请核查结果并继续既定目标。' }; this.changed(run);
      }
      return;
    }
    const result = await this.readThread(run.target, exchange).catch(error => { if (current()) throw error; });
    if (!current()) return;
    const thread = result?.thread;
    // Empty composer / submitted only acknowledges the terminal write, not CLI receipt.
    // The nonce makes an exact persisted user message unique even on legacy records.
    const received = (thread?.turns || []).some(turn => (turn.items || []).some(item =>
      item.type === 'userMessage' && !item.delivery && userText(item).trim() === exchange.text.trim()))
      || (exchange.commandId && (thread?.receivedDeliveryIds?.includes(exchange.commandId)
        || thread?.deliveryConfirmations?.some(item => item.commandId === exchange.commandId)));
    if (received && !exchange.receivedAt) { exchange.receivedAt = this.now(); this.changed(run); }
    if (run.target.provider === 'qodercli' && !exchange.receivedAt && this.now() - exchange.sentAt >= 30_000) {
      this.pause(run.target, '自主消息未确认送达，请检查终端；不会自动重发'); return;
    }
    if (result?.thread?.historyLoading || result?.thread?.historyError) {
      run.idleSince ??= this.now();
      const timeout = result.thread.historyError ? 30_000 : 120_000;
      if (this.now() - run.idleSince >= timeout) this.pause(run.target, '对话读取未恢复，请检查历史记录后继续');
      return;
    }
    const found = resultFor(result?.thread, exchange);
    if (found.takeover) { this.pause(run.target, '检测到新的人工指令，请调整目标后继续'); return; }
    if (!found.record) {
      if (exchange.kind === 'config') {
        if (this.now() - (exchange.receivedAt ?? exchange.sentAt) >= 120_000) {
          this.pause(run.target, '未收到可确认的配置回复，请检查对话；不会自动重发');
        }
        return;
      }
      if (session.hasRunningProcess) { run.idleSince = null; return; }
      if (session.agent.hasBackgroundProcess) { run.idleSince = null; return; }
      run.idleSince ??= this.now();
      if (this.now() - run.idleSince >= 30_000) this.pause(run.target, '未收到可确认的本轮结果，请检查对话后继续');
      return;
    }
    const record = found.record;
    if (exchange.kind === 'config') {
      if (record.status === 'ask') {
        const questions = validQuestions(record.questions);
        if (!questions) { this.pause(run.target, '配置选择题无效，请重新提供目标和预算'); return; }
        run.exchange = null; run.status = 'configuring'; run.questions = questions; run.requestId = exchange.nonce;
        this.changed(run); return;
      }
      const proposal = record.status === 'ready' && validPlan(record.plan);
      if (!proposal) { this.pause(run.target, '配置结果无效，请明确目标、预算和偏好'); return; }
      run.exchange = null; run.proposal = proposal; run.status = 'confirming'; run.requestId = exchange.nonce;
      this.changed(run);
      if (run.confirmAfterConfig) {
        run.confirmAfterConfig = false;
        // Direction changes may keep or reduce, never implicitly extend, spent budgets.
        if (run.plan && ((proposal.maxRounds ?? Infinity) > (run.plan.maxRounds ?? Infinity) || proposal.minutes !== run.plan.minutes)) return;
        await this.message(run.target, '继续');
      }
      return;
    }
    if (!['continue', 'complete', 'wait', 'blocked', 'error'].includes(record.status) || !textField(record.summary)
      || (record.status === 'complete' && !textField(record.evidence))
      || (['continue', 'wait'].includes(record.status) && (!textField(record.next) || typeof record.progress !== 'boolean'))) {
      this.pause(run.target, '本轮结果不完整，请检查完成证据或下一步'); return;
    }
    run.exchange = null;
    run.noProgress = record.progress === false || record.summary === run.summary ? run.noProgress + 1 : 0;
    run.summary = record.summary;
    if (record.status === 'complete') {
      run.status = 'completed'; run.evidence = record.evidence; run.reason = 'Agent 报告目标完成';
    } else if (record.status === 'blocked' || record.status === 'error') {
      this.pause(run.target, record.summary); return;
    } else if (this.limit(run)) return;
    else if (record.status === 'wait') {
      run.status = 'waiting'; run.reason = record.summary;
    } else {
      run.status = 'queued'; run.pending = { kind: 'round', text: `继续既定目标。上一轮：${record.summary}\n下一步：${record.next}` };
    }
    this.changed(run);
  }
  close() {
    this.closed = true;
    if (this.timer) this.cancel(this.timer);
    this.timer = null;
  }
}
