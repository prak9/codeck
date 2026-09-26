import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { autonomyKey, AUTONOMY_PLANNING_PROMPT } from '../public/remote-autonomy.js';
import { readReceipt, observedStatusInstructions } from './autonomy-receipt.js';

const ACTIVE = new Set(['planning', 'running', 'exiting']);
const TERMINAL = new Set(['completed', 'error', 'off', 'ended']);
const needsPoll = run => ['planning', 'running'].includes(run.status) && run.observation && run.paneId;
const textField = (value, max = 4000) => typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : null;
function targetIsValid(target) {
  return ['codex', 'claude', 'qodercli'].includes(target?.provider)
    && /^[\w.:-]{1,128}$/u.test(target.threadId || '') && !target.threadId.startsWith('tmux:')
    && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/u.test(target.tmuxSession || '');
}

export class AutonomyController extends EventEmitter {
  constructor({ readSession, send, stop, file, now = Date.now, schedule = setTimeout, cancel = clearTimeout }) {
    super();
    Object.assign(this, { readSession, send, stop, file, now, schedule, cancel });
    this.receiptDirectory = file ? path.join(path.dirname(file), 'autonomy-results') : path.join(os.tmpdir(), `codeck-autonomy-results-${process.pid}`);
    this.runs = new Map(); this.polls = new Map(); this.timer = null; this.closed = false;
    if (file && fs.existsSync(file)) {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      // This state format has no migration or replay path from the old scheduler.
      if (saved.version !== 3) return;
      if (!Array.isArray(saved.runs)) throw new Error('自主任务存档格式无效');
      for (const old of saved.runs) {
        if (!targetIsValid(old.target) || old.mode !== 'observed' || ![...ACTIVE, ...TERMINAL].includes(old.status)) continue;
        const run = { ...old, generation: 0 };
        if (run.status === 'exiting') { run.status = 'ended'; run.reason = '服务重启，中断结果未确认；请检查终端。'; }
        this.runs.set(autonomyKey(run.target), run);
      }
      this.persist();
      this.wake();
    }
  }
  snapshot(target) {
    const run = this.runs.get(autonomyKey(target));
    if (!run) return null;
    const { generation, paneId, observation, planningText, ...view } = run;
    return structuredClone(view);
  }
  snapshots() { return [...this.runs.values()].map(run => this.snapshot(run.target)); }
  persist() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 3, runs: [...this.runs.values()] }), { mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }
  changed(run) {
    if (TERMINAL.has(run.status)) run.stoppedAt ??= this.now();
    run.updatedAt = this.now(); this.persist(); this.emit('change', this.snapshot(run.target)); this.wake();
  }
  wake() {
    if (this.closed || this.timer || ![...this.runs.values()].some(needsPoll)) return;
    this.timer = this.schedule(() => {
      this.timer = null; this.tick().catch(() => {}); this.wake();
    }, 2000);
    this.timer?.unref?.();
  }
  async preparePlanning(target) {
    if (!targetIsValid(target)) throw new Error('规划需要已绑定的 Agent 会话');
    const key = autonomyKey(target), old = this.runs.get(key);
    if (old && ['running', 'exiting', 'ended', 'completed', 'error'].includes(old.status)) throw new Error('请先按 A 恢复默认状态');
    const startNonce = crypto.randomUUID(), endNonce = crypto.randomUUID();
    fs.mkdirSync(this.receiptDirectory, { recursive: true, mode: 0o700 });
    const observation = { startNonce, endNonce, startFile: path.join(this.receiptDirectory, `${startNonce}.json`), endFile: path.join(this.receiptDirectory, `${endNonce}.json`) };
    const run = { id: crypto.randomUUID(), target: { ...target }, mode: 'observed', status: 'planning',
      generation: 0, plan: null, summary: '', reason: '等待用户确认', observation };
    this.runs.set(key, run); this.changed(run);
    try {
      const session = await this.readSession(target);
      if (this.runs.get(key) !== run || this.closed) throw new Error('规划请求已失效');
      if (!this.sameSession(run, session, false)) throw new Error('会话身份已变化');
      run.paneId = session.agent.paneId;
      run.planningText = `${AUTONOMY_PLANNING_PROMPT}\n\n<codeck-autonomy-context>\n${observedStatusInstructions(observation.startFile, observation.endFile)}\n</codeck-autonomy-context>`;
      this.changed(run);
      return { planningId: run.id, text: run.planningText, autonomy: this.snapshot(target) };
    } catch (error) {
      if (!this.closed && this.runs.get(key) === run && run.status === 'planning') this.fail(target, error.message);
      throw error;
    }
  }
  planningIsCurrent(target, id, text) {
    const run = this.runs.get(autonomyKey(target));
    return !this.closed && run?.mode === 'observed' && run.status === 'planning' && run.id === id && run.planningText === text;
  }
  async pollObserved(run) {
    const current = () => !this.closed && this.runs.get(autonomyKey(run.target)) === run && ['planning', 'running'].includes(run.status);
    const source = run.observation;
    const started = readReceipt(source.startFile, source.startNonce);
    const ended = readReceipt(source.endFile, source.endNonce);
    if (!ended && (run.status === 'running' || !started)) return;
    const session = await this.readSession(run.target);
    if (!current()) return;
    if (!this.sameSession(run, session)) { this.end(run.target, 'ended', '会话身份已变化，停止跟踪；请检查终端。'); return; }
    if (run.status === 'planning' && started) {
      if (started.status !== 'started' || !textField(started.goal) || !textField(started.summary)) throw new Error('开始状态回执无效');
      run.plan = { goal: started.goal }; run.startedAt = this.now();
      run.status = 'running'; run.reason = 'Agent 已确认开始执行'; run.summary = started.summary; this.changed(run);
    }
    if (!ended) return;
    if (!['completed', 'stopped', 'budget', 'blocked', 'error'].includes(ended.status) || !textField(ended.summary) || !textField(ended.next)) throw new Error('结束状态回执无效');
    if (ended.status === 'completed') {
      if (!started) return; // A final reply without a confirmed start cannot mean success.
      if (!textField(ended.evidence) || !textField(ended.checkpoint?.version) || !textField(ended.checkpoint?.verification)) throw new Error('完成状态缺少版本或验证证据');
    }
    run.summary = ended.summary; run.next = ended.next; run.evidence = ended.evidence || '';
    run.checkpoint = ended.checkpoint || null;
    this.end(run.target, ended.status === 'completed' ? 'completed' : ended.status === 'error' ? 'error' : 'ended',
      ({ completed: 'Agent 报告目标已验证完成', stopped: '任务已中止', budget: '预算已耗尽', blocked: '任务受阻', error: '执行出错' })[ended.status]);
  }
  async resetObserved(target) {
    const run = this.runs.get(autonomyKey(target));
    if (!run || run.status === 'off') return this.snapshot(target);
    if (run.status === 'exiting') return this.snapshot(target);
    if (run.status !== 'running') return this.end(target, 'off', '用户已恢复默认状态');
    run.status = 'exiting'; run.generation++; this.changed(run);
    const current = () => !this.closed && this.runs.get(autonomyKey(target)) === run && run.status === 'exiting';
    try {
      await this.stop?.({ ...target, paneId: run.paneId }, current, { stopBackground: false });
      if (!current()) return this.snapshot(target);
      const session = await this.readSession(target);
      if (!current()) return this.snapshot(target);
      if (!this.sameSession(run, session) || session.hasRunningProcess || session.agent.question) throw new Error('中断未确认，请检查终端');
      const delivery = await this.send({ ...target, paneId: run.paneId }, `用户已按 A 中止自主任务。停止新实验，只总结目标、进展、验证证据、未完成事项和下一步，然后退出。不要续跑。`, current,
        { nonInterrupting: true, commandId: crypto.randomUUID() });
      if (['not-sent', 'unconfirmed'].includes(delivery?.submissionStatus)) throw new Error('总结请求提交未确认，请检查终端；不会自动重发');
      if (current()) this.end(target, 'off', '用户已中止并恢复默认状态；总结将在对话中输出');
    } catch (error) { if (current()) { this.fail(target, error.message); throw error; } }
    return this.snapshot(target);
  }
  end(target, status, reason) {
    const run = this.runs.get(autonomyKey(target));
    if (!run) return null;
    run.generation++; run.status = status; run.reason = reason;
    this.changed(run); return this.snapshot(target);
  }
  fail(target, reason) { return this.end(target, 'error', reason); }
  exit(target, reason = '自主执行已退出；当前工作可继续收尾。') {
    const run = this.runs.get(autonomyKey(target));
    return run && ACTIVE.has(run.status) ? this.end(target, 'ended', reason) : this.snapshot(target);
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
      if (active && this.runs.get(autonomyKey(target)) === run && run.status === 'ended') {
        run.reason = verified ? '已停止当前执行，自主模式已退出。' : '已发送停止请求，自主模式已退出。'; this.changed(run);
      }
      return result;
    } catch (error) {
      if (active && this.runs.get(autonomyKey(target)) === run && run.status === 'ended') this.fail(target, `停止未确认：${error.message}`);
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
      const poll = this.pollObserved(run).catch(error => {
        if (!this.closed && this.runs.get(key) === run && run.generation === generation && ACTIVE.has(run.status)) this.fail(run.target, error.message);
      }).finally(() => { if (this.polls.get(key) === poll) this.polls.delete(key); });
      this.polls.set(key, poll); return poll;
    }));
  }
  close() {
    this.closed = true;
    if (this.timer) this.cancel(this.timer);
    this.timer = null;
  }
}
