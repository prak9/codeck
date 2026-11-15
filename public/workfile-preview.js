export function workfileFormat(name = '') {
  const extension = name.split('.').at(-1).toLowerCase();
  if (['md', 'markdown'].includes(extension)) return 'markdown';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(extension)) return 'image';
  if (extension === 'pdf') return 'pdf';
  return ['txt', 'log', 'csv', 'tsv', 'json', 'yaml', 'yml', 'toml', 'ini', 'py', 'js', 'ts', 'css', 'html', 'xml'].includes(extension) ? 'text' : 'download';
}

// Bound the preview, not the underlying upload/download. Do not materialize a
// multi-GB file just to show its opening paragraphs.
export async function readPreviewText(response, limit = 256 * 1024) {
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let text = '', bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return { text: text + decoder.decode(), truncated: false };
      const available = limit - bytes;
      text += decoder.decode(value.subarray(0, available), { stream: true });
      bytes += Math.min(available, value.length);
      if (value.length > available) { await reader.cancel(); return { text, truncated: true }; }
    }
  } finally { reader.releaseLock(); }
}

function inline(host, text) {
  let offset = 0, plain = '';
  const flush = () => { if (plain) host.append(document.createTextNode(plain)); plain = ''; };
  while (offset < text.length) {
    let node, end;
    if (text[offset] === '`') {
      end = text.indexOf('`', offset + 1);
      if (end < 0) { plain += text.slice(offset); break; }
      node = document.createElement('code'); node.textContent = text.slice(offset + 1, end); end++;
    } else if (text.startsWith('**', offset)) {
      end = text.indexOf('**', offset + 2);
      if (end < 0) { plain += text.slice(offset); break; }
      node = document.createElement('strong'); node.textContent = text.slice(offset + 2, end); end += 2;
    } else if (text[offset] === '[') {
      const labelEnd = text.indexOf('](', offset + 1);
      if (labelEnd < 0) { plain += text.slice(offset); break; }
      end = text.indexOf(')', labelEnd + 2);
      if (end < 0) { plain += text.slice(offset); break; }
      let url; try { url = new URL(text.slice(labelEnd + 2, end), location.href); } catch { /* Invalid links remain text. */ }
      if (url && ['https:', 'http:'].includes(url.protocol)) {
        node = document.createElement('a'); node.textContent = text.slice(offset + 1, labelEnd); node.href = url.href;
        node.target = '_blank'; node.rel = 'noopener noreferrer';
      } else node = document.createTextNode(text.slice(offset, end + 1));
      end++;
    } else { plain += text[offset++]; continue; }
    flush(); host.append(node); offset = end;
  }
  flush();
}

// A deliberately small DOM renderer for reports. Raw HTML remains text; embedded
// images/scripts are never loaded or executed. No innerHTML or new dependencies.
export function renderWorkfileMarkdown(host, source) {
  const lines = source.replaceAll('\r\n', '\n').split('\n');
  const cells = line => line.trim().replace(/^\|/u, '').replace(/\|$/u, '').split('|').map(cell => cell.trim());
  const separator = line => cells(line).every(cell => /^:?-{3,}:?$/u.test(cell));
  host.replaceChildren();
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index++; continue; }
    const fence = line.match(/^\s*(`{3,}|~{3,})/u);
    if (fence) {
      const pre = document.createElement('pre'), code = document.createElement('code'), content = []; index++;
      while (index < lines.length && !lines[index].trimStart().startsWith(fence[1])) content.push(lines[index++]);
      code.textContent = content.join('\n'); pre.append(code); host.append(pre); index++; continue;
    }
    if (line.includes('|') && index + 1 < lines.length && separator(lines[index + 1])) {
      const table = document.createElement('table'), head = document.createElement('thead'), body = document.createElement('tbody');
      const row = (values, tag) => { const tr = document.createElement('tr'); for (const value of values) { const cell = document.createElement(tag); inline(cell, value); tr.append(cell); } return tr; };
      head.append(row(cells(line), 'th')); index += 2;
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) body.append(row(cells(lines[index++]), 'td'));
      table.append(head, body); const scroll = document.createElement('div'); scroll.className = 'workfiles-table'; scroll.append(table); host.append(scroll); continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/u), list = line.match(/^\s*(?:([-*+])|\d+\.)\s+(.+)$/u);
    if (list) {
      const ordered = !list[1], node = document.createElement(ordered ? 'ol' : 'ul');
      while (index < lines.length) {
        const item = lines[index].match(/^\s*(?:([-*+])|\d+\.)\s+(.+)$/u);
        if (!item || !item[1] !== ordered) break;
        const li = document.createElement('li'); inline(li, item[2]); node.append(li); index++;
      }
      host.append(node); continue;
    }
    const node = document.createElement(heading ? `h${heading[1].length}` : line.startsWith('> ') ? 'blockquote' : 'p');
    inline(node, heading ? heading[2] : line.replace(/^> /u, '')); host.append(node); index++;
  }
}
