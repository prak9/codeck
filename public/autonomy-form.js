import { shouldKeepDeliveryAttempt } from './remote-delivery.js?v=5';

// Both views edit the same task contract. Async preparation fills untouched fields.
export function createAutonomyForm({ document, run, submit, isCurrent }) {
  const el = (tag, text = '') => { const node = document.createElement(tag); node.textContent = text; return node; };
  const form = el('form'); form.className = 'autonomy-definition';
  const field = (label, { required = false, placeholder = '', multiline = false } = {}) => {
    const wrapper = el('label', label), input = el(multiline ? 'textarea' : 'input');
    if (multiline) input.rows = 2; else input.type = 'text'; input.maxLength = 4000;
    input.required = required; input.placeholder = placeholder; input.autocomplete = 'off';
    wrapper.append(input); form.append(wrapper); return input;
  };
  const goal = field('目标', { required: true, placeholder: '待补充：期望达到什么结果？' });
  const choices = el('div'); choices.className = 'autonomy-goals'; goal.parentElement.after(choices);
  const strategy = field('策略', { required: true, multiline: true, placeholder: '待补充：如何推进，可根据结果调整什么？' });
  const acceptance = field('验证方法', { required: true, multiline: true, placeholder: '待补充：怎样判断目标达成？' });
  const budget = field('预算轮次', { required: true, placeholder: '如 30分钟、5轮 / 30分钟，或不限' });
  const constraints = field('其他（可选）', { multiline: true, placeholder: '约束、偏好或补充说明' });
  const fields = { goal, strategy, acceptance, budget, constraints };
  const edited = new Set();
  for (const input of Object.values(fields)) input.addEventListener('input', () => edited.add(input));
  const details = el('details'); details.append(el('summary', '详细设置'));
  details.append(el('p', '范围继承当前项目和既有权限；方法由 Agent 根据结果调整。')); form.append(details);
  let continuation;
  if (run.previous?.plan?.strategy) {
    const label = el('label', '继续上次目标，沿用进展与剩余预算'); continuation = el('input'); continuation.type = 'checkbox';
    label.prepend(continuation); details.append(label);
    continuation.addEventListener('change', () => {
      if (continuation.checked) {
        const plan = run.previous.plan;
        for (const [key, input] of Object.entries(fields)) if (key !== 'budget') input.value = plan[key] || '';
        const remaining = run.previous.remainingMs;
        budget.value = [plan.maxRounds == null ? '' : `${plan.maxRounds}轮`, remaining == null ? '' : `${Math.ceil(remaining / 60000)}分钟`].filter(Boolean).join(' / ') || '不限';
      }
      lock(false);
    });
    const remaining = run.previous.remainingMs;
    details.append(el('p', `上次已用 ${run.previous.round} 轮，剩余时间${remaining == null ? '不限' : ` ${Math.ceil(remaining / 60000)} 分钟`}。`));
  }
  const error = el('p'); error.className = 'form-error'; error.setAttribute('role', 'alert');
  const start = el('button', '开始'); start.type = 'submit'; start.className = 'primary-button';
  form.append(error, start);
  let busy = false, attempt;
  function lock(value) {
    busy = value;
    for (const control of form.querySelectorAll('input, textarea, button')) control.disabled = value;
    if (continuation?.checked) for (const control of [...Object.values(fields), ...choices.querySelectorAll('button')]) control.disabled = true;
  }
  const seen = new Set();
  function update(next) {
    const definition = next.definition;
    if (!busy && !continuation?.checked && definition) {
      for (const [key, input] of Object.entries(fields)) {
        if (!edited.has(input) && typeof definition[key] === 'string') input.value = definition[key];
      }
    }
    for (const value of next.definition?.suggestions || []) {
      if (seen.has(value)) continue;
      seen.add(value); const choice = el('button', value); choice.type = 'button';
      choice.addEventListener('click', () => { edited.add(goal); goal.value = value; }); choices.append(choice);
    }
    lock(busy);
  }
  update(run);
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (busy || !isCurrent()) return;
    const answers = { ...Object.fromEntries(Object.entries(fields).map(([key, input]) => [key, [input.value.trim()]])),
      continuation: [String(Boolean(continuation?.checked))] };
    const signature = JSON.stringify(answers);
    if (attempt?.signature !== signature) attempt = { signature, commandId: crypto.randomUUID() };
    lock(true); error.textContent = '';
    try { await submit(answers, attempt.commandId); }
    catch (failure) { if (!shouldKeepDeliveryAttempt(failure)) attempt = null; error.textContent = failure.message; }
    finally { lock(false); }
  });
  form.updateDefinition = update; form.setPending = lock;
  return form;
}
