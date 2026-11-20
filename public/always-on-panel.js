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
      <button type="button" role="tab" data-tab="overview" aria-selected="true">待拍板与提案</button>
      <button type="button" role="tab" data-tab="blueprints" aria-selected="false">目标蓝图</button>
      <button type="button" role="tab" data-tab="timers" aria-selected="false">定时器</button>
      <button type="button" role="tab" data-tab="memory" aria-selected="false">个人记忆</button>
      <button type="button" role="tab" data-tab="events" aria-selected="false">事件与实体</button>
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
  let architectAnalysis = null;
  let architectQIndex = 0;
  let lastDryRun = null;
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
    const count = (stats.approvals?.pending || 0) + (stats.outbox?.urgentPending || 0) + (stats.proposals?.pending || 0);
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
      el('span', { class: 'always-on-pill urgent' }, `改进提案 ${data.stats.proposals?.pending || 0}`),
      el('span', { class: 'always-on-pill' }, `活跃蓝图 ${data.stats.blueprints?.active || 0}`),
      el('span', { class: 'always-on-pill' }, `活跃定时 ${data.stats.timers.active}`),
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
      el('button', {
        type: 'button',
        class: 'always-on-btn',
        onclick: async () => {
          statusEl.textContent = '正在扫描反馈生成改进提案…';
          try {
            const res = await apiFetch('/api/always-on/proposals/generate', { method: 'POST' });
            statusEl.textContent = res.generated ? `生成 ${res.generated} 条改进提案` : '暂无新的可提议改进';
            await renderCurrentTab();
          } catch (e) { statusEl.textContent = e.message; }
        },
      }, '复盘生成提案'),
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

    bodyEl.append(el('h3', {}, '流程改进提案（Feedback Proposals）'));
    const proposals = data.pendingProposals || [];
    if (!proposals.length) {
      bodyEl.append(el('p', { class: 'always-on-empty' }, '暂无待审改进提案。'));
    } else {
      for (const prop of proposals) {
        const card = el('article', { class: 'always-on-card' });
        const head = el('div', { class: 'always-on-card-head' });
        head.append(el('strong', {}, prop.title), el('span', { class: 'always-on-pill urgent' }, prop.entityKey));
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
              statusEl.textContent = `已采纳提案并更新蓝图：${prop.title}`;
              await renderCurrentTab();
            },
          }, '采纳并更新蓝图'),
          el('button', {
            type: 'button',
            class: 'always-on-btn',
            onclick: async () => {
              await apiFetch(`/api/always-on/proposals/${encodeURIComponent(prop.id)}/resolve`, {
                method: 'POST',
                body: JSON.stringify({ decision: 'rejected' }),
              });
              statusEl.textContent = `已忽略提案：${prop.title}`;
              await renderCurrentTab();
            },
          }, '忽略'),
        );
        card.append(head, el('p', { class: 'always-on-empty' }, prop.rationale), actions);
        bodyEl.append(card);
      }
    }

    bodyEl.append(el('h3', {}, '最近汇报（Outbox）'));
    if (!data.recentOutbox.length) {
      bodyEl.append(el('p', { class: 'always-on-empty' }, '暂无外发或静默记录。'));
    } else {
      for (const item of data.recentOutbox.slice(0, 8)) {
        const card = el('article', { class: 'always-on-card' });
        const head = el('div', { class: 'always-on-card-head' });
        head.append(el('strong', {}, item.title), el('span', { class: 'always-on-pill' }, `${item.priority} · ${item.status}`));
        card.append(head, el('p', { class: 'always-on-empty' }, item.contentMd.slice(0, 220)));
        bodyEl.append(card);
      }
    }
  }

  async function renderBlueprints() {
    const data = await apiFetch('/api/always-on/blueprints');
    bodyEl.replaceChildren();

    // Codeck Architect guided onboarding card
    const archCard = el('article', { class: 'always-on-card' });
    archCard.append(el('strong', {}, 'Codeck Architect：访谈式创建自动化目标（先确认、先演练、再上线）'));
    const brainInput = el('textarea', {
      placeholder: '随便说说你想让 Agent 负责什么目标、你平时怎么做、看哪些数据源…（支持语音输入）',
      rows: '3',
    });
    brainInput.style.width = '100%';
    brainInput.style.background = '#020617';
    brainInput.style.color = '#f8fafc';
    brainInput.style.border = '1px solid rgba(148,163,184,0.28)';
    brainInput.style.borderRadius = '8px';
    brainInput.style.padding = '8px';

    const archRow = el('div', { class: 'always-on-row' });
    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SpeechRec) {
      let rec = null;
      const micBtn = el('button', {
        type: 'button',
        class: 'always-on-btn',
        onclick: () => {
          if (rec) { rec.stop(); rec = null; micBtn.textContent = '🎤 语音脑暴'; return; }
          rec = new SpeechRec();
          rec.lang = 'zh-CN';
          rec.continuous = false;
          micBtn.textContent = '⏹ 停止录音';
          rec.onresult = e => {
            const transcript = [...e.results].map(r => r[0]?.transcript || '').join('');
            brainInput.value = `${brainInput.value}${brainInput.value ? ' ' : ''}${transcript}`.trim();
          };
          rec.onend = () => { rec = null; micBtn.textContent = '🎤 语音脑暴'; };
          rec.start();
        },
      }, '🎤 语音脑暴');
      archRow.append(micBtn);
    }

    archRow.append(el('button', {
      type: 'button',
      class: 'always-on-btn primary',
      onclick: async () => {
        if (!brainInput.value.trim()) { statusEl.textContent = '请先输入或口述目标与流程'; return; }
        statusEl.textContent = 'Architect 正在拆分 Goal 与 Process…';
        try {
          architectAnalysis = await apiFetch('/api/always-on/architect/analyze', {
            method: 'POST',
            body: JSON.stringify({ text: brainInput.value.trim() }),
          });
          architectQIndex = 0;
          statusEl.textContent = '已生成复述草案与逐题访谈';
          await renderBlueprints();
        } catch (e) { statusEl.textContent = e.message; }
      },
    }, '拆解 Goal 与 Process'));
    archCard.append(brainInput, archRow);

    if (architectAnalysis) {
      if (architectAnalysis.processConfusionWarning) {
        archCard.append(el('p', { class: 'always-on-pill urgent' }, architectAnalysis.processConfusionWarning));
      }
      archCard.append(el('pre', { class: 'always-on-empty' }, architectAnalysis.restatement));

      const q = architectAnalysis.questions?.[architectQIndex];
      if (q) {
        const qBox = el('div', { class: 'always-on-card' });
        qBox.append(el('strong', {}, `逐题访谈 (${architectQIndex + 1}/${architectAnalysis.questions.length})：${q.question}`));
        const ansInput = el('input', { type: 'text', placeholder: q.placeholder || '输入你的回答' });
        const qRow = el('div', { class: 'always-on-row' });
        qRow.append(
          ansInput,
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
          }, '下一题'),
        );
        qBox.append(qRow);
        archCard.append(qBox);
      } else {
        const edgeBox = el('div', { class: 'always-on-card' });
        edgeBox.append(el('strong', {}, '异常边界预演确认'));
        for (const c of architectAnalysis.edgeCases || []) {
          edgeBox.append(el('small', {}, `• ${c.title}：${c.proposedHandling}`));
        }
        const matRow = el('div', { class: 'always-on-row' });
        const recInput = el('input', { type: 'text', placeholder: '可选周期如 60m / 1d' });
        matRow.append(
          recInput,
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
              statusEl.textContent = '已实例化目标蓝图（默认 paused，建议先跑 Dry-Run 演练）';
              await renderBlueprints();
            },
          }, '确认并生成目标蓝图'),
          el('button', {
            type: 'button',
            class: 'always-on-btn',
            onclick: () => { architectAnalysis = null; renderBlueprints(); },
          }, '放弃草案'),
        );
        edgeBox.append(matRow);
        archCard.append(edgeBox);
      }
    }
    bodyEl.append(archCard);

    if (lastDryRun) {
      const dryCard = el('article', { class: 'always-on-card' });
      dryCard.append(
        el('strong', {}, `Dry-Run 演练报告（${lastDryRun.blueprintSlug} v${lastDryRun.blueprintVersion} · 零外部副作用）`),
        el('small', {}, `预计风险：${lastDryRun.predictedRisk} · 实体：${lastDryRun.entityKey}`),
      );
      for (const w of lastDryRun.warnings || []) dryCard.append(el('span', { class: 'always-on-pill urgent' }, `⚠ ${w}`));
      for (const step of lastDryRun.predictedActions || []) dryCard.append(el('small', {}, step));
      bodyEl.append(dryCard);
    }

    bodyEl.append(el('h3', {}, `已有目标蓝图（${data.blueprints.length}）`));
    if (!data.blueprints.length) {
      bodyEl.append(el('p', { class: 'always-on-empty' }, '暂无目标蓝图，可使用上方 Architect 引导创建。'));
      return;
    }
    for (const bp of data.blueprints) {
      const card = el('article', { class: 'always-on-card' });
      const head = el('div', { class: 'always-on-card-head' });
      head.append(el('strong', {}, `${bp.title} (v${bp.version})`), el('span', { class: 'always-on-pill' }, `${bp.status} · ${bp.entityKey}`));
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
            statusEl.textContent = `蓝图 ${bp.slug} 已切换为 ${nextStatus}`;
            await renderBlueprints();
          },
        }, bp.status === 'active' ? '暂停' : '启用'),
        el('button', {
          type: 'button',
          class: 'always-on-btn primary',
          onclick: async () => {
            statusEl.textContent = `正在对 ${bp.slug} 执行只读 Dry-Run…`;
            lastDryRun = await apiFetch(`/api/always-on/blueprints/${encodeURIComponent(bp.slug)}/dry-run`, { method: 'POST' });
            statusEl.textContent = `Dry-Run 完成（零外部副作用）`;
            await renderBlueprints();
          },
        }, 'Dry-Run 演练'),
        el('button', {
          type: 'button',
          class: 'always-on-btn',
          onclick: async () => {
            const res = await apiFetch(`/api/always-on/collectors/${encodeURIComponent(bp.slug)}/publish`, { method: 'POST', body: JSON.stringify({}) });
            statusEl.textContent = res.url ? `已生成微型采集页：${res.url}` : `已生成采集页 HTML（${bp.slug}）`;
          },
        }, '生成微型采集页'),
      );
      card.append(
        head,
        el('p', { class: 'always-on-empty' }, `Goal：${bp.goal}`),
        el('small', {}, `权威源：${bp.sourceOfTruth || '未指定'} · 验收：${bp.doneCriteria || '未指定'}`),
        actions,
      );
      bodyEl.append(card);
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
    const allFiles = [...list.baseline, ...(list.blueprints || []), ...list.notes, ...list.progress, ...list.archive];
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
    const [eventsData, proxyData, entitiesData] = await Promise.all([
      apiFetch('/api/always-on/events?limit=25'),
      apiFetch('/api/always-on/proxy/services'),
      apiFetch('/api/always-on/entities'),
    ]);
    bodyEl.replaceChildren();

    bodyEl.append(el('h3', {}, `跨源实体时间线（Entity Keys：${entitiesData.entities.length}）`));
    if (!entitiesData.entities.length) {
      bodyEl.append(el('p', { class: 'always-on-empty' }, '暂无实体关联记录。'));
    } else {
      const entityRow = el('div', { class: 'always-on-row' });
      for (const item of entitiesData.entities) {
        entityRow.append(el('button', {
          type: 'button',
          class: selectedEntityKey === item.entityKey ? 'always-on-btn primary' : 'always-on-btn',
          onclick: async () => {
            selectedEntityKey = item.entityKey;
            await renderEvents();
          },
        }, `${item.entityKey} (${item.count})`));
      }
      bodyEl.append(entityRow);
      if (selectedEntityKey) {
        const tl = await apiFetch(`/api/always-on/entities/${encodeURIComponent(selectedEntityKey)}/timeline`);
        const tlCard = el('article', { class: 'always-on-card' });
        tlCard.append(el('strong', {}, `实体时间线：${tl.entityKey}`));
        for (const link of tl.links) {
          tlCard.append(el('small', {}, `[${new Date(link.createdAt).toLocaleString()}] (${link.refType}) ${link.summary}`));
        }
        bodyEl.append(tlCard);
      }
    }

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
      else if (currentTab === 'blueprints') await renderBlueprints();
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
