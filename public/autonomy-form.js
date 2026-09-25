import { taskPreview } from './autonomy-definition.js?v=1';
import { shouldKeepDeliveryAttempt } from './remote-delivery.js?v=5';

// Both views edit the same task contract. Async suggestions only add choices.
export function createAutonomyForm({ document, run, submit, isCurrent }) {
  const el = (tag, text = '') => { const node = document.createElement(tag); node.textContent = text; return node; };
  const form = el('form'); form.className = 'autonomy-definition';
  const field = (label, { required = false, placeholder = '', multiline = false } = {}) => {
    const wrapper = el('label', label), input = el(multiline ? 'textarea' : 'input');
    if (multiline) input.rows = 2; else input.type = 'text'; input.maxLength = 4000;
    input.required = required; input.placeholder = placeholder; input.autocomplete = 'off';
    wrapper.append(input); form.append(wrapper); return input;
  };
  const goal = field('目标', { required: true, placeholder: '选择下方建议，或输入具体目标' });
  const choices = el('div'); choices.className = 'autonomy-goals'; goal.parentElement.after(choices);
  const budgetField = el('fieldset'), legend = el('legend', '预算'); budgetField.append(legend);
  const budgets = [['15 分钟', '15 分钟'], ['30 分钟', '30 分钟'], ['1 小时', '60 分钟'], ['不限', '不限'], ['自定义', 'custom']];
  const radios = budgets.map(([label, value]) => {
    const wrap = el('label', label), radio = el('input'); radio.type = 'radio'; radio.name = 'budget'; radio.value = value;
    radio.checked = value === '30 分钟'; wrap.prepend(radio); budgetField.append(wrap); return radio;
  });
  form.append(budgetField);
  const custom = field('自定义分钟数', { placeholder: '正整数' }); custom.inputMode = 'numeric'; custom.parentElement.hidden = true;
  for (const radio of radios) radio.addEventListener('change', () => { custom.parentElement.hidden = radio.value !== 'custom'; });
  const constraints = field('补充约束（可选）', { placeholder: '有什么必须保持，或不能改的？' });
  const acceptance = field('怎样算有效', { required: true, multiline: true });
  const deliverable = field('结束后得到', { required: true, multiline: true });
  const edited = new Set();
  for (const input of [acceptance, deliverable]) input.addEventListener('input', () => edited.add(input));
  const preview = () => {
    const values = taskPreview(goal.value);
    if (!edited.has(acceptance)) acceptance.value = values.acceptance;
    if (!edited.has(deliverable)) deliverable.value = values.deliverable;
  };
  goal.addEventListener('input', preview);
  const details = el('details'); details.append(el('summary', '详细设置'));
  const rounds = field('轮数上限（可选）', { placeholder: '留空不限制轮数' }); rounds.inputMode = 'numeric';
  details.append(rounds.parentElement, el('p', '范围继承当前项目和既有权限；方法由 Agent 根据结果调整。')); form.append(details);
  let continuation;
  if (run.previous?.plan?.deliverable) {
    const label = el('label', '继续上次目标，沿用进展与剩余预算'); continuation = el('input'); continuation.type = 'checkbox';
    label.prepend(continuation); details.append(label);
    continuation.addEventListener('change', () => {
      if (continuation.checked) {
        const plan = run.previous.plan;
        goal.value = plan.goal; acceptance.value = plan.acceptance; deliverable.value = plan.deliverable; constraints.value = plan.constraints || '';
        const remaining = run.previous.remainingMs;
        for (const radio of radios) radio.checked = radio.value === (remaining == null ? '不限' : 'custom');
        custom.value = remaining == null ? '' : String(Math.ceil(remaining / 60000));
        custom.parentElement.hidden = remaining == null;
        rounds.value = plan.maxRounds == null ? '' : String(plan.maxRounds);
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
    if (continuation?.checked) for (const control of [goal, constraints, acceptance, deliverable, rounds, custom, ...radios, ...choices.querySelectorAll('button')]) control.disabled = true;
  }
  const seen = new Set();
  function update(next) {
    for (const value of next.definition?.suggestions || []) {
      if (seen.has(value)) continue;
      seen.add(value); const choice = el('button', value); choice.type = 'button';
      choice.addEventListener('click', () => { goal.value = value; preview(); }); choices.append(choice);
    }
    lock(busy);
  }
  update(run);
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (busy || !isCurrent()) return;
    const budget = radios.find(input => input.checked)?.value;
    const answers = { goal: [goal.value.trim()], budget: [budget === 'custom' ? `${custom.value.trim()} 分钟` : budget],
      constraints: [constraints.value.trim()], acceptance: [acceptance.value.trim()], deliverable: [deliverable.value.trim()],
      rounds: [rounds.value.trim()], continuation: [String(Boolean(continuation?.checked))] };
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
