import { AUTONOMY_DECISIONS, autonomyKey, autonomyPresentation, autonomyBudgetText, isProgressPrompt, isAutonomyObservation } from './remote-autonomy.js?v=9';
import { shouldKeepDeliveryAttempt } from './remote-delivery.js?v=5';
import { chooseStopScope } from './session-stop.js?v=1';
import { createAutonomyForm } from './autonomy-form.js?v=1';

// The terminal and Remote are views of the same server-owned run, not two loops.
export function createTerminalAutonomy({ getTarget, request, focusTerminal, document = globalThis.document }) {
  const $ = id => document.getElementById(id);
  const button = $('terminalAutonomyButton'), status = $('terminalAutonomyStatus');
  const dialog = $('terminalAutonomyDialog'), content = $('terminalAutonomyContent');
  const notice = $('terminalAutonomyNotice');
  const stopButton = $('terminalStopButton');
  let stopSupported = false;
  const runs = new Map();
  let supported = false, simple = false, connected = false, bindingKey, bound = false, generation = 0;
  let pending = false, dismissed = '', formKey = '', lastReason = '';
  let setupOpened = false;
  const keyOf = target => target ? autonomyKey(target) : '';
  const targetNow = () => supported && connected ? getTarget() : null;
  const current = () => runs.get(keyOf(getTarget()));
  const fields = target => ({ provider: target.provider, threadId: target.threadId, tmuxSession: target.tmuxSession });
  function message(text = '') { notice.textContent = text; notice.hidden = !text; }
  function element(tag, className = '', text = '') {
    const el = document.createElement(tag); el.className = className; el.textContent = text; return el;
  }
  function questionFor(run) {
    if (simple && !run?.setup) return null;
    if (!run?.requestId || (!['configuring', 'confirming'].includes(run.status) && !(run.status === 'paused' && run.recovery))) return null;
    if (run.status === 'confirming' && run.proposal) return [{ id: 'decision', header: '下一步',
      question: '确认停止旧任务，按此目标和预算执行？', options: AUTONOMY_DECISIONS }];
    return run.questions?.length ? run.questions : null;
  }
  function update(run) {
    if (run) runs.set(autonomyKey(run.target), run);
    if (run && autonomyKey(run.target) === bindingKey && run.status !== 'paused') message();
    sync();
  }
  async function act(type, extra = {}) {
    const target = targetNow();
    if (!target || !bound || pending || keyOf(target) !== bindingKey
      || (target.question && type !== 'interruptSession' && !(extra.simple && ['startAutonomy', 'pauseAutonomy'].includes(type)))) return false;
    const epoch = generation;
    const before = current();
    pending = true; message(); sync();
    try {
      const result = await request(type, { ...fields(target), commandId: crypto.randomUUID(), ...extra });
      if (epoch !== generation || keyOf(targetNow()) !== bindingKey) return false;
      // A pushed state can already be newer than this request's snapshot.
      if (current() === before && result?.autonomy) runs.set(bindingKey, result.autonomy);
      return true;
    } catch (error) {
      if (epoch === generation) { message(error.message); throw error; }
      return false;
    } finally {
      if (epoch === generation) { pending = false; sync(); }
    }
  }
  function buildForm(run, questions) {
    if (run.setup && run.definition?.version === 2) {
      const epoch = generation;
      return createAutonomyForm({ document, run,
        isCurrent: () => epoch === generation && current()?.requestId === run.requestId && bound && connected,
        submit: async (answers, commandId) => {
          if (!await act('answerAutonomy', { requestId: run.requestId, answers, commandId })) throw new Error('连接或会话已变化，未提交');
        } });
    }
    const form = element('form');
    if (run.proposal) {
      const plan = run.proposal, details = element('dl', 'terminal-autonomy-plan');
      for (const [label, value] of [
        ['目标', plan.goal], ['完成标准', plan.acceptance],
        ['预算', autonomyBudgetText(plan, run.round)],
        ['偏好与边界', plan.preferences], ['参考预算', plan.advisoryBudget],
      ]) if (value) details.append(element('dt', '', label), element('dd', '', value));
      form.append(details);
    }
    const inputs = questions.map((question, index) => {
      const field = element('fieldset'); field.dataset.questionId = question.id;
      field.append(element('legend', '', question.question));
      const options = question.options.map(option => {
        const value = typeof option === 'string' ? option : option.label;
        const label = element('label', 'terminal-autonomy-option');
        const input = element('input'); input.type = 'radio'; input.name = `autonomy-${index}`; input.value = value;
        const copy = element('span', '', value);
        if (option.description) copy.append(element('small', '', option.description));
        label.append(input, copy); field.append(label); return input;
      });
      let other;
      if (!run.proposal && question.isOther !== false) {
        const label = element('label', 'terminal-autonomy-custom', `${question.header}：自定义回答`);
        other = element('input'); other.type = 'text'; other.autocomplete = 'off'; other.maxLength = 2000;
        label.append(other); field.append(label);
        other.addEventListener('input', () => { if (other.value) for (const input of options) input.checked = false; });
        for (const input of options) input.addEventListener('change', () => { if (input.checked) other.value = ''; });
      }
      form.append(field); return { question, options, other };
    });
    const error = element('p', 'form-error'); error.setAttribute('role', 'alert');
    const actions = element('div', 'dialog-actions');
    const submit = element('button', 'primary-button', run.setup ? '开始自主执行' : '确认选择'); submit.type = 'submit';
    actions.append(submit); form.append(error, actions);
    const epoch = generation;
    let attempt;
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (epoch !== generation || current()?.requestId !== run.requestId || pending) return;
      const answers = {};
      for (const { question, options, other } of inputs) {
        const value = other?.value.trim() || options.find(input => input.checked)?.value;
        if (!value) { error.textContent = `请回答“${question.header}”。`; (options[0] || other).focus(); return; }
        answers[question.id] = [value];
      }
      // Retry the same answer with the same receipt ID; never replay automatically.
      const signature = JSON.stringify(answers);
      if (attempt?.signature !== signature) attempt = { signature, id: crypto.randomUUID() };
      error.textContent = '';
      try { await act('answerAutonomy', { requestId: run.requestId, answers, commandId: attempt.id }); }
      catch (failure) {
        if (!shouldKeepDeliveryAttempt(failure)) attempt = null;
        error.textContent = failure.message;
      }
    });
    return form;
  }
  function sync() {
    const target = targetNow(), key = keyOf(target);
    if (key !== bindingKey) {
      bindingKey = key; bound = false; generation++; pending = false; dismissed = ''; formKey = '';
      setupOpened = false;
      content.replaceChildren(); if (dialog.open) dialog.close(); lastReason = ''; message();
      if (connected && supported) {
        const epoch = generation, before = runs.get(key);
        request('bindAutonomySession', target ? fields(target) : { threadId: null, tmuxSession: null }).then(result => {
          if (epoch !== generation) return;
          bound = Boolean(target);
          if (runs.get(key) === before && result.autonomy) runs.set(key, result.autonomy);
          sync();
        }).catch(error => { if (epoch === generation) { message(error.message); } });
      }
    }
    const run = current(), view = autonomyPresentation(run, target?.session), questions = questionFor(run);
    const label = target?.question && !simple ? '处理 Agent 等待的问题'
      : run?.status === 'confirming' && run.proposal ? '确认目标并开始自主迭代' : view.label;
    button.hidden = !supported || !getTarget();
    button.disabled = !target || !bound || pending || ['stopping', 'exiting'].includes(run?.status);
    button.title = [label, run?.reason].filter(Boolean).join('：');
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-pressed', String(view.active));
    button.setAttribute('aria-busy', String(pending));
    stopButton.hidden = simple || !stopSupported || !target || !(target.session?.hasRunningProcess
      || target.session?.agent?.hasBackgroundProcess || run?.status === 'stopping');
    stopButton.disabled = !bound || pending || run?.status === 'stopping';
    button.dataset.state = run?.status || 'off';
    status.textContent = simple ? view.progress : view.detail;
    const reason = bound && run?.status === 'paused' ? run.reason : '';
    if (reason !== lastReason) { lastReason = reason; message(reason); }
    if (!target || !bound || (simple && !setupOpened) || (target.question && !run?.setup) || !questions) { if (dialog.open) dialog.close(); return; }
    const nextKey = `${key}:${run.requestId}`;
    if (formKey !== nextKey) {
      formKey = nextKey;
      $('terminalAutonomyTitle').textContent = run.recovery ? '重新配置自主目标' : run.proposal ? '确认自主目标' : '设置自主目标';
      content.replaceChildren(buildForm(run, questions));
    }
    const form = content.querySelector('form');
    form?.updateDefinition?.(run);
    if (form?.setPending) form.setPending(pending);
    else for (const input of content.querySelectorAll('input, button')) input.disabled = pending;
    if (!dialog.open && dismissed !== nextKey && !document.querySelector('dialog[open]')) dialog.showModal();
  }
  button.addEventListener('click', async () => {
    if (button.disabled || button.hidden) return;
    if (targetNow()?.question && !simple) { focusTerminal(); message('Agent 正在等待回答，请在终端中处理。'); return; }
    const run = current(), questions = questionFor(run);
    setupOpened = true;
    if (questions && !run.proposal) { dismissed = ''; sync(); return; }
    try {
      await act(!simple && questions && run.proposal ? 'answerAutonomy' : autonomyPresentation(run).active ? 'pauseAutonomy' : 'startAutonomy',
        simple ? { simple: true } : questions && run.proposal ? { requestId: run.requestId, answers: { decision: [AUTONOMY_DECISIONS[0]] } } : {});
    } catch { /* The scoped notice already describes the failure. */ }
  });
  stopButton.addEventListener('click', async () => {
    const target = targetNow(), epoch = generation;
    if (!target || stopButton.disabled) return;
    const scope = await chooseStopScope(target.session?.agent?.hasBackgroundProcess, document);
    if (!scope || epoch !== generation || keyOf(targetNow()) !== keyOf(target)) return;
    try {
      const stopped = await act('interruptSession', { scope });
      if (stopped && epoch === generation) message(scope === 'all' ? '已停止本会话任务，续跑关闭' : '已停止当前执行，后台任务保留，续跑关闭');
    } catch { /* act exposes the scoped failure. */ }
  });
  function dismiss() { dismissed = formKey; dialog.close(); }
  $('closeTerminalAutonomy').addEventListener('click', dismiss);
  dialog.addEventListener('cancel', event => { event.preventDefault(); dismiss(); });
  return {
    sync, update,
    ready(message) {
      setupOpened = false;
      generation++; bindingKey = undefined; bound = false;
      connected = true; supported = message.autonomySessionBinding === true;
      simple = message.simpleAutonomy === true;
      stopSupported = message.scopedSessionStop === true;
      runs.clear(); for (const run of message.autonomy || []) runs.set(autonomyKey(run.target), run);
      sync();
    },
    disconnect() { connected = false; sync(); },
    sendDirection(text) {
      const run = current();
      if (!supported || !run || ['completed', 'limit', 'off'].includes(run.status) || (text.startsWith('/') && !isAutonomyObservation(text)) || isProgressPrompt(text)
        || getTarget()?.question) return null;
      if (!targetNow() || !bound || pending) return Promise.reject(new Error('自主任务连接未就绪，草稿已保留'));
      return act('sendSessionMessage', { text }).then(accepted => { if (!accepted) throw new Error('会话已变化，未确认发送'); });
    },
  };
}
