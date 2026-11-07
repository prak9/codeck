export function bindHistorySearch({ token }) {
  const button = document.getElementById('historySearchButton');
  if (!button) return;
  const dialog = document.createElement('dialog');
  dialog.className = 'history-search-dialog'; dialog.setAttribute('aria-label', '搜索历史对话');
  dialog.innerHTML = '<header><strong>搜索历史对话</strong><button type="button" data-close aria-label="关闭历史搜索">×</button></header><form><label for="history-query">对话内容</label><div class="history-query-row"><input id="history-query" type="search" maxlength="200" required autocomplete="off" placeholder="搜索曾讨论的问题或结论"><button>搜索</button></div></form><p class="history-status" role="status"></p><div class="history-results"></div><section class="history-context" hidden aria-label="原始上下文"></section>';
  document.body.append(dialog);
  const form = dialog.querySelector('form'), query = form.querySelector('input');
  const status = dialog.querySelector('.history-status'), results = dialog.querySelector('.history-results'), context = dialog.querySelector('.history-context');
  let generation = 0, controller, timer;
  async function request(url, options = {}) {
    const response = await fetch(url, { ...options, headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' }, signal: controller?.signal });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || '历史读取失败'); return data;
  }
  const text = (tag, value, parent) => { const el = document.createElement(tag); el.textContent = value; parent.append(el); return el; };
  async function showContext(id, run) {
    try {
      const value = await request('/api/history/context/' + encodeURIComponent(id));
      if (run !== generation || !dialog.open) return;
      context.replaceChildren(); context.hidden = false;
      text('h3', '原始上下文', context);
      text('small', `${value.provider} · ${value.threadId} · ${value.cwd || '项目未知'}`, context);
      for (const message of value.messages) {
        const block = document.createElement('article');
        if (message.id === id) block.className = 'history-match';
        text('small', `${message.role === 'user' ? '用户' : 'Agent'} · ${message.at || '时间未知'}`, block);
        text('p', message.text, block); context.append(block);
      }
      text('h4', '关联提交', context);
      if (!value.commits.length) text('p', '暂无已核验关联；正文中的提交号不代表已经核验。', context);
      for (const commit of value.commits) text('p', `${commit.sha.slice(0, 12)} · ${commit.subject}\n${commit.repo}`, context);
      const linkForm = document.createElement('form');
      linkForm.innerHTML = '<label>项目路径<input name="repo" required placeholder="/data/code/project"></label><label>提交 SHA<input name="commit" required pattern="[a-fA-F0-9]{7,40}" placeholder="提交号"></label><button>核验并关联</button><span role="status"></span>';
      linkForm.elements.repo.value = value.cwd || '';
      if (value.mentions?.length) {
        const candidates = document.createElement('p'); text('small', '正文候选（未核验）：', candidates);
        for (const sha of value.mentions) { const choice = text('button', sha, candidates); choice.type = 'button'; choice.onclick = () => { linkForm.elements.commit.value = sha; }; }
        context.append(candidates);
      }
      linkForm.onsubmit = async event => {
        event.preventDefault(); const submit = linkForm.querySelector('button'); submit.disabled = true;
        try { await request('/api/history/commits', { method: 'POST', body: JSON.stringify({ provider: value.provider, threadId: value.threadId, repo: linkForm.elements.repo.value, commit: linkForm.elements.commit.value }) }); await showContext(id, run); }
        catch (error) { linkForm.querySelector('span').textContent = error.message; }
        finally { submit.disabled = false; }
      };
      context.append(linkForm); context.scrollIntoView({ block: 'start', behavior: 'instant' });
    } catch (error) { if (run === generation && error.name !== 'AbortError') status.textContent = error.message; }
  }
  async function search(run, q) {
    try {
      const data = await request('/api/history/search?' + new URLSearchParams({ q }));
      if (run !== generation || !dialog.open) return;
      results.replaceChildren();
      const state = data.status;
      status.textContent = [state.indexing ? `正在索引 ${state.scanned}/${state.total} 个文件，结果尚不完整` : state.error ? `索引不完整：${state.error}` : `${data.results.length} 条结果（最多30条）`, state.skipped ? `${state.skipped} 条异常或超大记录未索引` : '', '历史内容不代表当前结论'].filter(Boolean).join(' · ');
      for (const result of data.results) {
        const row = document.createElement('button'); row.type = 'button'; row.className = 'history-result';
        text('small', `${result.provider} · ${result.threadId} · ${result.at || '时间未知'}`, row);
        text('p', result.excerpt, row); row.onclick = () => { clearTimeout(timer); showContext(result.id, run); }; results.append(row);
      }
      if (state.indexing) timer = setTimeout(() => search(run, q), 1500);
    } catch (error) { if (run === generation && error.name !== 'AbortError') status.textContent = error.message; }
  }
  form.onsubmit = event => {
    event.preventDefault(); controller?.abort(); clearTimeout(timer); controller = new AbortController(); generation++;
    context.hidden = true; results.replaceChildren(); status.textContent = '正在搜索…'; search(generation, query.value.trim());
  };
  button.onclick = () => { dialog.showModal(); query.focus(); };
  dialog.querySelector('[data-close]').onclick = () => dialog.close();
  dialog.addEventListener('close', () => { generation++; controller?.abort(); clearTimeout(timer); button.focus(); });
}
