import { autonomyKey, autonomyPresentation, autonomyDisplayText, isProgressPrompt, isAutonomyObservation, AUTONOMY_PLANNING_PROMPT } from './remote-autonomy.js?v=13';

export function createTerminalAutonomy({ getTarget, request, focusTerminal, document = globalThis.document }) {
  const $ = id => document.getElementById(id);
  const button = $('terminalAutonomyButton'), status = $('terminalAutonomyStatus');
  const notice = $('terminalAutonomyNotice');
  const runs = new Map();
  let supported = false, connected = false, bindingKey, bound = false, generation = 0;
  let pending = false, actionSequence = 0, lastReason = '';
  let lastSummaryRun, summaryFingerprint = '';
  const keyOf = target => target ? autonomyKey(target) : '';
  const targetNow = () => supported && connected ? getTarget() : null;
  const current = () => runs.get(keyOf(getTarget()));
  const fields = target => ({ provider: target.provider, threadId: target.threadId, tmuxSession: target.tmuxSession });
  function message(text = '') { notice.textContent = text; notice.hidden = !text; }
  function element(tag, text) { const el = document.createElement(tag); el.textContent = text; return el; }
  function syncSummary(run, key) {
    const panel = $('terminalAutonomySummary'), body = $('terminalAutonomySummaryContent');
    const ended = ['completed', 'off', 'error', 'ended'].includes(run?.status);
    panel.hidden = !(bound && ended && run?.plan);
    if (!panel.hidden) {
      const rows = [
        ['结束原因', run.reason || ({ completed: '目标完成', off: '已退出', error: '执行出错' })[run.status]],
        ['目标', run.plan.goal],
        ['进展与结果', run.summary || '尚未收到完整总结；请核对终端，以下仅列出已保存的信息。'],
        ['验证与证据', [run.checkpoint?.version, run.checkpoint?.verification, run.evidence].filter(Boolean).join('\n')],
        ['下一步', run.next],
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
    if (!target || !bound || (pending && type !== 'resetAutonomy') || keyOf(target) !== bindingKey) return false;
    const epoch = generation, before = current(), action = ++actionSequence;
    pending = true; message(); sync();
    try {
      const commandId = crypto.randomUUID();
      if (type === 'sendSessionMessage' && extra.text === AUTONOMY_PLANNING_PROMPT) {
        const planning = await request('prepareAutonomyPlanning', { ...fields(target), commandId: `${commandId}:plan` });
        if (epoch !== generation || action !== actionSequence || keyOf(targetNow()) !== bindingKey) return false;
        extra = { ...extra, text: planning.text, planningId: planning.planningId };
      }
      const result = await request(type, { ...fields(target), commandId, ...extra });
      if (epoch !== generation || action !== actionSequence || keyOf(targetNow()) !== bindingKey) return false;
      if (current() === before && result?.autonomy) runs.set(bindingKey, result.autonomy);
      if (type === 'sendSessionMessage' && result?.submissionStatus === 'unconfirmed') message('规划请求提交未确认，请检查终端，勿重复点击。');
      return true;
    } catch (error) {
      if (epoch === generation && action === actionSequence) { message(error.message); throw error; }
      return false;
    } finally { if (epoch === generation && action === actionSequence) { pending = false; sync(); } }
  }
  function sync() {
    const target = targetNow(), key = keyOf(target);
    if (key !== bindingKey) {
      bindingKey = key; bound = false; generation++; pending = false;
      lastSummaryRun = null; summaryFingerprint = ''; lastReason = ''; message();
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
    button.disabled = !target || !bound || (pending && !view.active);
    button.title = [view.label, run?.reason].filter(Boolean).join('：');
    button.setAttribute('aria-label', view.label); button.setAttribute('aria-pressed', String(view.active));
    button.setAttribute('aria-busy', String(pending)); button.dataset.state = run?.status || 'off'; button.dataset.tone = view.tone;
    status.textContent = view.progress; syncSummary(run, key);
    const reason = bound && run?.status === 'error' ? run.reason : '';
    if (reason !== lastReason) { lastReason = reason; message(reason); }
  }
  button.addEventListener('click', async () => {
    if (button.disabled || button.hidden) return;
    if (!autonomyPresentation(current()).resettable && targetNow()?.question) {
      focusTerminal?.(); message('Agent 正在等待回答，请先处理当前问题。'); return;
    }
    try {
      if (autonomyPresentation(current()).resettable) await act('resetAutonomy');
      else await act('sendSessionMessage', { text: AUTONOMY_PLANNING_PROMPT });
    }
    catch { /* The scoped notice describes the failure. */ }
  });
  return {
    sync, update,
    runFor: target => runs.get(keyOf(target)),
    ready(message) {
      generation++; bindingKey = undefined; bound = false;
      connected = true; supported = message.autonomySessionBinding === true;
      runs.clear(); for (const run of message.autonomy || []) runs.set(autonomyKey(run.target), run); sync();
    },
    disconnect() { connected = false; sync(); },
    sendDirection(text) {
      const run = current();
      if (!supported || !run || !['planning', 'running', 'exiting'].includes(run.status)
        || (text.startsWith('/') && !isAutonomyObservation(text)) || isProgressPrompt(text) || getTarget()?.question) return null;
      const target = targetNow();
      if (!target || !bound) return null;
      // Conversation is independent of A controls: a pending settings/exit request
      // must not lock ordinary input or treat it as a new configuration answer.
      return request('sendSessionMessage', { ...fields(target), text, commandId: crypto.randomUUID() });
    },
  };
}
