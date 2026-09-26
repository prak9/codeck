import { shouldKeepDeliveryAttempt } from './remote-delivery.js?v=5';

// Both views edit the same task contract. Async preparation fills untouched fields.
export function createAutonomyForm({ document, run, submit, isCurrent, cancel }) {
  const el = (tag, text = '') => { const node = document.createElement(tag); node.textContent = text; return node; };
  const form = el('form'); form.className = 'autonomy-definition';
  const field = (label, { required = false, placeholder = '', multiline = false } = {}) => {
    const wrapper = el('label', label), input = el(multiline ? 'textarea' : 'input');
    if (multiline) input.rows = 2; else input.type = 'text'; input.maxLength = 4000;
    input.required = required; input.placeholder = placeholder; input.autocomplete = 'off';
    wrapper.append(input); form.append(wrapper); return input;
  };
  const goal = field('任务描述', { required: true, multiline: true, placeholder: 'Agent 将拟一段任务描述，你也可以直接填写。预算和边界要求写在这里。' });
  goal.rows = 7;
  const fields = { goal };
  const preparation = el('p'); preparation.className = 'form-error'; preparation.setAttribute('role', 'status'); form.append(preparation);
  const edited = new Set();
  for (const input of Object.values(fields)) input.addEventListener('input', () => edited.add(input));
  const error = el('p'); error.className = 'form-error'; error.setAttribute('role', 'alert');
  const actions = el('div'); actions.className = 'autonomy-actions';
  const dismiss = el('button', '取消'); dismiss.type = 'button'; dismiss.addEventListener('click', () => cancel?.());
  const start = el('button', '确认开始'); start.type = 'submit'; start.className = 'primary-button';
  actions.append(dismiss, start); form.append(error, actions);
  let busy = false, attempt;
  function lock(value) {
    busy = value;
    for (const control of form.querySelectorAll('input, textarea, button')) control.disabled = value;
  }
  function update(next) {
    const definition = next.definition;
    preparation.textContent = definition?.loading ? '正在规划任务…' : definition?.error || '';
    preparation.hidden = !preparation.textContent;
    if (!busy && definition) {
      for (const [key, input] of Object.entries(fields)) {
        if (!edited.has(input) && typeof definition[key] === 'string') input.value = definition[key];
      }
    }
    lock(busy);
  }
  update(run);
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (busy || !isCurrent()) return;
    const answers = { goal: [goal.value.trim()], strategy: [''], acceptance: [''], budget: [''], constraints: [''] };
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
