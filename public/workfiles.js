import { workfileFormat, readPreviewText, renderWorkfileMarkdown } from './workfile-preview.js?v=1';

const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
};
export function uploadWorkContext(params, target) {
  if (target?.name) {
    params.set('workSession', target.name);
    if (target.createdAt != null) params.set('workCreated', String(target.createdAt));
    params.set('workThread', target.agent?.id || ''); params.set('workProvider', target.agent?.kind || '');
  }
  return params;
}
export function bindWorkfiles({ button, token, getTarget, enabled = () => true, refreshIntervalMs = 5000 }) {
  if (!button) return { sync() {} };
  let target, data, tab = 'source', archive = '', generation = 0, controller;
  let autoTimer, loading = false, autoPending = false, lastRead = 0;
  let previewState = null, previewController, previewSequence = 0;
  const groupState = new Map();
  const key = value => value && JSON.stringify([value.name, value.createdAt, value.agent?.kind, value.agent?.id]);
  const dialog = el('dialog', null, 'workfiles-dialog');
  dialog.setAttribute('aria-labelledby', 'workfilesTitle');
  dialog.innerHTML = `<header><div><h2 id="workfilesTitle">工作文件</h2><p data-session></p></div><button type="button" data-close aria-label="关闭工作文件">×</button></header>
    <div data-browser><select aria-label="会话记录" hidden></select><nav aria-label="文件分类"><button type="button" data-tab="source" aria-pressed="true">资料</button><button type="button" data-tab="result" aria-pressed="false">成果</button><button type="button" data-refresh aria-label="刷新工作文件">↻</button></nav>
    <p class="workfiles-status" role="status" aria-live="polite"></p><div class="workfiles-list"></div>
    <details class="workfiles-add"><summary>＋ 添加资料</summary><form>
    <label>标题<input name="title" required maxlength="256"></label>
    <label>链接<input name="url" type="url" required placeholder="https://…"></label>
    <label>工作主题<input name="group" maxlength="256" placeholder="当前工作"></label>
    <button type="submit">添加</button></form><label class="workfiles-upload">上传文件<input type="file" multiple></label></details></div>
    <section class="workfiles-preview" aria-label="文件预览" hidden><div class="workfiles-preview-tools"><button type="button" data-back>← 返回列表</button><a data-preview-download target="_blank" rel="noopener noreferrer">下载</a></div><h3 data-preview-title></h3><p data-preview-version></p><details class="workfiles-verification"><summary>版本与验证</summary><div data-preview-evidence></div></details><p data-preview-status role="status" aria-live="polite"></p><button type="button" data-preview-retry hidden>重试预览</button><div class="workfiles-preview-content"></div></section>`;
  document.body.append(dialog);
  const status = dialog.querySelector('[role=status]'), list = dialog.querySelector('.workfiles-list');
  const form = dialog.querySelector('form');
  const archivePicker = dialog.querySelector('select');
  const browser = dialog.querySelector('[data-browser]'), preview = dialog.querySelector('.workfiles-preview');
  const previewBody = preview.querySelector('.workfiles-preview-content'), previewStatus = preview.querySelector('[data-preview-status]');
  const previewDownload = preview.querySelector('[data-preview-download]'), previewRetry = preview.querySelector('[data-preview-retry]');
  const current = () => dialog.open && key(target) === key(getTarget()) && enabled();
  const endpoint = () => `/api/sessions/${encodeURIComponent(target.name)}/workfiles`;
  async function request(url, options = {}) {
    const { readRevision, ...fetchOptions } = options;
    const response = await fetch(url, { ...fetchOptions, headers: { Authorization: `Bearer ${token()}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
    if (response.status === 304) return null;
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(value.error || `请求失败 (${response.status})`);
    if (readRevision) value.etag = response.headers.get('etag');
    return value;
  }
  function link(label, url) {
    const node = el('a', label); node.href = url; node.target = '_blank'; node.rel = 'noopener noreferrer'; return node;
  }
  function render() {
    rememberGroups();
    list.replaceChildren();
    const choices = [el('option', '当前会话')]; choices[0].value = '';
    for (const item of data.archives || []) if (item.identity !== (archive ? null : data.identity)) {
      const option = el('option', `历史记录 · ${new Date(item.at).toLocaleDateString('zh-CN')} · ${item.session.agent?.kind || '终端'}`);
      option.value = item.identity; choices.push(option);
    }
    archivePicker.replaceChildren(...choices); archivePicker.value = archive; archivePicker.hidden = choices.length < 2;
    dialog.querySelector('.workfiles-add').hidden = Boolean(archive);
    const records = [...data.items.filter(item => item.kind === tab)];
    if (tab === 'result') for (const page of data.pages) {
      if (!records.some(record => record.versions.at(-1)?.url === page.url)) records.push({
        id: page.id, title: page.title, group: '发布页面', updatedAt: page.updatedAt,
        versions: [{ url: page.url, at: page.updatedAt, revision: page.source?.revision || page.contentHash?.slice(0, 12), evidence: page.evidence }],
      });
    }
    const groups = new Map();
    for (const record of records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
      if (!groups.has(record.group)) groups.set(record.group, []); groups.get(record.group).push(record);
    }
    let first = true;
    for (const [group, records] of groups) {
      const section = el('details', null, 'workfiles-group'); section.dataset.group = group;
      section.open = groupState.has(group) ? groupState.get(group) : first; first = false;
      section.append(el('summary', `${group} · ${records.length}`));
      for (const record of records) {
        const item = el('article'), version = record.versions.at(-1); item.dataset.recordId = record.id;
        item.append(el('h3', record.title));
        let origin = version.sourcePath || version.fileName || '发布页面';
        if (version.url?.startsWith('https://')) origin = new URL(version.url).hostname;
        const date = version.date ? `资料日期 ${version.date}` : `登记于 ${new Date(version.at).toLocaleString('zh-CN', { hour12: false })}`;
        item.append(el('p', `${origin} · ${date}${version.revision ? ` · ${version.revision}` : ''}`));
        if (tab === 'result') item.append(el('p', version.evidence ? '已附验证记录 · 以记录范围为准' : '未附验证记录'));
        if (version.sourceState === 'changed' || version.sourceState === 'missing') item.append(el('p', version.sourceState === 'changed'
          ? '原文件有更新迹象 · 当前为登记快照' : '原文件已不存在 · 快照仍可用', 'workfiles-version-notice'));
        const actions = el('div', null, 'workfiles-actions');
        const href = v => v.url || v.downloadUrl;
        if (!version.url) {
          const open = el('button', '预览'); open.type = 'button'; open.onclick = () => openPreview(record, version, open); actions.append(open);
        }
        actions.append(link(version.url ? '打开' : '下载', href(version)));
        if (record.versions.length > 1) {
          const history = el('details'), summary = el('summary', `版本 · ${record.versions.length}`); history.append(summary);
          for (const v of [...record.versions].reverse()) {
            const label = v.revision || new Date(v.at).toLocaleString('zh-CN', { hour12: false });
            if (v.url) history.append(link(label, href(v)));
            else { const open = el('button', label); open.type = 'button'; open.onclick = () => openPreview(record, v, open); history.append(open); }
          }
          actions.append(history);
        }
        if (!archive && data.items.some(value => value.id === record.id)) {
          const edit = el('button', '编辑'); edit.type = 'button';
          edit.onclick = () => {
            const editor = el('form', null, 'workfiles-editor');
            const titleLabel = el('label', '标题'), title = el('input'); title.value = record.title; title.required = true; title.maxLength = 256; titleLabel.append(title);
            const groupLabel = el('label', '工作主题'), groupInput = el('input'); groupInput.value = record.group; groupInput.required = true; groupInput.maxLength = 256; groupLabel.append(groupInput);
            const save = el('button', '保存'); save.type = 'submit'; const cancel = el('button', '取消'); cancel.type = 'button'; cancel.onclick = () => editor.remove();
            editor.append(titleLabel, groupLabel, save, cancel); item.append(editor); title.focus(); edit.disabled = true;
            cancel.onclick = () => { editor.remove(); edit.disabled = false; };
            editor.onsubmit = async event => {
              event.preventDefault(); save.disabled = true;
              const turn = generation;
              try { await request(`${endpoint()}/${record.id}`, { method: 'PATCH', body: JSON.stringify({ identity: data.identity, title: title.value, group: groupInput.value }) }); if (current() && turn === generation) await load(); }
              catch (error) { if (current() && turn === generation) { status.textContent = error.message; save.disabled = false; } }
            };
          };
          actions.append(edit);
        }
        item.append(actions); section.append(item);
      }
      list.append(section);
    }
    if (!records.length) list.append(el('p', tab === 'source' ? '暂无资料。上传文件或添加本次使用的链接。' : '暂无成果。Agent 发布的页面和登记的文件会显示在这里。', 'workfiles-empty'));
  }
  function rememberGroups() {
    for (const node of list.querySelectorAll('.workfiles-group')) groupState.set(node.dataset.group, node.open);
  }
  function closePreview(restore = true) {
    const previous = previewState; previewState = null; previewSequence++; previewController?.abort();
    previewBody.replaceChildren(); preview.hidden = true; dialog.classList.remove('is-preview'); browser.hidden = false;
    if (restore && previous) { dialog.scrollTop = previous.scroll; previous.trigger?.focus({ preventScroll: true }); }
  }
  function openPreview(record, version, trigger) {
    previewState = { record, version, scroll: dialog.scrollTop, trigger, identity: data.identity };
    preview.querySelector('.workfiles-verification').open = false;
    browser.hidden = true; preview.hidden = false; dialog.classList.add('is-preview'); dialog.scrollTop = 0;
    preview.querySelector('[data-back]').focus({ preventScroll: true }); void loadPreview(previewState);
  }
  async function loadPreview(state) {
    const sequence = ++previewSequence; previewController?.abort(); previewController = new AbortController();
    const signal = AbortSignal.any([previewController.signal, AbortSignal.timeout(15_000)]);
    const active = () => current() && previewState === state && sequence === previewSequence;
    previewBody.replaceChildren(); previewStatus.textContent = '正在读取预览…'; previewRetry.hidden = true;
    previewDownload.removeAttribute('href');
    preview.querySelector('[data-preview-title]').textContent = state.record.title;
    preview.querySelector('[data-preview-version]').textContent = '';
    preview.querySelector('[data-preview-evidence]').replaceChildren();
    try {
      // Renew scoped links even if an old version menu has been open for a while.
      const fresh = await request(`${endpoint()}?${new URLSearchParams({ archive: state.identity })}`, { signal });
      if (!active()) return;
      const record = fresh.items.find(item => item.id === state.record.id), version = record?.versions.find(item => item.id === state.version.id);
      if (!version?.downloadUrl) throw new Error('此文件版本暂不可用');
      const label = version.revision || version.contentHash?.slice(0, 12) || version.id.slice(0, 12);
      const historical = record.versions.at(-1).id !== version.id;
      preview.querySelector('[data-preview-version]').textContent = `${historical ? '历史快照' : '登记快照'} · ${label} · ${new Date(version.at).toLocaleString('zh-CN', { hour12: false })}`;
      previewDownload.href = version.downloadUrl;
      const evidence = preview.querySelector('[data-preview-evidence]');
      const source = { changed: '原文件有更新迹象，当前快照不会自动替换；请重新登记新版本。', missing: '原文件已不存在，登记快照仍然可用。', unchanged: '原文件时间与大小未变；这不是对内容或结论的验证。', unknown: '未核验原文件当前状态。', unavailable: '暂时无法核验原文件当前状态。' };
      evidence.append(el('p', source[version.sourceState || 'unknown']));
      if (version.contentHash) evidence.append(el('p', `内容标识 SHA-256：${version.contentHash}`));
      if (version.evidence) {
        const value = version.evidence; evidence.append(el('p', value.summary), el('p', `验证对应版本：${value.version}`));
        const checks = el('ul');
        for (const check of value.checks) checks.append(el('li', `${{ passed: '通过', failed: '失败', 'not-run': '未执行' }[check.result]} · ${check.method}${check.reference ? ` · ${check.reference}` : ''}`));
        evidence.append(checks, el('b', '未验证事项与限制'));
        if (value.limitations.length) { const limitations = el('ul'); for (const text of value.limitations) limitations.append(el('li', text)); evidence.append(limitations); }
        else evidence.append(el('p', '提交者未列出限制，不代表已覆盖全部场景。'));
        evidence.append(el('p', '记录由提交者提供，仅对应此快照，不代表原文件当前状态已验收。'));
      } else evidence.append(el('p', '此版本未附验证记录。已保存不代表已验证。'));
      const format = workfileFormat(version.fileName), url = `${version.downloadUrl}&preview=1`;
      if (format === 'image') {
        const image = el('img'); image.alt = `${state.record.title} · ${label}`;
        image.onload = () => { if (active()) previewStatus.textContent = ''; };
        image.onerror = () => { if (active()) { previewStatus.textContent = '图片未能显示，可重试或下载查看。'; previewRetry.hidden = false; } };
        image.src = url; previewBody.append(image);
      } else if (format === 'pdf') {
        const frame = el('iframe'); frame.title = `${state.record.title} PDF 预览`; frame.referrerPolicy = 'no-referrer'; frame.src = url;
        previewBody.append(el('p', '若浏览器无法内嵌显示 PDF，可下载查看。'), frame); previewStatus.textContent = '';
      } else if (format === 'text' || format === 'markdown') {
        const response = await fetch(url, { signal });
        if (!response.ok) throw new Error(`读取预览失败 (${response.status})`);
        const result = await readPreviewText(response);
        if (!active()) return;
        if (format === 'markdown') renderWorkfileMarkdown(previewBody, result.text);
        else previewBody.append(el('pre', result.text));
        previewStatus.textContent = result.truncated ? '仅预览前 256 KiB，完整内容请下载。' : '';
      } else previewStatus.textContent = '此类型暂不支持预览，请下载文件。';
    } catch (error) {
      if (active()) { previewStatus.textContent = error.message; previewRetry.hidden = false; }
    }
  }
  preview.querySelector('[data-back]').onclick = () => closePreview();
  previewRetry.onclick = () => { if (previewState) void loadPreview(previewState); };
  dialog.addEventListener('cancel', event => { if (previewState) { event.preventDefault(); closePreview(); } });
  async function load() {
    const turn = ++generation; controller?.abort(); controller = new AbortController();
    loading = true;
    rememberGroups(); data = null; status.textContent = '正在读取…'; list.replaceChildren();
    try {
      const params = uploadWorkContext(new URLSearchParams(), target);
      if (archive) params.set('archive', archive);
      const result = await request(`${endpoint()}?${params}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]), readRevision: true });
      if (!current() || turn !== generation) return;
      data = result; lastRead = Date.now(); status.textContent = ''; render();
    } catch (error) { if (current() && turn === generation) status.textContent = error.message; }
    finally { if (turn === generation) loading = false; }
  }
  const editing = () => previewState || (dialog.querySelector('.workfiles-add').open && [...form.querySelectorAll('input')].some(input => input.value))
    || dialog.querySelector('.workfiles-editor') || upload.disabled
    || list.querySelector('.workfiles-actions details[open]');
  async function refreshAutomatically() {
    autoTimer = null;
    if (!current() || document.hidden) return;
    if (!loading && !autoPending && !editing()) {
      autoPending = true;
      const turn = generation;
      controller = new AbortController();
      try {
        const params = uploadWorkContext(new URLSearchParams(), target);
        if (archive) params.set('archive', archive);
        const headers = data?.etag && Date.now() - lastRead < 120_000 ? { 'If-None-Match': data.etag } : {};
        const result = await request(`${endpoint()}?${params}`, { headers, readRevision: true,
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) });
        if (current() && turn === generation && !editing()) {
          if (result) {
            const active = document.activeElement, scroll = dialog.scrollTop;
            const record = active?.closest('article')?.dataset.recordId;
            const group = active?.closest('.workfiles-group')?.dataset.group;
            const label = active?.textContent, tag = active?.tagName;
            data = result; lastRead = Date.now(); render();
            if (list.contains(active) || record || group) {
              const host = record ? [...list.querySelectorAll('article')].find(node => node.dataset.recordId === record)
                : [...list.querySelectorAll('.workfiles-group')].find(node => node.dataset.group === group);
              [...(host?.querySelectorAll('a,button,summary') || [])].find(node => node.tagName === tag && node.textContent === label)?.focus({ preventScroll: true });
            }
            dialog.scrollTop = scroll;
          }
          status.textContent = '';
        }
      } catch (error) {
        if (current() && turn === generation && error.name !== 'AbortError') status.textContent = '自动刷新暂不可用，将继续重试。也可点击右上角刷新。';
      } finally { autoPending = false; }
    }
    clearTimeout(autoTimer);
    if (current() && !document.hidden) autoTimer = setTimeout(refreshAutomatically, refreshIntervalMs);
  }
  button.onclick = () => {
    target = getTarget(); if (!target || !enabled()) return;
    archive = '';
    groupState.clear();
    dialog.querySelector('[data-session]').textContent = target.name;
    form.reset(); dialog.querySelector('.workfiles-add').open = false; dialog.showModal(); void load();
    clearTimeout(autoTimer); autoTimer = setTimeout(refreshAutomatically, refreshIntervalMs);
  };
  dialog.querySelector('[data-close]').onclick = () => dialog.close();
  dialog.querySelector('[data-refresh]').onclick = load;
  archivePicker.onchange = () => { archive = archivePicker.value; void load(); };
  dialog.addEventListener('close', () => { closePreview(false); generation++; controller?.abort(); loading = false; clearTimeout(autoTimer); button.focus(); });
  document.addEventListener('visibilitychange', () => {
    clearTimeout(autoTimer);
    if (current() && !document.hidden) void refreshAutomatically();
  });
  for (const button of dialog.querySelectorAll('[data-tab]')) button.onclick = () => {
    tab = button.dataset.tab;
    for (const peer of dialog.querySelectorAll('[data-tab]')) peer.setAttribute('aria-pressed', String(peer === button));
    dialog.querySelector('.workfiles-add summary').textContent = tab === 'source' ? '＋ 添加资料' : '＋ 添加成果';
    dialog.querySelector('.workfiles-upload').hidden = tab !== 'source';
    if (data) render();
  };
  form.onsubmit = async event => {
    event.preventDefault(); if (!current() || !data) return;
    const submit = form.querySelector('button'); submit.disabled = true;
    const turn = generation;
    const value = Object.fromEntries(new FormData(form));
    try {
      await request(endpoint(), { method: 'POST', body: JSON.stringify({ ...value, identity: data.identity, key: value.url, kind: tab }) });
      if (current() && turn === generation) { form.reset(); await load(); }
    } catch (error) { if (current() && turn === generation) status.textContent = error.message; }
    finally { submit.disabled = false; }
  };
  const upload = dialog.querySelector('input[type=file]');
  upload.onchange = async () => {
    if (!current()) return;
    const captured = target, active = key(target), turn = generation; upload.disabled = true;
    try {
      for (const file of upload.files) {
        if (!current() || generation !== turn) break;
        const params = uploadWorkContext(new URLSearchParams({ name: `${crypto.randomUUID()}-${file.name}`, workTitle: file.name }), captured);
        const result = await request(`/api/uploads/files?${params}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
        if (result.workfilesError) throw new Error(result.workfilesError);
      }
      if (current() && key(target) === active && turn === generation) await load();
    } catch (error) { if (current() && key(target) === active && turn === generation) status.textContent = error.message; }
    finally { upload.disabled = false; upload.value = ''; }
  };
  return { sync() {
    button.hidden = !enabled() || !getTarget();
    if (dialog.open && !current()) { closePreview(false); dialog.close(); }
  } };
}
