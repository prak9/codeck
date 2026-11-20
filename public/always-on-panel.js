export function bindAlwaysOnPanel({ button, badge, token, enabled = () => true, activeSession = () => null }) {
  if (!button) return { sync() {} };

  const dialog = document.createElement('dialog');
  dialog.className = 'always-on-dialog';
  dialog.setAttribute('aria-label', '个人行动台（Always-On）');
  dialog.innerHTML = `
    <header class="always-on-header">
      <strong>个人行动台（Always-On）</strong>
      <div class="always-on-header-actions">
        <label class="always-on-toggle">
          <input type="checkbox" data-butler-toggle>
          <span>按需 Butler 编排</span>
        </label>
        <button type="button" class="always-on-btn" data-refresh>刷新</button>
        <button type="button" class="always-on-btn" data-close aria-label="关闭行动台">×</button>
      </div>
    </header>
    <nav class="always-on-tabs" role="tablist">
      <button type="button" role="tab" data-tab="overview" aria-selected="true">待拍板与汇报</button>
      <button type="button" role="tab" data-tab="timers" aria-selected="false">定时器</button>
      <button type="button" role="tab" data-tab="memory" aria-selected="false">个人记忆</button>
      <button type="button" role="tab" data-tab="events" aria-selected="false">事件与代理</button>
    </nav>
    <p class="always-on-status" role="status"></p>
    <section class="always-on-body"></section>
  `;
  document.body.append(dialog);

  const statusEl = dialog.querySelector('.always-on-status');
  const bodyEl = dialog.querySelector('.always-on-body');
  const butlerToggle = dialog.querySelector('[data-butler-toggle]');
  const tabButtons = [...dialog.querySelectorAll('[role="tab"]')];

  let currentTab = 'overview';
  let activeMemoryPath = 'instructions.md';
  let pollTimer = null;

  async function apiFetch(url, options = {}) {
    const authToken = token();
    const response = await fetch(url, {
      ...options,
      headers: {
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
    if (response.status === 204) return {};
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }

  function el(tag, attrs = {}, text = '') {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') node.className = v;
      else if (k === 'onclick') node.onclick = v;
      else node.setAttribute(k, v);
    }
    if (text) node.textContent = text;
    return node;
  }

  function updateBadge(stats) {
    if (!badge || !stats) return;
    const count = (stats.approvals?.pending || 0) + (stats.outbox?.urgentPending || 0);
    if (count > 0) {
      badge.textContent = String(count);
      badge.hidden = false;
    } else {
      badge.textContent = '';
      badge.hidden = true;
    }
  }

  async function refreshBadge() {
    if (!enabled() || !token()) return;
    try {
      const data = await apiFetch('/api/always-on/overview');
      updateBadge(data.stats);
    } catch { /* ignore background badge error */ }
  }

  async function renderOverview() {
    const data = await apiFetch('/api/always-on/overview');
    butlerToggle.checked = Boolean(data.butlerEnabled);
    updateBadge(data.stats);
    bodyEl.replaceChildren();

    const summary = el('div', { class: 'always-on-row' });
    summary.append(
      el('span', { class: 'always-on-pill urgent' }, `待审批 ${data.stats.approvals.pending}`),
      el('span', { class: 'always-on-pill' }, `活跃定时 ${data.stats.timers.active}`),
      el('span', { class: 'always-on-pill' }, `待发简报 ${data.stats.outbox.digestPending}`),
      el('span', { class: 'always-on-pill' }, `待处理事件 ${data.stats.events.pending}`),
      el('button', {
        type: 'button',
        class: 'always-on-btn primary',
        onclick: async () => {
          statusEl.textContent = '正在汇总晨报…';
          try {
            const res = await apiFetch('/api/always-on/outbox/digest', { method: 'POST', body: JSON.stringify({ title: '个人行动简报' }) });
            statusEl.textContent = res.count ? `已汇总 ${res.count} 条简报` : '当前没有待汇总的 digest 条目';
            await renderCurrentTab();
          } catch (e) { statusEl.textContent = e.message; }
        },
      }, '立即生成简报'),
    );
    bodyEl.append(summary);

    bodyEl.append(el('h3', {}, '待拍板审批（Deferred Approvals）'));
    if (!data.pendingApprovals.length) {
      bodyEl.append(el('p', { class: 'always-on-empty' }, '暂无待审批事项。'));
    } else {
      for (const item of data.pendingApprovals) {
        const card = el('article', { class: 'always-on-card' });
        const head = el('div', { class: 'always-on-card-head' });
        head.append(el('strong', {}, item.summary), el('span', { class: 'always-on-pill urgent' }, item.risk));
        const noteInput = el('input', { type: 'text', placeholder: '可选备注（随审批回流）' });
        const actions = el('div', { class: 'always-on-row' });
        actions.append(
          noteInput,
          el('button', {
            type: 'button',
            class: 'always-on-btn primary',
            onclick: async () => {
              await apiFetch(`/api/always-on/approvals/${encodeURIComponent(item.id)}/resolve`, {
                method: 'POST',
                body: JSON.stringify({ decision: 'approved', note: noteInput.value.trim() || null }),
              });
              statusEl.textContent = `已批准：${item.summary}`;
              await renderCurrentTab();
            },
          }, '批准'),
          el('button', {
            type: 'button',
            class: 'always-on-btn danger',
            onclick: async () => {
              await apiFetch(`/api/always-on/approvals/${encodeURIComponent(item.id)}/resolve`, {
                method: 'POST',
                body: JSON.stringify({ decision: 'rejected', note: noteInput.value.trim() || null }),
              });
              statusEl.textContent = `已拒绝：${item.summary}`;
              await renderCurrentTab();
            },
          }, '拒绝'),
        );
        card.append(head, el('small', {}, `${item.scopeKey} · ${new Date(item.createdAt).toLocaleString()}`), actions);
        bodyEl.append(card);
      }
    }

    bodyEl.append(el('h3', {}, '最近汇报（Outbox）'));
    if (!data.recentOutbox.length) {
      bodyEl.append(el('p', { class: 'always-on-empty' }, '暂无外发或静默记录。'));
    } else {
      for (const item of data.recentOutbox.slice(0, 10)) {
        const card = el('article', { class: 'always-on-card' });
        const head = el('div', { class: 'always-on-card-head' });
        head.append(el('strong', {}, item.title), el('span', { class: 'always-on-pill' }, `${item.priority} · ${item.status}`));
        card.append(head, el('p', { class: 'always-on-empty' }, item.contentMd.slice(0, 220)));
        bodyEl.append(card);
      }
    }
  }

  async function renderTimers() {
    const data = await apiFetch('/api/always-on/timers');
    bodyEl.replaceChildren();

    const form = el('form', { class: 'always-on-form' });
    const inInput = el('input', { name: 'in', placeholder: '延迟如 30m / 2h', value: '30m', required: 'true' });
    const reasonInput = el('input', { name: 'reason', placeholder: '跟进事项说明', required: 'true' });
    const sessInput = el('input', { name: 'session', placeholder: '可选目标会话名', value: activeSession() || '' });
    const submit = el('button', { type: 'submit', class: 'always-on-btn primary' }, '新增 Follow-up');
    form.append(inInput, reasonInput, sessInput, submit);
    form.onsubmit = async event => {
      event.preventDefault();
      try {
        await apiFetch('/api/always-on/timers/followup', {
          method: 'POST',
          body: JSON.stringify({
            in: inInput.value.trim(),
            reason: reasonInput.value.trim(),
            ...(sessInput.value.trim() ? { session: sessInput.value.trim() } : {}),
          }),
        });
        statusEl.textContent = '已创建跟进定时器';
        reasonInput.value = '';
        await renderTimers();
      } catch (e) { statusEl.textContent = e.message; }
    };
    bodyEl.append(form);

    if (!data.timers.length) {
      bodyEl.append(el('p', { class: 'always-on-empty' }, '暂无定时器。'));
      return;
    }
    for (const t of data.timers) {
      const card = el('article', { class: 'always-on-card' });
      const head = el('div', { class: 'always-on-card-head' });
      head.append(el('strong', {}, t.reason), el('span', { class: 'always-on-pill' }, `${t.kind} · ${t.status}`));
      const actions = el('div', { class: 'always-on-row' });
      if (t.status === 'active' || t.status === 'paused') {
        actions.append(el('button', {
          type: 'button',
          class: 'always-on-btn',
          onclick: async () => {
            await apiFetch(`/api/always-on/timers/${encodeURIComponent(t.id)}`, {
              method: 'PATCH',
              body: JSON.stringify({ action: t.status === 'active' ? 'pause' : 'resume' }),
            });
            await renderTimers();
          },
        }, t.status === 'active' ? '暂停' : '恢复'));
      }
      actions.append(el('button', {
        type: 'button',
        class: 'always-on-btn danger',
        onclick: async () => {
          await apiFetch(`/api/always-on/timers/${encodeURIComponent(t.id)}`, { method: 'DELETE' });
          await renderTimers();
        },
      }, '删除'));
      card.append(head, el('small', {}, `${t.scopeKey} · 到期：${new Date(t.dueAt).toLocaleString()}`), actions);
      bodyEl.append(card);
    }
  }

  async function renderMemory() {
    const list = await apiFetch('/api/always-on/memory');
    const allFiles = [...list.baseline, ...list.notes, ...list.progress, ...list.archive];
    if (!allFiles.some(f => f.path === activeMemoryPath)) activeMemoryPath = 'instructions.md';
    const current = await apiFetch('/api/always-on/memory/file?' + new URLSearchParams({ path: activeMemoryPath }));

    bodyEl.replaceChildren();
    const topBar = el('div', { class: 'always-on-row' });
    topBar.append(
      el('span', { class: 'always-on-pill' }, `基线体积：${list.baselineBytes} / ${list.maxBaselineBytes} B`),
      el('button', {
        type: 'button',
        class: 'always-on-btn primary',
        onclick: async () => {
          statusEl.textContent = '正在运行 Dreaming 整理…';
          const res = await apiFetch('/api/always-on/memory/dream', { method: 'POST' });
          statusEl.textContent = `Dreaming 完成：归档 ${res.archived.length} 份进度，去重 ${res.dedupedNotes.length} 份笔记`;
          await renderMemory();
        },
      }, '运行 Dreaming 整理'),
    );
    bodyEl.append(topBar);

    const fileRow = el('div', { class: 'always-on-row' });
    for (const file of allFiles) {
      fileRow.append(el('button', {
        type: 'button',
        class: file.path === activeMemoryPath ? 'always-on-btn primary' : 'always-on-btn',
        onclick: async () => {
          activeMemoryPath = file.path;
          await renderMemory();
        },
      }, `${file.path}${file.locked ? ' 🔒' : ''}`));
    }
    bodyEl.append(fileRow);

    const editor = el('div', { class: 'always-on-editor always-on-card' });
    const textarea = el('textarea', { 'aria-label': `编辑 ${current.path}` });
    textarea.value = current.content;
    const saveRow = el('div', { class: 'always-on-row' });
    saveRow.append(
      el('button', {
        type: 'button',
        class: 'always-on-btn primary',
        onclick: async () => {
          await apiFetch('/api/always-on/memory/file', {
            method: 'PUT',
            body: JSON.stringify({ path: current.path, content: textarea.value }),
          });
          statusEl.textContent = `已保存 ${current.path}`;
          await renderMemory();
        },
      }, '保存记忆文件'),
    );
    editor.append(el('strong', {}, current.path), textarea, saveRow);
    bodyEl.append(editor);
  }

  async function renderEvents() {
    const [eventsData, proxyData] = await Promise.all([
      apiFetch('/api/always-on/events?limit=25'),
      apiFetch('/api/always-on/proxy/services'),
    ]);
    bodyEl.replaceChildren();
    bodyEl.append(el('h3', {}, `已注册 Credential Proxy 服务（${proxyData.services.length}）`));
    if (!proxyData.services.length) {
      bodyEl.append(el('p', { class: 'always-on-empty' }, '当前仅启用代理框架，未注册外部生产服务。'));
    } else {
      for (const s of proxyData.services) {
        bodyEl.append(el('div', { class: 'always-on-card' }, `${s.name} → ${s.baseUrl}${s.allowedPathPrefix} [${s.allowedMethods.join(',')}]`));
      }
    }
    bodyEl.append(el('h3', {}, '最近事件流（Event Inbox）'));
    if (!eventsData.events.length) {
      bodyEl.append(el('p', { class: 'always-on-empty' }, '暂无事件记录。'));
    } else {
      for (const ev of eventsData.events) {
        const card = el('article', { class: 'always-on-card' });
        const head = el('div', { class: 'always-on-card-head' });
        head.append(el('strong', {}, `${ev.scopeKey} · ${ev.source}`), el('span', { class: 'always-on-pill' }, ev.status));
        card.append(head, el('small', {}, `${new Date(ev.createdAt).toLocaleString()}${ev.error ? ` · ${ev.error}` : ''}`));
        bodyEl.append(card);
      }
    }
  }

  async function renderCurrentTab() {
    if (!dialog.open) return;
    statusEl.textContent = '正在加载…';
    try {
      if (currentTab === 'overview') await renderOverview();
      else if (currentTab === 'timers') await renderTimers();
      else if (currentTab === 'memory') await renderMemory();
      else await renderEvents();
      if (statusEl.textContent === '正在加载…') statusEl.textContent = '';
    } catch (error) {
      statusEl.textContent = error.message;
    }
  }

  for (const tab of tabButtons) {
    tab.onclick = () => {
      currentTab = tab.dataset.tab;
      for (const b of tabButtons) b.setAttribute('aria-selected', String(b === tab));
      renderCurrentTab();
    };
  }

  butlerToggle.onchange = async () => {
    try {
      const res = await apiFetch('/api/always-on/butler/toggle', {
        method: 'POST',
        body: JSON.stringify({ enabled: butlerToggle.checked }),
      });
      statusEl.textContent = res.enabled ? '已开启按需 Butler 编排' : '已停用 Butler 编排';
    } catch (error) {
      statusEl.textContent = error.message;
      butlerToggle.checked = !butlerToggle.checked;
    }
  };

  dialog.querySelector('[data-refresh]').onclick = () => renderCurrentTab();
  dialog.querySelector('[data-close]').onclick = () => dialog.close();
  dialog.addEventListener('close', () => button.focus());

  button.onclick = () => {
    if (!enabled()) return;
    dialog.showModal();
    renderCurrentTab();
  };

  function sync() {
    const visible = Boolean(enabled() && token());
    button.hidden = !visible;
    if (visible && !pollTimer) {
      refreshBadge();
      pollTimer = setInterval(refreshBadge, 30_000);
    } else if (!visible && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  return { sync, refreshBadge };
}
