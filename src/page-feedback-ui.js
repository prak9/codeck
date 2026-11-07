// The opaque-origin page may only propose a quote. Saving and sending require
// explicit actions in the authenticated parent, never an iframe message.
function picker() {
  let active = false;
  const paragraphs = () => [...document.querySelectorAll('p,li,h1,h2,h3,h4,blockquote,pre,td')];
  addEventListener('message', event => {
    if (event.source !== parent || event.data?.type !== 'codeck:annotate') return;
    active = event.data.enabled === true;
    document.body.style.cursor = active ? 'text' : '';
  });
  document.addEventListener('click', event => {
    if (!active) return;
    const paragraph = event.target.closest('p,li,h1,h2,h3,h4,blockquote,pre,td');
    if (!paragraph) return;
    const selected = getSelection()?.toString().trim();
    parent.postMessage({ type: 'codeck:quote', quote: (selected || paragraph.textContent).slice(0, 8000), paragraph: paragraphs().indexOf(paragraph) }, '*');
  });
}
export const paragraphPicker = `(${picker.toString()})();`;
function feedbackClient() {
  const panel = document.getElementById('feedback-panel'), toggle = document.getElementById('feedback-toggle');
  const status = document.getElementById('feedback-status'), list = document.getElementById('feedback-list');
  const quote = document.getElementById('feedback-quote'), note = document.getElementById('feedback-note');
  const frame = document.querySelector('iframe');
  const base = location.pathname.replace(/\/$/, '');
  let hash, paragraph = null, comments = [], busy = false;
  document.querySelector('.share-controls').prepend(toggle);
  const request = async (suffix, method = 'GET', body) => {
    const response = await fetch(base + suffix, { method, redirect: 'error', headers: { 'Content-Type': 'application/json', 'X-Codeck-Page-Action': 'feedback' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '操作失败，请刷新后核实');
    return data;
  };
  function render() {
    list.replaceChildren();
    for (const c of comments) {
      const row = document.createElement('li'), text = document.createElement('p'), context = document.createElement('small');
      text.textContent = c.text;
      context.textContent = [c.quote, c.contentHash !== hash ? '旧版批注' : '', c.resolved ? '已解决' : c.delivery ? ({ accepted: '已尝试发送', unknown: '发送未确认，勿重复提交', dispatching: '投递结果待核实' }[c.delivery.status]) : '待发送'].filter(Boolean).join(' · ');
      const resolve = document.createElement('button'); resolve.type = 'button'; resolve.textContent = c.resolved ? '重新打开' : '标记解决';
      resolve.onclick = () => action(async () => { await request('/comments/' + c.id, 'PATCH', { resolved: !c.resolved }); await load(); });
      row.append(text, context, resolve); list.append(row);
    }
  }
  async function load() {
    const data = await request('/comments'); hash = panel.dataset.version; comments = data.comments; render();
    const unavailable = !data.source?.session || data.contentHash !== hash;
    document.getElementById('feedback-save').disabled = document.getElementById('feedback-send').disabled = unavailable;
    if (unavailable) status.textContent = data.contentHash !== hash ? '页面已更新，请刷新后继续批注。' : '页面未关联会话，请让发布者补充来源会话。';
  }
  async function action(fn) {
    if (busy) return;
    busy = true; status.textContent = '';
    try { await fn(); } catch (error) { status.textContent = error.message; }
    finally { busy = false; }
  }
  toggle.onclick = () => {
    panel.hidden = !panel.hidden; document.body.classList.toggle('feedback-open', !panel.hidden); toggle.setAttribute('aria-expanded', String(!panel.hidden));
    frame.contentWindow.postMessage({ type: 'codeck:annotate', enabled: !panel.hidden }, '*');
    if (!panel.hidden) action(load);
  };
  frame.addEventListener('load', () => frame.contentWindow.postMessage({ type: 'codeck:annotate', enabled: !panel.hidden }, '*'));
  addEventListener('message', event => {
    if (panel.hidden || event.source !== frame.contentWindow || event.data?.type !== 'codeck:quote' || typeof event.data.quote !== 'string') return;
    quote.value = event.data.quote.slice(0, 8000); paragraph = Number.isSafeInteger(event.data.paragraph) ? event.data.paragraph : null;
  });
  document.getElementById('feedback-save').onclick = () => action(async () => {
    if (!note.value.trim()) { note.focus(); throw new Error('请填写反馈'); }
    await request('/comments', 'POST', { text: note.value, quote: quote.value, paragraph, contentHash: hash });
    note.value = ''; quote.value = ''; paragraph = null; await load(); status.textContent = '批注已保存';
  });
  document.getElementById('feedback-send').onclick = () => action(async () => {
    const ids = comments.filter(c => !c.resolved && !c.delivery).map(c => c.id);
    if (!ids.length) throw new Error('没有待发送批注');
    const result = await request('/feedback', 'POST', { ids }); await load();
    status.textContent = result.status === 'accepted' ? '已尝试发送到来源会话，请查看 Agent 回复。' : '投递结果待核实，不会自动重发。';
  });
}
export function feedbackControls(nonce, contentHash) {
  return `<button id="feedback-toggle" type="button" aria-expanded="false" aria-controls="feedback-panel">批注</button>
  <aside id="feedback-panel" data-version="${contentHash}" hidden aria-label="页面批注">
  <p>点击正文段落，或选中文字后点击。也可以直接填写全文反馈。</p>
  <label for="feedback-quote">引用</label><textarea id="feedback-quote" rows="2" maxlength="8000"></textarea>
  <label for="feedback-note">反馈</label><textarea id="feedback-note" rows="2" maxlength="4000"></textarea>
  <div><button id="feedback-save" type="button">保存批注</button> <button id="feedback-send" type="button">发送待处理批注</button></div>
  <p id="feedback-status" role="status"></p><ul id="feedback-list"></ul></aside>
  <style>#feedback-panel{position:fixed;right:12px;top:66px;z-index:2;width:min(340px,calc(100vw - 48px));max-height:65vh;overflow:auto;padding:16px;background:#202023;border:1px solid #444448;border-radius:12px;box-shadow:0 12px 32px #0005}#feedback-panel p{margin:0 0 12px;font-size:13px;line-height:1.5}#feedback-panel label{display:block;margin-bottom:6px}#feedback-panel textarea{box-sizing:border-box;width:100%;font:16px system-ui;color:#eee;background:#19191b;border:1px solid #555;border-radius:6px;margin-bottom:12px;padding:8px;resize:vertical}#feedback-panel button{min-height:40px}#feedback-list{margin:0}#feedback-list small{white-space:pre-wrap;overflow-wrap:anywhere;margin-bottom:8px}#feedback-status{margin-top:12px!important}.feedback-open iframe{width:calc(100% - 384px)}@media(max-width:700px){.feedback-open iframe{width:100%;order:1}#feedback-panel{position:static;order:2;width:auto;max-height:38vh;margin:0;padding:12px;border-radius:0;flex-shrink:0}#feedback-panel textarea{max-height:60px}header{flex-wrap:wrap}}</style>
  <script nonce="${nonce}">addEventListener('DOMContentLoaded', ${feedbackClient.toString()});</script>`;
}
