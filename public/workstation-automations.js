const statuses = { active: '已启用', paused: '已暂停', fired: '已触发', done: '已完成', enqueued: '已入队', deduped: '已处理过相同事件',
  cancelled: '已取消', finished: '已结束', dispatching: '正在投递', skipped: '无变化', check_error: '检查失败', pending: '待处理', processing: '正在处理', launched: '会话已启动',
  submitted: '已尝试提交', accepted: '已尝试提交', confirmed: '已确认', failed: '失败', unknown: '送达待核实', unchanged: '无变化', busy: '会话忙碌' };
const label = value => value ? statuses[value] || '状态待核实' : '';
export { label as workstationRunLabel };
const date = value => value ? new Date(value).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

export async function renderAutomations(host, { token, activeSession, openLegacy }) {
  const view = element('section', '', 'ws-automations');
  const toolbar = element('div', '', 'always-on-row');
  const notice = element('p', '', 'always-on-meta');
  notice.setAttribute('role', 'status');
  const list = element('div');
  view.append(toolbar, notice, list);
  host.replaceChildren(view);
  async function request(path, method = 'GET', data) {
    const headers = { Authorization: 'Bearer ' + token() };
    if (data) headers['Content-Type'] = 'application/json';
    const res = await fetch(path, { method, headers, body: data && JSON.stringify(data), cache: 'no-store' });
    const json = res.status === 204 ? null : await res.json();
    if (!res.ok) throw Error(json.error || '请求失败 ' + res.status);
    return json;
  }
  function button(text, action, primary = false) {
    const node = element('button', text, 'always-on-btn' + (primary ? ' primary' : ''));
    node.type = 'button';
    node.onclick = async () => {
      if (node.disabled) return;
      node.disabled = true;
      try { await action(node); } catch (error) { notice.textContent = error.message; }
      finally { node.disabled = false; }
    };
    return node;
  }
  const base = '/api/workstation/automations';
  let generation = 0;
  async function showList() {
    const ticket = ++generation;
    const { rules, conditional } = await request(base);
    if (ticket !== generation) return;
    list.replaceChildren();
    const other = element('details');
    other.append(element('summary', '更多'), button('新建条件规则', () => conditionForm({ prompt: '', everyMinutes: 30 }, true)),
      button('原有提醒与设置', node => openLegacy(node)));
    toolbar.replaceChildren(button('新建规则', () => showForm(), true), other);
    if (!rules.length && !conditional.length) list.append(element('p', '还没有自动化规则。', 'always-on-empty'));
    for (const rule of [...rules, ...conditional]) {
      const condition = Object.hasOwn(rule, 'everyMinutes');
      const status = condition ? (rule.enabled ? 'active' : 'paused') : rule.status;
      const title = condition ? rule.prompt : rule.reason;
      const path = (condition ? '/api/workstation/conditions' : base) + '/' + encodeURIComponent(rule.id);
      const card = element('article', '', 'always-on-card');
      const head = element('div', '', 'always-on-card-head');
      head.append(element('strong', title), element('span', label(status), 'always-on-pill'));
      const schedule = rule.payload?.calendar;
      const every = condition ? rule.everyMinutes : rule.recurrenceMs / 60000;
      const when = schedule ? (schedule.weekdays ? '工作日 ' : '每天 ') + schedule.time + ' · ' + schedule.timeZone : every ? '每 ' + every + ' 分钟' : '一次';
      const meta = [rule.session || rule.sessionName || rule.cwd || rule.scopeKey, when, status === 'active' && '下次 ' + date(rule.nextAt ?? rule.dueAt),
        label(rule.last?.status || rule.lastStatus)].filter(Boolean);
      card.append(head, element('p', meta.join(' · '), 'always-on-meta'));
      const detail = element('div', '', 'always-on-meta');
      detail.setAttribute('role', 'status');
      const row = element('div', '', 'always-on-row');
      const more = element('details');
      const secondary = element('div', '', 'always-on-row');
      more.append(element('summary', '更多操作'), secondary);
      const form = copy => condition ? conditionForm(rule, copy) : showForm(rule, copy);
      if (status !== 'done') row.append(button('编辑', () => form(false)));
      row.append(button('运行记录', async () => {
        const { runs } = await request(path + '/runs');
        detail.replaceChildren(...runs.map(run => element('p', [date(run.at ?? run.checkedAt ?? run.dueAt), label(run.status), label(run.dispatchStatus), run.sessionName, run.error].filter(Boolean).join(' · '))));
        if (!runs.length) detail.textContent = '暂无运行记录';
      }));
      if (status !== 'done') row.append(button(status === 'active' ? '暂停' : '启用', async () => {
        await request(path, 'PATCH', { enabled: status !== 'active' }); await showList();
      }));
      let manualId;
      if (status === 'active') row.append(button('立即运行', async () => {
        manualId ||= crypto.randomUUID();
        const result = await request(path + '/run', 'POST', { requestId: manualId });
        detail.textContent = '手动检查 · ' + label(result.status || 'enqueued'); manualId = null;
      }));
      if (!condition) secondary.append(button('试算', async () => { detail.textContent = describe(await request(path + '/preview')); }));
      if (condition || rule.payload?.workstation) secondary.append(button('复制为新规则', () => form(true)));
      secondary.append(button('删除', async () => {
        if (!window.confirm('删除「' + title + '」？已开始的任务会继续。')) return;
        await request(path, 'DELETE', { version: (condition ? rule.version : rule.payload?.version) ?? 0 });
        notice.textContent = '已删除规则'; await showList();
      }));
      card.append(row, more, detail); list.append(card);
    }
  }
  function describe(plan) {
    return [plan.mode === 'legacy' ? '原有提醒' : plan.mode === 'script' ? '运行 Bot 脚本' : plan.mode === 'follow_up' ? '跟进原任务' : '新建独立任务会话', plan.sessionName, plan.provider,
      plan.cwd, '首次检查 ' + date(plan.dueAt)].filter(Boolean).join(' · ');
  }
  function field(form, title, tag, name, type) {
    const wrap = element('label', title), node = element(tag, '', 'always-on-field');
    node.name = name;
    if (type) node.type = type;
    wrap.append(node); form.append(wrap);
    return node;
  }

  async function showForm(rule = null, copy = false) {
    const ticket = ++generation;
    const [{ sessions }, { bots, tasks }, { scripts }] = await Promise.all([request('/api/sessions'), request('/api/workstation'), request(base + '/scripts')]);
    if (ticket !== generation) return;
    const form = element('form', '', 'always-on-card');
    const editing = rule && !copy;
    const plan = rule?.payload?.workstation;
    const legacy = rule && !plan;
    const path = editing ? base + '/' + encodeURIComponent(rule.id) : base;
    notice.textContent = '';
    form.append(element('h3', editing ? '编辑规则' : '新建规则'));
    const reason = field(form, '执行事项', 'textarea', 'reason');
    reason.value = rule?.reason ?? ''; reason.maxLength = 2000;
    reason.required = true;
    const origin = field(form, '执行来源', 'select', 'source');
    const options = [];
    function add(title, target, extra) {
      const option = element('option', title);
      option.value = String(options.length);
      origin.append(option); options.push({ target, ...extra });
    }
    if (legacy) add('原有提醒 · ' + (rule.sessionName || rule.scopeKey), null);
    else add('指定项目 · 按需新建会话', null, { project: true });
    const templates = sessions.filter(s => s.agent?.id && ['codex','claude','qodercli'].includes(s.agent.kind));
    for (const s of templates) {
      const target = { session: s.name, provider: s.agent.kind, threadId: s.agent.id, createdAt: s.createdAt };
      add(s.name + ' · 独立会话', target);
    }
    if (!legacy) for (const bot of bots) add(bot.name + ' · Bot 独立会话', bot.target, { botId: bot.id });
    if (!legacy) for (const script of scripts) {
      const bot = bots.find(bot => bot.id === script.botId);
      if (bot) add(bot.name + ' · ' + script.script + ' → @' + script.username, bot.target,
        { botId: bot.id, channelId: script.channelId, script: script.script });
    }
    if (!legacy) for (const task of tasks.filter(t => ['planned', 'active'].includes(t.status))) add(task.title + ' · 跟进任务', task.runs.at(-1)?.target || task.target, { taskId: task.id });
    if (plan?.target) {
      const index = options.findIndex(o => o.target && o.target.session === plan.target.session && o.target.threadId === plan.target.threadId
        && o.target.createdAt === plan.target.createdAt && (o.botId ?? null) === (plan.botId ?? null)
        && (o.taskId ?? null) === (plan.taskId ?? null) && o.script === plan.script && o.channelId === plan.channelId);
      if (index >= 0) origin.selectedIndex = index;
      else if (!copy || plan.botId || plan.taskId) {
        add('原绑定 · ' + plan.target.session + (plan.script ? ' · ' + plan.script : ''), plan.target,
          { botId: plan.botId, taskId: plan.taskId, script: plan.script, channelId: plan.channelId });
        origin.selectedIndex = options.length - 1;
      }
    }
    const active = templates.find(s => s.name === activeSession());
    const cwd = field(form, '项目目录', 'input', 'cwd', 'text');
    cwd.placeholder = '/data/code/my-project';
    cwd.value = rule?.cwd || active?.agent.cwd || active?.cwd || '';
    const provider = field(form, '执行 Agent', 'select', 'provider');
    for (const [value, name] of [['codex', 'Codex'], ['claude', 'Claude Code'], ['qodercli', 'Qoder CLI']]) {
      const option = element('option', name); option.value = value; provider.append(option);
    }
    provider.value = rule?.provider || active?.agent.kind || 'codex';
    const repeat = field(form, '触发时间', 'select', 'schedule');
    for (const [value, name] of [['once','一次'],['interval','每隔一段时间'],['daily','每天'],['weekdays','工作日']]) {
      const option = element('option', name); option.value = value; repeat.append(option);
    }
    const start = field(form, '首次检查（本地时间）', 'input', 'start', 'datetime-local');
    const now = new Date(editing ? rule.dueAt : Date.now() + 30 * 60_000);
    start.value = new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0,19);
    start.step = 'any';
    const initialStart = start.value;
    const interval = field(form, '间隔（分钟）', 'input', 'interval', 'number'); interval.min = '0.16666666666666666'; interval.step = 'any'; interval.value = rule?.recurrenceMs ? String(rule.recurrenceMs / 60000) : '30';
    const clock = field(form, '执行时间', 'input', 'clock', 'time'); clock.value = rule?.payload?.calendar?.time || '09:00';
    const tz = field(form, '时区', 'input', 'timeZone', 'text'); tz.value = rule?.payload?.calendar?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    repeat.value = rule?.payload?.calendar ? (rule.payload.calendar.weekdays ? 'weekdays' : 'daily') : rule?.recurrenceMs ? 'interval' : 'once';
    const initialRepeat = repeat.value;
    repeat.onchange = () => {
      const calendar = ['daily','weekdays'].includes(repeat.value);
      interval.parentElement.hidden = repeat.value !== 'interval';
      start.disabled = start.parentElement.hidden = calendar;
      start.required = !calendar; interval.disabled = repeat.value !== 'interval'; interval.required = !interval.disabled;
      clock.disabled = tz.disabled = clock.parentElement.hidden = tz.parentElement.hidden = !calendar; clock.required = tz.required = calendar;
    };
    origin.onchange = () => {
      const source = options[origin.selectedIndex];
      cwd.disabled = cwd.parentElement.hidden = provider.disabled = provider.parentElement.hidden = !source.project;
      cwd.required = Boolean(source.project);
      const follow = Boolean(source.taskId);
      for (const entry of repeat.options) entry.disabled = follow && entry.value !== 'once';
      if (follow) repeat.value = 'once';
      repeat.onchange();
    };
    origin.onchange();
    const extra = element('details');
    extra.append(element('summary', '条件检查（可选）'));
    const check = field(form, '命令及参数（JSON 数组，程序使用绝对路径）', 'input', 'check', 'text');
    if (rule?.check) { check.value = JSON.stringify(rule.check); extra.open = true; }
    extra.append(check.parentElement); form.append(extra);
    function input() {
      if (!form.reportValidity()) return null;
      const selected = options[origin.selectedIndex];
      if (!selected) throw Error('请先打开一个支持派工的 Agent 会话');
      const source = selected.project ? { project: { cwd: cwd.value.trim(), provider: provider.value } } : { ...selected, sessionName: selected.target?.session };
      const body = { ...source, reason: reason.value.trim() };
      if (editing) body.version = rule.payload.version ?? 0;
      if (['daily','weekdays'].includes(repeat.value)) body.calendar = { time: clock.value, timeZone: tz.value.trim(), weekdays: repeat.value === 'weekdays' };
      else if (!editing || repeat.value !== initialRepeat || start.value !== initialStart) body.dueAt = new Date(start.value).getTime();
      if (repeat.value === 'interval') body.recurrenceMs = Math.round(interval.valueAsNumber * 60_000);
      if (check.value.trim()) {
        try { body.check = JSON.parse(check.value); } catch { throw Error('请输入有效的 JSON 参数数组'); }
      }
      return body;
    }
    form.onsubmit = event => event.preventDefault();
    let savedInput, requestId;
    const actions = element('div', '', 'always-on-row');
    actions.append(button('试算', async () => { const body = input(); if (body) notice.textContent = describe(await request(path + '/preview', 'POST', body)); }),
      button('保存规则', async () => {
        const body = input(); if (!body) return;
        const fingerprint = JSON.stringify(body);
        if (fingerprint !== savedInput) { savedInput = fingerprint; requestId = crypto.randomUUID(); }
        await request(path, editing ? 'PUT' : 'POST', editing ? body : { ...body, requestId }); notice.textContent = '规则已保存'; await showList();
      }, true));
    form.append(actions); toolbar.replaceChildren(button('返回规则', showList)); list.replaceChildren(form); reason.focus();
  }
  async function conditionForm(rule, copy) {
    const ticket = ++generation;
    const { sessions } = await request('/api/sessions');
    if (ticket !== generation) return;
    const form = element('form', '', 'always-on-card');
    form.append(element('h3', copy ? '新建条件规则' : '编辑条件规则'));
    const prompt = field(form, '执行事项', 'textarea', 'prompt'); prompt.required = true; prompt.value = rule.prompt;
    const session = field(form, '执行会话', 'select', 'session');
    const targets = sessions.filter(s => s.agent?.id && ['codex','claude','qodercli'].includes(s.agent.kind));
    for (const target of targets) {
      const option = element('option', target.name); option.value = target.name; session.append(option);
    }
    session.value = rule.session ? (targets.some(s => s.name === rule.session && s.agent.id === rule.threadId) ? rule.session : '') : activeSession();
    session.required = true;
    const minutes = field(form, '间隔（分钟）', 'input', 'minutes', 'number'); minutes.value = rule.everyMinutes; minutes.required = true; minutes.step = 'any';
    const cwd = field(form, '检查目录', 'input', 'cwd', 'text'); const projectDir = () => { const target = targets.find(s => s.name === session.value); return target?.agent.cwd || target?.cwd || ''; };
    cwd.value = rule.cwd || projectDir(); cwd.required = true; session.onchange = () => { cwd.value = projectDir(); };
    const check = field(form, '条件检查命令及参数（JSON 数组）', 'input', 'check', 'text'); check.value = rule.check ? JSON.stringify(rule.check) : ''; check.required = true;
    const id = copy ? crypto.randomUUID() : rule.id;
    form.onsubmit = event => event.preventDefault();
    form.append(button('保存规则', async () => {
      if (!form.reportValidity()) return;
      const target = targets.find(s => s.name === session.value);
      let argv;
      try { argv = JSON.parse(check.value); } catch { throw Error('请输入有效的 JSON 参数数组'); }
      const value = { session: target.name, provider: target.agent.kind, threadId: target.agent.id, version: rule.version ?? 0,
        cwd: cwd.value, everyMinutes: minutes.valueAsNumber, prompt: prompt.value, check: argv };
      await request('/api/workstation/conditions/' + encodeURIComponent(id), copy ? 'POST' : 'PUT', value);
      notice.textContent = '规则已保存'; await showList();
    }, true));
    notice.textContent = ''; toolbar.replaceChildren(button('返回规则', showList)); list.replaceChildren(form); prompt.focus();
  }
  try { await showList(); } catch (error) {
    notice.textContent = error.message; toolbar.replaceChildren(button('重试', showList));
  }
}
