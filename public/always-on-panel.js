import { createSpeechInput, mergeSpeechDraft } from './remote-speech.js?v=7';

export function bindAlwaysOnPanel({ button, badge, token, enabled = () => true, activeSession = () => null }) {
  if (!button) return { sync() {}, open() {} };

  const dialog = document.createElement('dialog');
  dialog.className = 'always-on-dialog';
  dialog.setAttribute('aria-label', '个人行动台');
  dialog.innerHTML = `
    <header class="always-on-header">
      <h2 class="always-on-title">行动台</h2>
      <div class="always-on-header-actions">
        <label class="always-on-toggle" title="按事件短暂唤醒编排，不占用固定终端">
          <input type="checkbox" data-butler-toggle>
          <span>自动编排</span>
        </label>
        <button type="button" class="always-on-btn subtle" data-refresh aria-label="刷新">刷新</button>
        <button type="button" class="always-on-btn subtle" data-close aria-label="关闭行动台">×</button>
      </div>
    </header>
    <nav class="always-on-tabs" role="tablist">
      <button type="button" role="tab" data-tab="overview" aria-selected="true">概览</button>
      <button type="button" role="tab" data-tab="blueprints" aria-selected="false">目标</button>
      <button type="button" role="tab" data-tab="timers" aria-selected="false">定时</button>
      <button type="button" role="tab" data-tab="memory" aria-selected="false">记忆</button>
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
  let selectedEntityKey = null;
  let showArchitect = false;
  let showTimerForm = false;
  let architectAnalysis = null;
  let architectQIndex = 0;
  let lastDryRun = null;
  let activeSpeech = null;
  let pollTimer = null;

  function stopSpeech() {
    if (!activeSpeech) return;
    activeSpeech.dispose();
    activeSpeech = null;
  }

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
    const count = (stats.approvals?.pending || 0) + (stats.proposals?.pending || 0);
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
    const [data, entitiesData, eventsData] = await Promise.all([
      apiFetch('/api/always-on/overview'),
      apiFetch('/api/always-on/entities'),
      apiFetch('/api/always-on/events?limit=15'),
    ]);
    butlerToggle.checked = Boolean(data.butlerEnabled);
    updateBadge(data.stats);
    bodyEl.replaceChildren();

    const approvals = data.pendingApprovals || [];
    const proposals = data.pendingProposals || [];

    if (!approvals.length && !proposals.length) {
      const calm = el('div', { class: 'always-on-card' });
      calm.append(
        el('strong', {}, '一切平稳，暂无需要你处理的事项'),
        el('p', { class: 'always-on-meta' }, `进行中目标 ${data.stats.blueprints?.active || 0} · 活跃定时 ${data.stats.timers?.active || 0} · 待汇总简报 ${data.stats.outbox?.digestPending || 0}`),
      );
      bodyEl.append(calm);
    }

    if (approvals.length) {
      bodyEl.append(el('div', { class: 'always-on-section-head' }, ''));
      bodyEl.lastChild.append(el('h3', {}, `待你确认（${approvals.length}）`));
      for (const item of approvals) {
        const card = el('article', { class: 'always-on-card' });
        const head = el('div', { class: 'always-on-card-head' });
        head.append(el('strong', {}, item.summary), el('span', { class: 'always-on-pill accent' }, '待确认'));
        const noteInput = el('input', { type: 'text', class: 'always-on-field', placeholder: '附一句备注（可选）' });
        const actions = el('div', { class: 'always-on-row' });
        actions.append(
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
            class: 'always-on-btn',
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
        card.append(head, el('p', { class: 'always-on-meta' }, `${item.sessionName || item.scopeKey} · ${new Date(item.createdAt).toLocaleString()}`), noteInput, actions);
        bodyEl.append(card);
      }
    }

    if (proposals.length) {
      const head = el('div', { class: 'always-on-section-head' });
      head.append(el('h3', {}, `优化建议（${proposals.length}）`));
      bodyEl.append(head);
      for (const prop of proposals) {
        const card = el('article', { class: 'always-on-card' });
        const chead = el('div', { class: 'always-on-card-head' });
        chead.append(el('strong', {}, prop.title), el('span', { class: 'always-on-pill' }, prop.entityKey));
        const actions = el('div', { class: 'always-on-row' });
        actions.append(
          el('button', {
            type: 'button',
            class: 'always-on-btn primary',
            onclick: async () => {
              await apiFetch(`/api/always-on/proposals/${encodeURIComponent(prop.id)}/resolve`, {
                method: 'POST',
                body: JSON.stringify({ decision: 'accepted' }),
              });
              statusEl.textContent = `已采纳并更新目标：${prop.title}`;
              await renderCurrentTab();
            },
          }, '采纳'),
          el('button', {
            type: 'button',
            class: 'always-on-btn subtle',
            onclick: async () => {
              await apiFetch(`/api/always-on/proposals/${encodeURIComponent(prop.id)}/resolve`, {
                method: 'POST',
                body: JSON.stringify({ decision: 'rejected' }),
              });
              statusEl.textContent = `已忽略：${prop.title}`;
              await renderCurrentTab();
            },
          }, '忽略'),
        );
        card.append(chead, el('p', { class: 'always-on-meta' }, prop.rationale), actions);
        bodyEl.append(card);
      }
    }

    // Quiet utility actions
    const utilRow = el('div', { class: 'always-on-row' });
    utilRow.append(
      el('button', {
        type: 'button',
        class: 'always-on-btn',
        onclick: async () => {
          statusEl.textContent = '正在汇总简报…';
          try {
            const res = await apiFetch('/api/always-on/outbox/digest', { method: 'POST', body: JSON.stringify({ title: '个人行动简报' }) });
            statusEl.textContent = res.count ? `已汇总 ${res.count} 条进展` : '当前没有待汇总的进展';
            await renderCurrentTab();
          } catch (e) { statusEl.textContent = e.message; }
        },
      }, '汇总简报'),
      el('button', {
        type: 'button',
        class: 'always-on-btn',
        onclick: async () => {
          statusEl.textContent = '正在复盘近期反馈…';
          try {
            const res = await apiFetch('/api/always-on/proposals/generate', { method: 'POST' });
            statusEl.textContent = res.generated ? `发现 ${res.generated} 条优化建议` : '暂无新的优化建议';
            await renderCurrentTab();
          } catch (e) { statusEl.textContent = e.message; }
        },
      }, '复盘建议'),
    );
    bodyEl.append(utilRow);

    if (data.recentOutbox?.length) {
      const head = el('div', { class: 'always-on-section-head' });
      head.append(el('h3', {}, '最近动态'));
      bodyEl.append(head);
      for (const item of data.recentOutbox.slice(0, 6)) {
        const card = el('article', { class: 'always-on-card' });
        const chead = el('div', { class: 'always-on-card-head' });
        chead.append(el('strong', {}, item.title), el('span', { class: 'always-on-pill' }, item.priority));
        card.append(chead, el('p', { class: 'always-on-meta' }, item.contentMd.slice(0, 180)));
        bodyEl.append(card);
      }
    }

    // Low-frequency technical details folded neatly by default
    const details = el('details', { class: 'always-on-details' });
    if (selectedEntityKey) details.open = true;
    details.append(el('summary', {}, `运行记录与实体时间线（${entitiesData.entities.length} 个实体 · ${eventsData.events.length} 条事件）`));

    if (entitiesData.entities.length) {
      const entityRow = el('div', { class: 'always-on-row' });
      entityRow.style.marginTop = '8px';
      for (const item of entitiesData.entities) {
        entityRow.append(el('button', {
          type: 'button',
          class: selectedEntityKey === item.entityKey ? 'always-on-btn primary' : 'always-on-btn',
          onclick: async () => {
            selectedEntityKey = selectedEntityKey === item.entityKey ? null : item.entityKey;
            await renderOverview();
          },
        }, `${item.entityKey} (${item.count})`));
      }
      details.append(entityRow);
      if (selectedEntityKey) {
        const tl = await apiFetch(`/api/always-on/entities/${encodeURIComponent(selectedEntityKey)}/timeline`);
        const tlCard = el('article', { class: 'always-on-card' });
        tlCard.style.marginTop = '8px';
        tlCard.append(el('strong', {}, tl.entityKey));
        for (const link of tl.links) {
          tlCard.append(el('p', { class: 'always-on-meta' }, `${new Date(link.createdAt).toLocaleString()} · ${link.summary}`));
        }
        details.append(tlCard);
      }
    }
    if (eventsData.events.length) {
      for (const ev of eventsData.events.slice(0, 8)) {
        details.append(el('p', { class: 'always-on-meta' }, `[${ev.status}] ${ev.scopeKey} · ${ev.source} · ${new Date(ev.createdAt).toLocaleTimeString()}${ev.error ? ` (${ev.error})` : ''}`));
      }
    }
    bodyEl.append(details);
  }

  async function renderBlueprints() {
    stopSpeech();
    const data = await apiFetch('/api/always-on/blueprints');
    bodyEl.replaceChildren();

    const head = el('div', { class: 'always-on-section-head' });
    head.append(
      el('h3', {}, `长期目标（${data.blueprints.length}）`),
      el('button', {
        type: 'button',
        class: showArchitect ? 'always-on-btn subtle' : 'always-on-btn primary',
        onclick: () => {
          showArchitect = !showArchitect;
          if (!showArchitect) architectAnalysis = null;
          renderBlueprints();
        },
      }, showArchitect ? '收起新建' : '＋ 新建目标'),
    );
    bodyEl.append(head);

    if (showArchitect || architectAnalysis) {
      const archCard = el('article', { class: 'always-on-card' });
      archCard.append(el('strong', {}, '告诉我你想自动化什么'));
      const brainInput = el('textarea', {
        class: 'always-on-field',
        placeholder: '直接用自然语言说说你的目标和平时的做法，不用整理格式…',
        rows: '3',
      });

      const archRow = el('div', { class: 'always-on-row' });
      let baseDraft = '';
      const micBtn = el('button', { type: 'button', class: 'always-on-btn' }, '语音输入');
      activeSpeech = createSpeechInput({
        onTranscript: ({ transcript, finalized }) => {
          if (!transcript) return;
          brainInput.value = mergeSpeechDraft(baseDraft, transcript);
          if (finalized) baseDraft = brainInput.value;
        },
        onListeningChange: (listening) => {
          micBtn.textContent = listening ? '停止语音' : '语音输入';
          micBtn.classList.toggle('listening', listening);
          if (listening) statusEl.textContent = '正在聆听…';
        },
        onStatus: (msg) => { statusEl.textContent = msg; },
        onError: (msg) => { statusEl.textContent = msg; },
      });
      if (activeSpeech.supported) {
        micBtn.onclick = () => {
          if (activeSpeech.active) {
            activeSpeech.stop();
          } else {
            baseDraft = brainInput.value;
            activeSpeech.start();
          }
        };
        archRow.append(micBtn);
      }

      archRow.append(el('button', {
        type: 'button',
        class: 'always-on-btn primary',
        onclick: async () => {
          if (!brainInput.value.trim()) { statusEl.textContent = '请先输入或口述你的目标'; return; }
          activeSpeech?.abort();
          statusEl.textContent = '正在梳理目标与步骤…';
          try {
            architectAnalysis = await apiFetch('/api/always-on/architect/analyze', {
              method: 'POST',
              body: JSON.stringify({ text: brainInput.value.trim() }),
            });
            architectQIndex = 0;
            statusEl.textContent = '';
            await renderBlueprints();
          } catch (e) { statusEl.textContent = e.message; }
        },
      }, '梳理方案'));
      archCard.append(brainInput, archRow);

      if (architectAnalysis) {
        if (architectAnalysis.processConfusionWarning) {
          archCard.append(el('p', { class: 'always-on-meta' }, `提示：${architectAnalysis.processConfusionWarning}`));
        }
        archCard.append(el('pre', { class: 'always-on-pre' }, architectAnalysis.restatement));

        const q = architectAnalysis.questions?.[architectQIndex];
        if (q) {
          const qBox = el('div', { class: 'always-on-card' });
          qBox.append(el('strong', {}, `补充确认（${architectQIndex + 1}/${architectAnalysis.questions.length}）`));
          qBox.append(el('p', { class: 'always-on-meta' }, q.question));
          const ansInput = el('input', { type: 'text', class: 'always-on-field', placeholder: q.placeholder || '输入回答，或留空跳过' });
          const qRow = el('div', { class: 'always-on-row' });
          qRow.append(
            el('button', {
              type: 'button',
              class: 'always-on-btn primary',
              onclick: async () => {
                const val = ansInput.value.trim();
                if (val) {
                  if (q.field === 'tacitRulesMd') architectAnalysis.draft.tacitRulesMd += `\n- ${val}`;
                  else if (q.field === 'scheduleHint') architectAnalysis.draft.scheduleHint = val;
                  else architectAnalysis.draft[q.field] = val;
                }
                architectQIndex++;
                await renderBlueprints();
              },
            }, '继续'),
            el('button', {
              type: 'button',
              class: 'always-on-btn subtle',
              onclick: async () => { architectQIndex = architectAnalysis.questions.length; await renderBlueprints(); },
            }, '直接生成'),
          );
          qBox.append(ansInput, qRow);
          archCard.append(qBox);
        } else {
          const matRow = el('div', { class: 'always-on-row' });
          const recInput = el('input', { type: 'text', class: 'always-on-field', placeholder: '可选自动检查周期（如 60m / 1d）' });
          matRow.append(
            el('button', {
              type: 'button',
              class: 'always-on-btn primary',
              onclick: async () => {
                await apiFetch('/api/always-on/architect/materialize', {
                  method: 'POST',
                  body: JSON.stringify({
                    draft: { ...architectAnalysis.draft, targetSession: architectAnalysis.draft.targetSession || activeSession() || null },
                    ...(recInput.value.trim() ? { recurrence: recInput.value.trim() } : {}),
                  }),
                });
                architectAnalysis = null;
                showArchitect = false;
                statusEl.textContent = '目标已创建（默认暂停，建议先演练再开启）';
                await renderBlueprints();
              },
            }, '确认创建'),
            el('button', {
              type: 'button',
              class: 'always-on-btn subtle',
              onclick: () => { architectAnalysis = null; renderBlueprints(); },
            }, '取消'),
          );
          archCard.append(recInput, matRow);
        }
      }
      bodyEl.append(archCard);
    }

    if (lastDryRun) {
      const dryCard = el('article', { class: 'always-on-card' });
      dryCard.append(el('strong', {}, `试运行预览 · ${lastDryRun.blueprintSlug}（未产生真实操作）`));
      for (const w of lastDryRun.warnings || []) dryCard.append(el('p', { class: 'always-on-meta' }, `⚠ ${w}`));
      for (const step of lastDryRun.predictedActions || []) dryCard.append(el('p', { class: 'always-on-meta' }, step));
      bodyEl.append(dryCard);
    }

    if (!data.blueprints.length && !showArchitect) {
      bodyEl.append(el('p', { class: 'always-on-empty' }, '还没有长期目标，点右上角「＋ 新建目标」用自然语言描述即可。'));
      return;
    }
    for (const bp of data.blueprints) {
      const card = el('article', { class: 'always-on-card' });
      const chead = el('div', { class: 'always-on-card-head' });
      chead.append(el('strong', {}, bp.title), el('span', { class: bp.status === 'active' ? 'always-on-pill accent' : 'always-on-pill' }, bp.status === 'active' ? '运行中' : '已暂停'));
      const actions = el('div', { class: 'always-on-row' });
      actions.append(
        el('button', {
          type: 'button',
          class: 'always-on-btn',
          onclick: async () => {
            const nextStatus = bp.status === 'active' ? 'paused' : 'active';
            await apiFetch(`/api/always-on/blueprints/${encodeURIComponent(bp.slug)}/status`, {
              method: 'PATCH',
              body: JSON.stringify({ status: nextStatus }),
            });
            statusEl.textContent = nextStatus === 'active' ? `已开启：${bp.title}` : `已暂停：${bp.title}`;
            await renderBlueprints();
          },
        }, bp.status === 'active' ? '暂停' : '开启'),
        el('button', {
          type: 'button',
          class: 'always-on-btn',
          onclick: async () => {
            statusEl.textContent = '正在只读演练…';
            lastDryRun = await apiFetch(`/api/always-on/blueprints/${encodeURIComponent(bp.slug)}/dry-run`, { method: 'POST' });
            statusEl.textContent = '';
            await renderBlueprints();
          },
        }, '试运行'),
        el('button', {
          type: 'button',
          class: 'always-on-btn subtle',
          onclick: async () => {
            const res = await apiFetch(`/api/always-on/collectors/${encodeURIComponent(bp.slug)}/publish`, { method: 'POST', body: JSON.stringify({}) });
            statusEl.textContent = res.url ? `已生成记录页：${res.url}` : '已生成记录页';
          },
        }, '生成记录页'),
      );
      card.append(chead, el('p', { class: 'always-on-meta' }, bp.goal), actions);
      bodyEl.append(card);
    }
  }

  async function renderTimers() {
    const data = await apiFetch('/api/always-on/timers');
    data.timers = data.timers.filter(timer => !timer.scopeKey.startsWith('workstation:'));
    bodyEl.replaceChildren();

    const head = el('div', { class: 'always-on-section-head' });
    head.append(
      el('h3', {}, `定时与跟进（${data.timers.length}）`),
      el('button', {
        type: 'button',
        class: showTimerForm ? 'always-on-btn subtle' : 'always-on-btn primary',
        onclick: () => { showTimerForm = !showTimerForm; renderTimers(); },
      }, showTimerForm ? '收起' : '＋ 新增提醒'),
    );
    bodyEl.append(head);

    if (showTimerForm) {
      const form = el('form', { class: 'always-on-card' });
      const inInput = el('input', { name: 'in', class: 'always-on-field', placeholder: '多久后提醒（如 30m / 2h / 1d）', value: '30m', required: 'true' });
      const reasonInput = el('input', { name: 'reason', class: 'always-on-field', placeholder: '到时候要检查或跟进什么', required: 'true' });
      const sessInput = el('input', { name: 'session', class: 'always-on-field', placeholder: '关联会话名（可选）', value: activeSession() || '' });
      const row = el('div', { class: 'always-on-row' });
      row.append(el('button', { type: 'submit', class: 'always-on-btn primary' }, '保存提醒'));
      form.append(inInput, reasonInput, sessInput, row);
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
          showTimerForm = false;
          statusEl.textContent = '已添加提醒';
          await renderTimers();
        } catch (e) { statusEl.textContent = e.message; }
      };
      bodyEl.append(form);
    }

    if (!data.timers.length && !showTimerForm) {
      bodyEl.append(el('p', { class: 'always-on-empty' }, '暂无定时或跟进提醒。'));
      return;
    }
    for (const t of data.timers) {
      const card = el('article', { class: 'always-on-card' });
      const chead = el('div', { class: 'always-on-card-head' });
      chead.append(el('strong', {}, t.reason), el('span', { class: 'always-on-pill' }, t.status === 'active' ? '进行中' : t.status === 'paused' ? '已暂停' : '已完成'));
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
        class: 'always-on-btn subtle',
        onclick: async () => {
          await apiFetch(`/api/always-on/timers/${encodeURIComponent(t.id)}`, { method: 'DELETE' });
          await renderTimers();
        },
      }, '删除'));
      card.append(chead, el('p', { class: 'always-on-meta' }, `${t.sessionName || t.scopeKey} · ${new Date(t.dueAt).toLocaleString()}`), actions);
      bodyEl.append(card);
    }
  }

  async function renderMemory() {
    const list = await apiFetch('/api/always-on/memory');
    const allFiles = [...list.baseline, ...(list.blueprints || []), ...list.notes, ...list.progress, ...list.archive];
    if (!allFiles.some(f => f.path === activeMemoryPath)) activeMemoryPath = 'instructions.md';
    const current = await apiFetch('/api/always-on/memory/file?' + new URLSearchParams({ path: activeMemoryPath }));

    bodyEl.replaceChildren();
    const head = el('div', { class: 'always-on-section-head' });
    head.append(
      el('h3', {}, `个人记忆（${Math.round(list.baselineBytes / 1024 * 10) / 10} / ${Math.round(list.maxBaselineBytes / 1024)} KB）`),
      el('button', {
        type: 'button',
        class: 'always-on-btn',
        onclick: async () => {
          statusEl.textContent = '正在整理记忆…';
          const res = await apiFetch('/api/always-on/memory/dream', { method: 'POST' });
          statusEl.textContent = `整理完成：归档 ${res.archived.length} 份，去重 ${res.dedupedNotes.length} 份`;
          await renderMemory();
        },
      }, '整理记忆'),
    );
    bodyEl.append(head);

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

    const editor = el('div', { class: 'always-on-card' });
    const textarea = el('textarea', { class: 'always-on-field mono', 'aria-label': `编辑 ${current.path}` });
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
      }, '保存'),
    );
    editor.append(textarea, saveRow);
    bodyEl.append(editor);
  }

  async function renderCurrentTab() {
    if (!dialog.open) return;
    stopSpeech();
    statusEl.textContent = '正在加载…';
    try {
      if (currentTab === 'overview') await renderOverview();
      else if (currentTab === 'blueprints') await renderBlueprints();
      else if (currentTab === 'timers') await renderTimers();
      else await renderMemory();
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
      statusEl.textContent = res.enabled ? '已开启自动编排' : '已暂停自动编排';
    } catch (error) {
      statusEl.textContent = error.message;
      butlerToggle.checked = !butlerToggle.checked;
    }
  };

  dialog.querySelector('[data-refresh]').onclick = () => renderCurrentTab();
  dialog.querySelector('[data-close]').onclick = () => dialog.close();
  let opener = button;
  dialog.addEventListener('close', () => { stopSpeech(); if (opener?.isConnected) opener.focus(); });

  function open(tab = 'overview', trigger = button) {
    if (!enabled() || !token()) return;
    const selected = tabButtons.find(b => b.dataset.tab === tab);
    if (!selected) return;
    currentTab = tab;
    opener = trigger;
    for (const b of tabButtons) b.setAttribute('aria-selected', String(b === selected));
    if (!dialog.open) dialog.showModal();
    renderCurrentTab();
  }
  button.onclick = () => open(button.dataset.tab || 'overview');

  function sync() {
    const visible = Boolean(enabled() && token());
    button.hidden = !visible;
    if (visible && badge && !pollTimer) {
      refreshBadge();
      pollTimer = setInterval(refreshBadge, 30_000);
    } else if (!visible && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  return { sync, refreshBadge, open };
}
