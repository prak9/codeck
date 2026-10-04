import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { autonomyKey, AUTONOMY_PLANNING_PROMPT, AUTONOMY_CONFIRM_PROMPT } from '../public/remote-autonomy.js';
import { readReceipt, observedStatusInstructions, cleanupInstructions } from './autonomy-receipt.js';

const ACTIVE = new Set(['planning', 'running', 'exiting']);
const TERMINAL = new Set(['completed', 'error', 'off', 'ended']);
const UUID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/u;
const needsPoll = run => (['planning', 'running'].includes(run.status) || (run.status === 'exiting' && run.cleanupPending)) && run.observation && run.paneId;
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
        if (run.status === 'exiting') { run.status = 'error'; run.exitFailed = true; run.reason = '服务重启，中断结果未确认；请按 A 重试退出。'; }
        this.runs.set(autonomyKey(run.target), run);
      }
      this.persist();
      this.wake();
    }
  }
  snapshot(target) {
    const run = this.runs.get(autonomyKey(target));
    if (!run) return null;
    const { generation, paneId, observation, planningText, cleanupFile, cleanupNonce, ...view } = run;
    if (observation?.endNonce) view.summaryReceiptId = observation.endNonce;
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
    if (this.timer && ![...this.runs.values()].some(needsPoll)) { this.cancel(this.timer); this.timer = null; }
    if (this.closed || this.timer || ![...this.runs.values()].some(needsPoll)) return;
    this.timer = this.schedule(() => {
      this.timer = null; this.tick().catch(() => {}); this.wake();
    }, 2000);
    this.timer?.unref?.();
  }
  async preparePlanning(target) {
    if (!targetIsValid(target)) throw new Error('规划需要已绑定的 Agent 会话');
    const key = autonomyKey(target), old = this.runs.get(key);
    if (old && (['planning', 'running', 'exiting', 'completed'].includes(old.status) || old.exitFailed)) throw new Error('请先按 A 退出自主执行');
    this.retireReceipts(old);
    this.polls.delete(key); // A slow poll for the retired run must not hold up the new task.
    const id = crypto.randomUUID();
    const startNonce = crypto.randomUUID(), endNonce = crypto.randomUUID();
    const directory = path.join(this.receiptDirectory, id);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const observation = { startNonce, endNonce, startFile: path.join(directory, `${startNonce}.json`), endFile: path.join(directory, `${endNonce}.json`) };
    observation.planNonce = crypto.randomUUID();
    observation.planFile = path.join(directory, `${observation.planNonce}.json`);
    const run = { id, target: { ...target }, mode: 'observed', status: 'planning',
      generation: 0, plan: null, summary: '', reason: '等待用户确认', observation };
    this.runs.set(key, run); this.changed(run);
    try {
      const session = await this.readSession(target);
      if (this.runs.get(key) !== run || this.closed) throw new Error('规划请求已失效');
      if (!this.sameSession(run, session, false)) throw new Error('会话身份已变化');
      run.paneId = session.agent.paneId;
      run.planningText = `${AUTONOMY_PLANNING_PROMPT}\n\n<codeck-autonomy-context>\n${observedStatusInstructions(observation.startFile, observation.endFile, observation.planFile)}\n</codeck-autonomy-context>`;
      this.changed(run);
      return { planningId: run.id, text: run.planningText, autonomy: this.snapshot(target) };
    } catch (error) {
      if (!this.closed && this.runs.get(key) === run && run.status === 'planning') this.fail(target, error.message);
      throw error;
    }
  }
  retireReceipts(run) {
    if (!run?.observation || !UUID.test(run.id)) return;
    const directory = path.join(this.receiptDirectory, run.id);
    // Delete only this run's owned paths, never paths supplied by a saved record.
    fs.rmSync(directory, { recursive: true, force: true });
    for (const kind of ['start', 'end']) {
      const nonce = run.observation[`${kind}Nonce`];
      if (!UUID.test(nonce)) continue;
      const file = path.join(this.receiptDirectory, `${nonce}.json`);
      if (run.observation[`${kind}File`] === file) fs.rmSync(file, { force: true });
    }
  }
  planningIsCurrent(target, id, text) {
    const run = this.runs.get(autonomyKey(target));
    return !this.closed && run?.mode === 'observed' && run.status === 'planning' && run.id === id && run.planningText === text;
  }
  async confirmPlanning(target, planningId) {
    const key = autonomyKey(target), run = this.runs.get(key);
    if (!run || run.id !== planningId) throw new Error('规划已失效，请核对当前计划');
    if (run.status === 'running') return this.snapshot(target);
    if (run.status !== 'planning') throw new Error('规划已失效，请重新按 A');
    if (!run.planReady) throw new Error('请等待 Agent 整理好规划后确认');
    const session = await this.readSession(target);
    if (this.closed || this.runs.get(key) !== run) throw new Error('规划已失效');
    if (run.status === 'running') return this.snapshot(target);
    if (run.status !== 'planning') throw new Error('规划已失效');
    if (!this.sameSession(run, session)) throw new Error('会话身份已变化');
    if (session.hasRunningProcess || session.agent.question) throw new Error('请等待规划完成并处理当前问题后确认');
    run.status = 'running'; run.reason = '已确认，正在启动'; this.changed(run);
    const current = () => !this.closed && this.runs.get(key) === run && run.status === 'running';
    try {
      const delivery = await this.send({ ...target, paneId: run.paneId }, AUTONOMY_CONFIRM_PROMPT, current,
        { nonInterrupting: true, commandId: crypto.randomUUID() });
      if (['not-sent', 'deferred', 'unconfirmed'].includes(delivery?.submissionStatus)) throw new Error('确认提交未确认，请检查终端；不会自动重发');
    } catch (error) {
      if (current()) { run.exitFailed = true; this.fail(target, error.message); }
      throw error;
    }
    return this.snapshot(target);
  }
  async pollObserved(run) {
    if (run.status === 'exiting') return this.pollCleanup(run);
    const current = () => !this.closed && this.runs.get(autonomyKey(run.target)) === run && ['planning', 'running'].includes(run.status);
    const source = run.observation;
    if (run.status === 'planning' && !run.planReady && source.planFile) {
      const planned = readReceipt(source.planFile, source.planNonce);
      if (planned) {
        if (planned.status !== 'planned' || !textField(planned.goal) || !textField(planned.summary)) throw new Error('规划就绪回执无效');
        run.planReady = true; run.plan = { goal: planned.goal }; this.changed(run);
      }
    }
    const started = readReceipt(source.startFile, source.startNonce);
    const ended = readReceipt(source.endFile, source.endNonce);
    if (!ended && (run.startedAt || !started)) return;
    const session = await this.readSession(run.target);
    if (!current()) return;
    if (!this.sameSession(run, session)) { run.exitFailed = true; this.fail(run.target, '会话身份已变化，清理未确认；请检查终端。'); return; }
    if (!run.startedAt && started) {
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
    // The receipt precedes the final reply. Never interrupt that reply to clean up.
    if (session.hasRunningProcess || session.agent.question) return;
    try {
      const result = await this.stop?.({ ...run.target, paneId: run.paneId }, current,
        { stopBackground: false, stopGoal: true, onlyIfIdle: true });
      if (!current() || result?.deferred) return;
      if (!textField(ended.cleanup)) throw new Error('缺少任务资源清理核验记录，请重试退出');
      const after = await this.readSession(run.target);
      if (!current()) return;
      if (!this.sameSession(run, after) || after.hasRunningProcess || after.agent.question || after.agent.hasBackgroundProcess) throw new Error('仍有执行资源或会话已变化');
      run.cleanupVerified = true;
      run.cleanupReport = ended.cleanup;
    } catch (error) {
      if (current()) { run.exitFailed = true; this.fail(run.target, `收尾清理未确认：${error.message}`); }
      return;
    }
    this.end(run.target, ended.status === 'completed' ? 'completed' : ended.status === 'error' ? 'error' : 'ended',
      ({ completed: 'Agent 报告目标已验证完成', stopped: '任务已中止', budget: '预算已耗尽', blocked: '任务受阻', error: '执行出错' })[ended.status]);
  }
  async resetObserved(target, runId) {
    const run = this.runs.get(autonomyKey(target));
    if (runId && run?.id !== runId) throw new Error('自主任务已变化，请核对当前任务');
    if (!run || run.status === 'off') return this.snapshot(target);
    if (run.status === 'exiting') return this.snapshot(target);
    // A verified finished run owns no live execution. Reset its retained UI state
    // without inspecting or interrupting whatever now occupies the same terminal.
    // This also recovers errors left by the previous reset path after completion.
    if (TERMINAL.has(run.status) && run.cleanupVerified === true) return this.end(target, 'off', '清理已核验，自主模式已退出');
    // No prompt can have been delivered if preparation never bound a pane.
    if (!run.paneId && !run.planningText) return this.end(target, 'off', '未启动任务，规划资源已回收');
    const planning = run.exitPlanning ?? (run.status === 'planning');
    const onlyIfIdle = Boolean(run.cleanupVerified);
    run.exitPlanning = planning;
    run.status = 'exiting'; run.generation++; this.changed(run);
    const current = () => !this.closed && this.runs.get(autonomyKey(target)) === run && run.status === 'exiting';
    try {
      const stopped = await this.stop?.({ ...target, paneId: run.paneId }, current,
        { stopBackground: false, stopGoal: !planning, ...(onlyIfIdle ? { onlyIfIdle: true } : {}) });
      if (!current()) return this.snapshot(target);
      if (stopped?.deferred) throw new Error('会话有新的执行，未打断；请等待其结束后重试退出');
      const session = await this.readSession(target);
      if (!current()) return this.snapshot(target);
      if (!this.sameSession(run, session) || session.hasRunningProcess || session.agent.question) throw new Error('中断未确认，请检查终端');
      if (run.cleanupVerified && !session.agent.hasBackgroundProcess) return this.end(target, 'off', '清理已核验，自主模式已退出');
      if (!UUID.test(run.id)) throw new Error('任务资源目录身份无效，未执行清理');
      delete run.cleanupVerified;
      const directory = path.join(this.receiptDirectory, run.id);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      run.cleanupNonce = crypto.randomUUID();
      run.cleanupFile = path.join(directory, `${run.cleanupNonce}.json`);
      run.cleanupPending = true; run.cleanupRequestedAt = this.now(); this.changed(run);
      const delivery = await this.send({ ...target, paneId: run.paneId }, `用户已退出自主模式。${planning ? '取消规划，保留规划前已有的 goal。' : '原生 goal 已请求清除。'}\n${cleanupInstructions(run.cleanupFile)}`, current,
        { nonInterrupting: true, commandId: crypto.randomUUID() });
      if (['not-sent', 'deferred', 'unconfirmed'].includes(delivery?.submissionStatus)) throw new Error('总结请求提交未确认，请检查终端；不会自动重发');
      if (current()) await this.pollCleanup(run);
    } catch (error) { if (current()) { run.exitFailed = true; this.fail(target, error.message); throw error; } }
    return this.snapshot(target);
  }
  async pollCleanup(run) {
    const current = () => !this.closed && this.runs.get(autonomyKey(run.target)) === run && run.status === 'exiting';
    const receipt = readReceipt(run.cleanupFile, run.cleanupNonce);
    if (!receipt) {
      if (this.now() - run.cleanupRequestedAt < 30_000) return;
      const session = await this.readSession(run.target);
      if (current() && (!this.sameSession(run, session) || (!session.hasRunningProcess && !session.agent.question))) throw new Error('清理回执未收到，退出未确认；请检查终端后重试');
      return;
    }
    if (receipt.status !== 'stopped' || !textField(receipt.summary) || !textField(receipt.evidence) || !textField(receipt.next)) throw new Error(`清理未确认：${receipt.summary || '缺少清理证据'}`);
    const session = await this.readSession(run.target);
    if (!current()) return;
    if (!this.sameSession(run, session)) throw new Error('会话身份已变化，清理未确认');
    if (session.hasRunningProcess || session.agent.question) return;
    if (session.agent.hasBackgroundProcess) throw new Error('仍检测到后台资源，清理未确认；请核对归属后重试退出');
    const stopped = await this.stop?.({ ...run.target, paneId: run.paneId }, current,
      { stopBackground: false, stopGoal: !run.exitPlanning, onlyIfIdle: true });
    if (!current() || stopped?.deferred) return;
    const after = await this.readSession(run.target);
    if (!current()) return;
    if (!this.sameSession(run, after) || after.agent.hasBackgroundProcess) throw new Error('清理后的会话或后台资源状态发生变化');
    if (after.hasRunningProcess || after.agent.question) return;
    run.cleanupVerified = true; run.cleanupReport = receipt;
    delete run.cleanupPending;
    this.end(run.target, 'off', '任务资源清理已核验，自主模式已退出');
  }
  end(target, status, reason) {
    const run = this.runs.get(autonomyKey(target));
    if (!run) return null;
    if (!run.exitFailed || status === 'off') {
      this.retireReceipts(run);
      delete run.planningText;
    }
    run.generation++; run.status = status; run.reason = reason;
    if (status === 'off') { delete run.exitFailed; delete run.exitPlanning; delete run.cleanupPending; }
    this.changed(run); return this.snapshot(target);
  }
  fail(target, reason) {
    const run = this.runs.get(autonomyKey(target));
    if (run?.paneId && ACTIVE.has(run.status)) run.exitFailed = true;
    return this.end(target, 'error', reason);
  }
  exit(target) {
    return this.resetObserved(target);
  }
  exitSession(sessionName) {
    return Promise.all([...this.runs.values()].filter(run => run.target.tmuxSession === sessionName).map(run => this.exit(run.target)));
  }
  async interrupt(target, operation, { verified = false } = {}) {
    const run = this.runs.get(autonomyKey(target)), active = run && ACTIVE.has(run.status);
    if (run?.status === 'exiting') throw new Error('正在退出，请等待结果');
    const planning = run?.status === 'planning';
    if (active) { run.exitPlanning = planning; run.status = 'exiting'; run.generation++; this.changed(run); }
    const current = () => !this.closed && this.runs.get(autonomyKey(target)) === run && run.status === 'exiting';
    try {
      const result = await operation();
      if (active && current()) {
        run.status = planning ? 'planning' : 'running';
        await this.resetObserved(target, run.id);
      }
      return result;
    } catch (error) {
      if (active && current()) this.fail(target, `停止未确认：${error.message}`);
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
