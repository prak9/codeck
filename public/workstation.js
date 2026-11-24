import { reconcileChildOrder } from './keyed-children.js?v=1';
import { renderAutomations, workstationRunLabel } from './workstation-automations.js?v=4';

const base = '/api/workstation';
const statuses = { planned: '待开始', active: '进行中', delivered: '已交付', stopped: '已停止' };

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function button(text, action, className) {
  const node = el('button', text, className);
  node.type = 'button';
  node.addEventListener('click', () => action(node));
  return node;
}

function field(label, input) {
  const node = el('label', label);
  input.setAttribute('aria-label', label);
  node.append(input);
  return node;
}

function option(text, value) {
  const node = el('option', text);
  node.value = value;
  return node;
}

export function workstationTarget(session) {
  if (!session?.name || !session.agent?.kind || !session.agent?.id || !Number.isSafeInteger(session.createdAt) || session.createdAt <= 0) return null;
  return { session: session.name, provider: session.agent.kind, threadId: session.agent.id, createdAt: session.createdAt };
}

export function sameWorkstationTarget(a, b) {
  return Boolean(a && b && a.session === b.session && a.provider === b.provider && a.threadId === b.threadId && a.createdAt === b.createdAt);
}

export function bindWorkstation({ host, token, enabled, active, sessions, openSession, openDrawer, closeDrawer, newSession, openLegacy }) {
  const nav = document.getElementById('workstationNav');
  const botsToggle = document.getElementById('botsToggle'), botsList = document.getElementById('stationBots');
  const panel = el('section', null, 'station-panel'); panel.hidden = true;
  panel.setAttribute('aria-labelledby', 'stationTitle');
  panel.innerHTML = '<div class="station-inner"><header class="station-heading"><h2 id="stationTitle" tabindex="-1"></h2><div class="station-actions" data-tools></div></header><p class="station-error" role="status" hidden></p><div data-body></div></div>';
  host.append(panel);
  const heading = panel.querySelector('h2'), tools = panel.querySelector('[data-tools]'), body = panel.querySelector('[data-body]'), error = panel.querySelector('[role=status]');
  let tasks = [], bots = [], authenticated = '', timer, generation = 0;
  let route = null, opener = null, revision = 0, inflight, loaded = false, pendingRead = 0;
  const expanded = new Set(), inerted = new Set();
  const legacy = new URLSearchParams(location.search).get('workstation') === 'legacy';
  const automationButton = document.getElementById('alwaysOnButton');
  const pageKey = Math.random().toString(36).slice(2);
  let depth = 0;
  const newSessionDialog = document.querySelector('#newSessionDialog, #newDialog');
  const available = () => Boolean(enabled() && token());

  async function request(url, method = 'GET', value) {
    const owner = token();
    const response = await fetch(url, { method, headers: { Authorization: `Bearer ${owner}`, ...(value ? { 'Content-Type': 'application/json' } : {}) }, ...(value ? { body: JSON.stringify(value) } : {}) });
    if (!available() || owner !== token()) throw new Error('登录状态已变化，请重新打开。');
    const result = response.status === 204 ? {} : await response.json();
    if (!response.ok) throw new Error(result.error || `请求失败（${response.status}）`);
    return result;
  }

  function showError(message) {
    error.hidden = !message;
    error.textContent = message || '';
  }

  function withAction(control, action) {
    const current = revision;
    control.disabled = true; showError('');
    return Promise.resolve().then(action).catch(e => {
      if (current === revision) showError(e.message);
    }).finally(() => { control.disabled = false; });
  }

  function action(text, fn, style) {
    return button(text, control => withAction(control, () => fn(control)), style);
  }

  function refresh() {
    if (inflight) return inflight;
    const owner = generation;
    const job = request(base).then(snapshot => {
      if (owner !== generation) return;
      tasks = snapshot.tasks; bots = snapshot.bots;
      loaded = true;
      renderBots();
    }).finally(() => { if (inflight === job) inflight = null; });
    inflight = job;
    return job;
  }

  async function mutation(path, method, value) {
    const result = await request(base + path, method, value);
    // A poll already in flight may have read the pre-mutation snapshot.
    if (inflight) await inflight.catch(() => {});
    await refresh();
    return result;
  }

  function stopView() {
    revision++; route = null; depth = 0;
    panel.hidden = true; syncNavigation();
    for (const node of inerted) node.inert = false;
    inerted.clear();
    if (opener?.isConnected && opener.getBoundingClientRect().right > 0 && opener.getClientRects().length) opener.focus({ preventScroll: true });
    else document.querySelector('#drawerButton, #menuButton')?.focus({ preventScroll: true });
    opener = null;
  }

  function close() {
    if (!route) return Promise.resolve();
    const steps = depth;
    stopView();
    if (history.state?.stationKey !== pageKey || !steps) return Promise.resolve();
    return new Promise(resolve => { window.addEventListener('popstate', resolve, { once: true }); history.go(-steps); });
  }

  function back() {
    if (depth > 1 && history.state?.stationKey === pageKey) history.back();
    else close();
  }

  function present(next, trigger) {
    if (!available()) return;
    if (!route) {
      opener = trigger || document.activeElement;
      for (const child of host.children) {
        if (child !== panel && child.tagName !== 'DIALOG' && !child.inert) { child.inert = true; inerted.add(child); }
      }
    }
    closeDrawer();
    route = next; revision++; panel.hidden = false;
    syncNavigation();
    paint();
    heading.focus({ preventScroll: true });
  }

  function navigate(next, trigger, replace = false) {
    if (!available()) return;
    if (replace && route) history.replaceState({ ...history.state, stationKey: pageKey, stationRoute: next, stationDepth: depth }, '');
    else {
      depth++;
      history.pushState({ ...history.state, stationKey: pageKey, stationRoute: next, stationDepth: depth }, '');
    }
    present(next, trigger);
  }

  window.addEventListener('popstate', event => {
    if (available() && event.state?.stationKey === pageKey) {
      depth = event.state.stationDepth; present(event.state.stationRoute);
    } else if (route) stopView();
  });
  panel.addEventListener('keydown', event => { if (event.key === 'Escape' && !document.querySelector('dialog[open]')) { event.preventDefault(); back(); } });

  async function freshSessions() {
    const result = await request('/api/sessions');
    return result.sessions;
  }

  async function jump(target, anchor = '') {
    const current = revision;
    const found = (await freshSessions()).find(session => sameWorkstationTarget(workstationTarget(session), target));
    if (current !== revision) return;
    if (!found) throw new Error('来源会话已结束或已更换。历史任务和已关联成果仍可查看。');
    const previous = route, trigger = opener;
    await close();
    try { await openSession(target, anchor); }
    catch (e) {
      if (!previous) throw e;
      navigate(previous, trigger); showError(e.message);
    }
  }

  function syncNavigation() {
    for (const entry of nav.querySelectorAll('[aria-current]')) entry.removeAttribute('aria-current');
    if (!route) return;
    if (route.view === 'automations') automationButton.setAttribute('aria-current', 'page');
    else {
      botsToggle.setAttribute('aria-current', 'location');
      const control = route.view === 'bind' ? document.getElementById('bindBotButton')
        : botsList.querySelector(`[data-focus-key="${route.view === 'detail' ? 'task' : 'manage'}:${CSS.escape(route.id)}"]`);
      control?.setAttribute('aria-current', 'page');
    }
  }

  function renderBots() {
    const focusKey = botsList.contains(document.activeElement) ? document.activeElement.dataset.focusKey : '';
    const nodes = [];
    for (const bot of bots) {
      const row = el('div', null, 'station-bot-row');
      const home = button(bot.name, async control => {
        const current = revision; control.disabled = true;
        try { await jump(bot.target); }
        catch (e) {
          if (current === revision) { if (!route) navigate({ view: 'bot', id: bot.id }, control); showError(e.message); }
        } finally { control.disabled = false; }
      }, 'station-bot');
      home.title = `打开 ${bot.name} 的主会话 · ${bot.target.session}`;
      home.dataset.focusKey = 'bot:' + bot.id;
      const opened = expanded.has(bot.id);
      const arrow = button('', () => { if (opened) expanded.delete(bot.id); else expanded.add(bot.id); renderBots(); }, 'station-twist');
      arrow.append(el('span', '', 'station-chevron'));
      arrow.dataset.focusKey = 'expand:' + bot.id;
      arrow.setAttribute('aria-expanded', String(opened)); arrow.setAttribute('aria-label', `${opened ? '收起' : '展开'} ${bot.name} 的任务`);
      row.append(arrow, home); nodes.push(row);
      if (opened) {
        const children = el('div', null, 'station-children');
        for (const task of tasks.filter(item => item.botId === bot.id && !['delivered', 'stopped'].includes(item.status))) {
          const entry = button(task.title, control => navigate({ view: 'detail', id: task.id }, control), 'station-child');
          entry.dataset.focusKey = 'task:' + task.id; entry.title = task.title; children.append(entry);
        }
        const manage = button('管理 Bot', control => navigate({ view: 'bot', id: bot.id }, control), 'station-child');
        manage.dataset.focusKey = 'manage:' + bot.id; children.append(manage); nodes.push(children);
      }
    }
    botsList.replaceChildren(...nodes);
    syncNavigation();
    if (focusKey) [...botsList.querySelectorAll('button')].find(node => node.dataset.focusKey === focusKey)?.focus({ preventScroll: true });
  }

  function taskRow(task) {
    const row = button('', control => navigate({ view: 'detail', id: task.id }, control), 'station-item');
    const bot = bots.find(b => b.id === task.botId);
    row.append(el('strong', task.title), el('span', [bot?.name || task.target.session, statuses[task.status], task.progress].filter(Boolean).join(' · '), 'station-meta'));
    return row;
  }

  function renderPending(item) {
    const card = el('article', null, 'station-card');
    card.append(el('small', `${item.target.session} · ${item.kind === 'approval' ? '待审批' : '待回答'}`, 'station-meta'), el('p', item.text));
    const actions = el('div', null, 'station-actions');
    const send = async value => {
      await request(base + '/pending/answer', 'POST', { key: item.key, target: item.target, ...value });
      await refreshPending();
    };
    if (!item.actionable) actions.append(action('回到来源会话', () => jump(item.target)));
    else if (item.kind === 'approval') {
      actions.append(action('允许', () => send({ decision: 'accept' })), action('拒绝', () => send({ decision: 'decline' })));
    } else if (item.options?.length) {
      for (const answer of item.options) actions.append(action(answer, () => send({ answer })));
    } else {
      const form = el('form'), input = el('input'); input.required = true;
      form.append(field('回答', input)); submit(form, '发送回答', () => send({ answer: input.value }));
      card.append(form);
    }
    card.append(actions);
    return card;
  }

  async function refreshPending() {
    if (route?.view !== 'detail') return;
    const group = body.querySelector('[data-pending]');
    const target = tasks.find(task => task.id === route.id)?.target;
    if (!group || !target) return;
    const ticket = ++pendingRead, current = revision;
    const status = group.querySelector('[role=status]');
    let items;
    try {
      const result = await request(base + '/pending');
      if (current !== revision || ticket !== pendingRead) return;
      items = result.items.filter(item => sameWorkstationTarget(item.target, target));
      const note = sessions().find(session => sameWorkstationTarget(workstationTarget(session), target))?.checkpoint;
      if (!items.length && !note?.stale && note?.progress?.needsUser) {
        items.push({ kind: 'note', target, text: note.progress.needsUser, actionable: false });
      }
      status.hidden = true;
    } catch (e) {
      if (current !== revision || ticket !== pendingRead) return;
      status.textContent = e.message; status.hidden = false;
      group.hidden = false; group.lastElementChild.replaceChildren();
      return;
    }
    const entries = group.lastElementChild;
    const existing = new Map([...entries.children].map(node => [node.pendingFingerprint, node]));
    const nodes = items.map(item => {
      const fingerprint = JSON.stringify(item);
      if (existing.has(fingerprint)) return existing.get(fingerprint);
      const card = renderPending(item); card.pendingFingerprint = fingerprint;
      return card;
    });
    reconcileChildOrder(entries, nodes);
    group.hidden = !items.length;
  }

  function submit(form, label, fn) {
    const save = el('button', label, 'station-primary'); save.type = 'submit'; form.append(save);
    form.addEventListener('submit', event => { event.preventDefault(); if (!save.disabled) void withAction(save, fn); });
  }

  async function bindBotForm() {
    const here = revision;
    const form = el('form'), title = el('input'), picker = el('select'), purpose = el('textarea');
    title.required = true; title.maxLength = 256; picker.required = true; purpose.maxLength = 2048;
    async function refreshChoices() {
      const result = await freshSessions();
      if (here !== revision) return;
      const before = picker.value, choices = [];
      for (const session of result) {
        const target = workstationTarget(session);
        if (target) choices.push(option(session.name, JSON.stringify(target)));
      }
      picker.replaceChildren(option('选择已就绪的 Agent 会话', ''), ...choices);
      if (before && choices.some(choice => choice.value === before)) picker.value = before;
    }
    await refreshChoices();
    if (here !== revision) return;
    form.append(field('Bot 名称', title), field('主会话', picker), button('新建会话…', () => {
      newSessionDialog.addEventListener('close', () => { if (here === revision) void withAction(picker, refreshChoices); }, { once: true });
      newSession();
    }), action('刷新会话', refreshChoices), field('职责', purpose));
    submit(form, '绑定 Bot', async () => {
      if (!picker.value || !title.value.trim()) throw new Error('请填写名称并选择现有会话。');
      const saved = await mutation('/bots', 'POST', { name: title.value.trim(), purpose: purpose.value.trim(), target: JSON.parse(picker.value) });
      if (here === revision) navigate({ view: 'bot', id: saved.id }, null, true);
    });
    body.append(form);
  }

  function filePath(name) { return `/api/sessions/${encodeURIComponent(name)}/workfiles`; }

  async function chooseOutput(task, card) {
    const current = revision;
    const sources = [{ target: task.target }, ...(task.runs || []).filter(run => !sameWorkstationTarget(run.target, task.target))];
    const catalog = await Promise.allSettled(sources.map(({ target }) => request(filePath(target.session) + '?' +
      new URLSearchParams({ workCreated: target.createdAt, workProvider: target.provider, workThread: target.threadId }))));
    if (current !== revision) return;
    const select = el('select');
    for (const [index, result] of catalog.entries()) {
      if (result.status !== 'fulfilled') continue;
      const source = sources[index];
      for (const item of result.value.items.filter(record => record.kind === 'result')) {
        for (const version of [...item.versions].reverse()) {
          if (task.outputs.some(out => out.itemId === item.id && out.versionId === version.id)) continue;
          const ref = { itemId: item.id, versionId: version.id, ...(source.id ? { runId: source.id } : {}) };
          select.append(option(`${item.title} · ${version.revision || version.at || version.id} · ${source.target.session}`, JSON.stringify(ref)));
        }
      }
    }
    const failures = catalog.flatMap((result, index) => result.status === 'rejected' ? [sources[index].target.session + '：' + result.reason.message] : []);
    if (failures.length) showError(failures.join('\n'));
    if (!select.options.length) { card.replaceChildren(el('p', '暂无可关联的成果版本。', 'station-empty'), action('重新读取', () => chooseOutput(task, card))); return; }
    const form = el('form'); form.append(field('选择成果版本', select));
    submit(form, '关联此版本', async () => { await mutation('/tasks/' + task.id, 'PATCH', { output: JSON.parse(select.value) }); if (current === revision) paint(); });
    card.replaceChildren(form); select.focus();
  }

  function outputCard(task, out) {
    const card = el('div', null, 'station-card');
    card.append(el('strong', out.title), el('p', [out.revision || out.versionId, out.evidence?.summary || '未附验证记录'].join(' · '), 'station-meta'));
    if (out.evidence?.checks?.length) {
      const checks = el('ul');
      for (const check of out.evidence.checks) checks.append(el('li', [check.method, ({ passed: '通过', failed: '失败', 'not-run': '未执行' })[check.result], check.reference].filter(Boolean).join(' · ')));
      card.append(checks);
    }
    if (out.evidence?.limitations?.length) card.append(el('p', '未验证：' + out.evidence.limitations.join('、')));
    const linkTo = (label, url) => {
      const urlObject = new URL(url, location.origin);
      if (!['http:', 'https:'].includes(urlObject.protocol)) throw new Error('链接格式无效。');
      const a = el('a', label); a.href = urlObject.href; a.target = '_blank'; a.rel = 'noopener noreferrer'; return a;
    };
    if (out.url) card.append(linkTo('打开来源链接', out.url));
    else card.append(action('下载此版本', async control => {
      const files = await request(filePath(out.session || task.target.session) + '?' + new URLSearchParams({ archive: out.identity }));
      const version = files.items.find(i => i.id === out.itemId)?.versions.find(v => v.id === out.versionId);
      if (!version?.downloadUrl) throw new Error('此版本文件暂不可用。');
      if (control.isConnected) {
        const a = linkTo('下载此版本', version.downloadUrl);
        a.download = out.fileName || ''; a.target = '_self';
        card.append(a); a.click(); a.remove();
      }
    }));
    return card;
  }

  function detail(task) {
    body.append(el('p', [task.target.session, bots.find(b => b.id === task.botId)?.name, statuses[task.status]].filter(Boolean).join(' · '), 'station-meta'));
    const actions = el('div', null, 'station-actions');
    actions.append(action('打开来源会话', () => jump(task.target, task.anchor)));
    body.append(actions);
    const pending = el('section'), statusMessage = el('p', null, 'station-error');
    pending.dataset.pending = ''; pending.hidden = true;
    statusMessage.setAttribute('role', 'status'); statusMessage.hidden = true;
    pending.append(el('h3', '来源会话待你处理'), statusMessage, el('div')); body.append(pending);
    void refreshPending();
    if (task.progress) body.append(el('h3', '进展'), el('p', task.progress));
    body.append(el('h3', '当次成果'));
    for (const out of task.outputs) body.append(outputCard(task, out));
    if (!task.outputs.length) body.append(el('p', '尚未关联成果。', 'station-empty'));
    const pick = el('div'); pick.append(action('关联成果版本', () => chooseOutput(task, pick))); body.append(pick);
    const runs = task.runs || [];
    if (runs.length) {
      body.append(el('h3', '执行记录'));
      for (const run of runs) {
        const row = el('div', null, 'station-card');
        row.append(el('p', [run.target?.session, workstationRunLabel(run.status), run.summary].filter(Boolean).join(' · '), 'station-meta'));
        row.append(action('打开执行会话', () => jump(run.target))); body.append(row);
      }
    }
    const edit = el('details'); edit.append(el('summary', '更新任务'));
    const form = el('form'), status = el('select'), progress = el('textarea');
    for (const [value, label] of Object.entries(statuses)) status.append(option(label, value));
    status.value = task.status; progress.value = task.progress || '';
    form.append(field('任务状态', status), field('进展', progress));
    const current = revision;
    submit(form, '保存', async () => {
      const changes = {};
      if (status.value !== task.status) changes.status = status.value;
      if (progress.value.trim() !== task.progress) changes.progress = progress.value.trim();
      if (Object.keys(changes).length) await mutation('/tasks/' + task.id, 'PATCH', changes);
      if (current === revision) paint();
    });
    edit.append(form); body.append(edit);
  }

  function botDetails(bot) {
    const current = revision;
    if (bot.purpose) body.append(el('p', bot.purpose, 'station-description'));
    const rows = el('div', null, 'station-settings');
    const home = action('', () => jump(bot.target), 'station-setting');
    home.setAttribute('aria-label', '打开主会话 · ' + bot.target.session);
    home.append(el('span', '主会话'), el('span', bot.target.session, 'station-value'));
    const telegram = el('details'), channel = el('div', null, 'station-setting-body');
    const summary = el('summary', 'Telegram', 'station-setting'), handle = el('span', '', 'station-value');
    summary.append(handle); telegram.append(summary, channel);
    const settings = el('details'); settings.append(el('summary', '职责与偏好', 'station-setting'));
    rows.append(home, telegram, settings); body.append(rows);
    const form = el('form'), purpose = el('textarea'), instructions = el('textarea');
    purpose.value = bot.purpose || ''; instructions.value = bot.instructions || '';
    form.append(field('职责', purpose), field('专属偏好（可选）', instructions));
    submit(form, '保存设置', async () => {
      const changes = {};
      if (purpose.value.trim() !== (bot.purpose || '')) changes.purpose = purpose.value.trim();
      if (instructions.value.trim() !== (bot.instructions || '')) changes.instructions = instructions.value.trim();
      if (Object.keys(changes).length) await mutation('/bots/' + bot.id, 'PATCH', changes);
      if (current === revision) paint();
    });
    const edit = el('div', null, 'station-setting-body');
    edit.append(form, action('解除主会话绑定', async () => {
      await mutation('/bots/' + bot.id, 'DELETE');
      if (current === revision) await close();
    }, 'station-secondary'));
    settings.append(edit);
    const owned = tasks.filter(t => t.botId === bot.id);
    if (owned.length) {
      body.append(el('h3', '关联任务'));
      for (const task of owned) body.append(taskRow(task));
    }
    const endpoint = base + '/bots/' + bot.id + '/telegram';
    let read = 0;
    async function loadTelegram() {
      const ticket = ++read;
      let result;
      try { result = await request(endpoint); }
      catch (error) {
        if (ticket === read && rows.isConnected) {
          handle.textContent = '读取失败';
          channel.replaceChildren(el('p', error.message), action('重试', loadTelegram));
        }
        return;
      }
      if (ticket !== read || !rows.isConnected) return;
      const { bound, available } = result;
      handle.textContent = bound ? '@' + bound.username + ' · ' + (bound.status === 'connected' ? '已连接' : '离线') : '未绑定';
      channel.replaceChildren();
      if (bound) {
        channel.append(action('解除 Telegram 绑定', async () => {
          await request(endpoint, 'DELETE', { channelId: bound.id, key: bound.key });
          await loadTelegram();
          if (rows.isConnected) summary.focus();
        }, 'station-secondary'));
      } else if (available.length) {
        const select = el('select');
        for (const item of available) select.add(new Option('@' + item.username, item.id));
        channel.append(field('Telegram 机器人', select), action('绑定 Telegram', async () => {
          await request(endpoint, 'PUT', { channelId: select.value });
          await loadTelegram();
          if (rows.isConnected) summary.focus();
        }, 'station-primary'));
      } else channel.append(el('p', '暂无可绑定的机器人。请检查 Telegram 后台服务或已有关联。', 'station-meta'));
    }
    channel.textContent = '正在读取机器人…';
    void loadTelegram();
    telegram.addEventListener('toggle', () => {
      if (telegram.open && handle.textContent) void loadTelegram();
    });
  }

  function paint() {
    if (!route) return;
    const current = revision, view = route.view;
    const task = tasks.find(t => t.id === route.id), bot = bots.find(b => b.id === route.id);
    heading.textContent = ({ automations: 'Automations', bind: '绑定 Bot', detail: task?.title || '任务详情', bot: bot?.name || 'Bot' })[view];
    tools.replaceChildren(button(depth < 2 ? '返回会话' : '返回', back));
    if (openDrawer) {
      const menu = button('☰', openDrawer);
      menu.id = 'stationMenu'; menu.setAttribute('aria-label', '打开会话列表'); menu.setAttribute('aria-controls', 'threadDrawer');
      tools.prepend(menu);
    }
    showError(''); body.replaceChildren();
    if (view === 'automations') {
      const content = el('div'); body.append(content);
      void renderAutomations(content, { token, activeSession: () => active()?.target?.session || '', openLegacy: control => openLegacy('timers', control) }).catch(e => {
        if (current === revision) { showError(e.message); body.append(button('重试', () => paint())); }
      });
    } else if (!loaded) {
      body.append(el('p', '正在读取工作台…', 'station-empty'));
      refresh().then(() => { if (current === revision) paint(); }).catch(e => {
        if (current === revision) { showError(e.message); body.replaceChildren(button('重试', () => paint())); }
      });
    } else if (view === 'bind') bindBotForm().catch(e => { if (current === revision) { showError(e.message); body.append(button('重试', () => paint())); } });
    else if (view === 'detail' && task) detail(task);
    else if (view === 'bot' && bot) botDetails(bot);
    else body.append(el('p', '记录已移除。', 'station-empty'));
    panel.scrollTop = 0;
  }

  automationButton.onclick = () => { if (route?.view !== 'automations') navigate({ view: 'automations' }, automationButton); else closeDrawer(); };
  const pagesToggle = document.getElementById('pagesToggle');
  const pagesList = document.getElementById('stationPages');
  let pagesRequest = 0;
  async function setPagesOpen(open) {
    const id = ++pagesRequest;
    pagesList.hidden = !open;
    pagesToggle.setAttribute('aria-expanded', String(!pagesList.hidden));
    if (pagesList.hidden) return;
    pagesList.textContent = '加载中…';
    try {
      const { pages } = await request('/api/pages');
      if (id !== pagesRequest) return;
      pagesList.replaceChildren();
      const folders = new Map();
      for (const page of pages) {
        const name = page.folder || '';
        if (name && !folders.has(name)) {
          const folder = el('details', null, 'station-page-folder');
          const label = el('summary', null, 'station-entry');
          const arrow = el('span', null, 'station-chevron');
          arrow.setAttribute('aria-hidden', 'true');
          label.append(arrow, name);
          folder.append(label);
          folders.set(name, folder);
          pagesList.append(folder);
        }
        const link = el('a', page.title, 'station-child');
        link.href = '/pages/' + encodeURIComponent(page.id);
        link.target = '_blank';
        link.rel = 'noopener';
        (name ? folders.get(name) : pagesList).append(link);
      }
      if (!pages.length) pagesList.textContent = '暂无页面';
    } catch (error) {
      if (id === pagesRequest) pagesList.textContent = error.message;
    }
  }
  pagesToggle.onclick = () => setPagesOpen(pagesList.hidden);

  botsToggle.onclick = () => {
    botsList.hidden = !botsList.hidden;
    botsToggle.setAttribute('aria-expanded', String(!botsList.hidden));
  };
  document.getElementById('bindBotButton').onclick = event => navigate({ view: 'bind' }, event.currentTarget);

  function sync() {
    const owner = available() ? token() : '';
    if (owner === authenticated) return;
    nav.querySelector('.station-group').open = false;
    expanded.clear();
    botsList.hidden = true;
    botsToggle.setAttribute('aria-expanded', 'false');
    void setPagesOpen(false);
    pagesList.replaceChildren();
    generation++; authenticated = owner; loaded = false; inflight = null; tasks = []; bots = []; pendingRead++;
    renderBots(); clearInterval(timer);
    nav.hidden = !owner || legacy; automationButton.hidden = !owner;
    document.getElementById('legacyStationEntry').hidden = !owner || !legacy;
    if (!owner || legacy) { if (route) close(); return; }
    const poll = () => {
      if (document.hidden) return;
      void refresh().catch(() => {});
      void refreshPending();
    };
    poll(); timer = setInterval(poll, 30_000);
  }

  return { sync, close, visible: () => Boolean(route) };
}
