const labels = [['goal', '当前目标'], ['verified', '已验证'], ['current', '正在推进'], ['next', '下一步'], ['constraints', '范围与约束']];
export function renderSessionProgress(host, record, { key = '', onRespond } = {}) {
  if (!host) return;
  const visible = Boolean(record?.text || labels.some(([field]) => record?.progress?.[field]) || record?.progress?.needsUser || record?.progress?.evidence?.length);
  if (!visible) { host.replaceChildren(); host.hidden = true; delete host.dataset.progressKey; delete host.dataset.fingerprint; return; }
  const fingerprint = JSON.stringify([key, record]);
  if (host.dataset.fingerprint === fingerprint) return;
  const open = host.dataset.progressKey === key && Boolean(host.querySelector('details')?.open);
  const el = (tag, text, className) => { const node = document.createElement(tag); if (text != null) node.textContent = text; if (className) node.className = className; return node; };
  const details = el('details', null, 'session-progress'); details.open = open;
  const summary = el('summary');
  summary.append(el('span', record.stale ? '历史进度 · 当前归属待确认' : record.text || record.progress?.goal || '任务进度'));
  if (record.progress?.needsUser && !record.stale) summary.append(el('span', '需要你', 'progress-attention'));
  const body = el('div', null, 'progress-body'), list = el('dl');
  for (const [field, label] of labels) if (record.progress?.[field]) list.append(el('dt', label), el('dd', record.progress[field]));
  if (!record.progress && record.text) list.append(el('dt', '进度记录'), el('dd', record.text));
  body.append(list);
  if (record.progress?.needsUser) {
    const section = el('section', null, 'progress-decision'); section.append(el('b', '需要判断'), el('p', record.progress.needsUser));
    if (!record.stale && onRespond) { const button = el('button', '回到对话回答'); button.type = 'button'; button.onclick = onRespond; section.append(button); }
    body.append(section);
  }
  const links = el('div', null, 'progress-links');
  for (const item of record.progress?.evidence || []) {
    if (!/^(?:https:\/\/|\/pages\/)/u.test(item.url || '') || /[\s\\]/u.test(item.url)) continue;
    const link = el('a', item.label + (item.version ? ` · ${item.version}` : '')); link.href = item.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; links.append(link);
  }
  body.append(links);
  const time = el('time', null, 'progress-updated'); time.dateTime = record.updatedAt || '';
  const date = new Date(record.updatedAt); time.textContent = record.updatedAt && Number.isFinite(date.getTime()) ? `Agent 更新于 ${date.toLocaleString('zh-CN', { hour12: false })}` : '尚无更新时间';
  body.append(time); details.append(summary, body); host.replaceChildren(details); host.hidden = false;
  host.dataset.progressKey = key; host.dataset.fingerprint = fingerprint;
}
