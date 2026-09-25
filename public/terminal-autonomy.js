import { autonomyKey, autonomyPresentation, autonomyDisplayText, isProgressPrompt, isAutonomyObservation } from './remote-autonomy.js?v=11';
import { createAutonomyForm } from './autonomy-form.js?v=4';

export function createTerminalAutonomy({ getTarget, request, document = globalThis.document }) {
  const $ = id => document.getElementById(id);
  const button = $('terminalAutonomyButton'), status = $('terminalAutonomyStatus');
  const dialog = $('terminalAutonomyDialog'), content = $('terminalAutonomyContent'), notice = $('terminalAutonomyNotice');
  const runs = new Map();
  let supported = false, connected = false, bindingKey, bound = false, generation = 0;
  let pending = false, actionSequence = 0, dismissed = '', formKey = '', lastReason = '', setupOpened = false;
  let lastSummaryRun, summaryFingerprint = '';
  const keyOf = target => target ? autonomyKey(target) : '';
  const targetNow = () => supported && connected ? getTarget() : null;
  const current = () => runs.get(keyOf(getTarget()));
  const fields = target => ({ provider: target.provider, threadId: target.threadId, tmuxSession: target.tmuxSession });
  function message(text = '') { notice.textContent = text; notice.hidden = !text; }
  function element(tag, text) { const el = document.createElement(tag); el.textContent = text; return el; }
  function syncSummary(run, key) {
    const panel = $('terminalAutonomySummary'), body = $('terminalAutonomySummaryContent');
    const ended = ['completed', 'off', 'error'].includes(run?.status);
    panel.hidden = !(bound && ended && run?.plan && run.round > 0);
    if (!panel.hidden) {
      const rows = [
        ['结束原因', run.reason || ({ completed: '目标完成', off: '已退出', error: '执行出错' })[run.status]],
        ['目标', run.plan.goal],
        ['进展与结果', run.summary || '尚未收到完整总结；请核对终端，以下仅列出已保存的信息。'],
        ['验证与证据', [run.best?.version, run.best?.evidence || run.checkpoint?.verification, run.best?.artifact].filter(Boolean).join('\n')],
        ['未完成事项', run.checkpoint?.current], ['下一步', run.next || run.handoff?.next],
        ['预算使用', `已用 ${run.round} 轮${run.plan.maxRounds == null ? '，轮数不限' : `，上限 ${run.plan.maxRounds} 轮`}`],
      ].filter(([, value]) => value);
      const fingerprint = JSON.stringify([key, run.id, rows]);
      if (summaryFingerprint !== fingerprint) {
        body.replaceChildren();
        for (const [label, value] of rows) body.append(element('dt', label), element('dd', autonomyDisplayText(value)));
        summaryFingerprint = fingerprint;
      }
      if (lastSummaryRun?.key === key && lastSummaryRun.id === run.id && !lastSummaryRun.ended) panel.open = true;
      else if (lastSummaryRun?.key !== key || lastSummaryRun?.id !== run.id) panel.open = false;
    }
    if (bound) lastSummaryRun = run ? { key, id: run.id, ended } : null;
  }
  function update(run) {
    if (run) runs.set(autonomyKey(run.target), run);
    if (run && autonomyKey(run.target) === bindingKey && run.status !== 'error') message();
    sync();
  }
  async function act(type, extra = {}) {
    const target = targetNow();
    if (!target || !bound || (pending && !['startAutonomy', 'finishAutonomy'].includes(type)) || keyOf(target) !== bindingKey) return false;
    const epoch = generation, before = current(), action = ++actionSequence;
    pending = true; message(); sync();
    try {
      const result = await request(type, { ...fields(target), commandId: crypto.randomUUID(), ...extra });
      if (epoch !== generation || action !== actionSequence || keyOf(targetNow()) !== bindingKey) return false;
      if (current() === before && result?.autonomy) runs.set(bindingKey, result.autonomy);
      return true;
    } catch (error) {
      if (epoch === generation && action === actionSequence) { message(error.message); throw error; }
      return false;
    } finally { if (epoch === generation && action === actionSequence) { pending = false; sync(); } }
  }
  function sync() {
    const target = targetNow(), key = keyOf(target);
    if (key !== bindingKey) {
      bindingKey = key; bound = false; generation++; pending = false; dismissed = ''; formKey = ''; setupOpened = false;
      lastSummaryRun = null; summaryFingerprint = ''; content.replaceChildren();
      if (dialog.open) dialog.close(); lastReason = ''; message();
      if (connected && supported) {
        const epoch = generation, before = runs.get(key);
        request('bindAutonomySession', target ? fields(target) : { threadId: null, tmuxSession: null }).then(result => {
          if (epoch !== generation) return;
          bound = Boolean(target);
          if (runs.get(key) === before && result.autonomy) runs.set(key, result.autonomy);
          sync();
        }).catch(error => { if (epoch === generation) message(error.message); });
      }
    }
    const run = current(), view = autonomyPresentation(run);
    button.hidden = !supported || !getTarget();
    button.disabled = !target || !bound;
    button.title = [view.label, run?.reason].filter(Boolean).join('：');
    button.setAttribute('aria-label', view.label); button.setAttribute('aria-pressed', String(view.active));
    button.setAttribute('aria-busy', String(pending)); button.dataset.state = run?.status || 'off'; button.dataset.tone = view.tone;
    status.textContent = view.progress; syncSummary(run, key);
    const reason = bound && run?.status === 'error' ? run.reason : '';
    if (reason !== lastReason) { lastReason = reason; message(reason); }
    if (!target || !bound || !setupOpened || !run?.setup || run.status !== 'configuring' || !run.requestId) {
      if (dialog.open) dialog.close(); return;
    }
    const nextKey = `${key}:${run.requestId}`;
    if (formKey !== nextKey) {
      formKey = nextKey; $('terminalAutonomyTitle').textContent = '设置自主目标';
      const epoch = generation;
      content.replaceChildren(createAutonomyForm({ document, run,
        isCurrent: () => epoch === generation && current()?.requestId === run.requestId && bound && connected,
        submit: async (answers, commandId) => {
          if (!await act('answerAutonomy', { requestId: run.requestId, answers, commandId })) throw new Error('连接或会话已变化，未提交');
        } }));
    }
    const form = content.querySelector('form'); form?.setPending(pending); form?.updateDefinition(run);
    if (!dialog.open && dismissed !== nextKey && !document.querySelector('dialog[open]')) dialog.showModal();
  }
  button.addEventListener('click', async () => {
    if (button.disabled || button.hidden) return;
    setupOpened = true; dismissed = '';
    try { await act(autonomyPresentation(current()).active ? 'finishAutonomy' : 'startAutonomy'); }
    catch { /* The scoped notice describes the failure. */ }
  });
  function dismiss() { dismissed = formKey; dialog.close(); }
  $('closeTerminalAutonomy').addEventListener('click', dismiss);
  dialog.addEventListener('cancel', event => { event.preventDefault(); dismiss(); });
  return {
    sync, update,
    ready(message) {
      setupOpened = false; generation++; bindingKey = undefined; bound = false;
      connected = true; supported = message.autonomySessionBinding === true;
      runs.clear(); for (const run of message.autonomy || []) runs.set(autonomyKey(run.target), run); sync();
    },
    disconnect() { connected = false; sync(); },
    sendDirection(text) {
      const run = current();
      if (!supported || !run || !['configuring', 'running', 'exiting'].includes(run.status)
        || (text.startsWith('/') && !isAutonomyObservation(text)) || isProgressPrompt(text) || getTarget()?.question) return null;
      const target = targetNow();
      if (!target || !bound) return null;
      // Conversation is independent of A controls: a pending settings/exit request
      // must not lock ordinary input or treat it as a new configuration answer.
      return request('sendSessionMessage', { ...fields(target), text, commandId: crypto.randomUUID() });
    },
  };
}
