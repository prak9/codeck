export function sessionCommandCapabilities(provider) {
  return {
    modelSelection: provider === 'codex',
    dismissCommands: provider === 'codex' ? ['/model', '/skills', '/usage', '/status', '/clear'] : [],
  };
}

export function clearSessionCommandConfirmation() {
  return { command: '/clear', text: '清空当前对话？', kind: 'commandSelection', dismissible: false,
    parsed: { heading: '清空当前对话？', cursor: 1, notes: ['保留会话入口，清空当前 CLI 的对话上下文。'],
      items: [{ label: '清空当前对话', description: '开始新的对话上下文' }, { label: '取消', description: '保留当前对话' }] } };
}

// Shared by the server adapter and the older-server compatibility path. Keep
// raw output even when a native command has no supported Remote interaction.
export function normalizeSessionCommandOutput(provider, command, result, capabilities = sessionCommandCapabilities(provider)) {
  if (result?.commandOutput) return result.commandOutput;
  if (typeof result?.terminalOutput !== 'string' || !result.terminalOutput) return null;
  const text = result.terminalOutput;
  const output = { command, text, kind: 'output', dismissible: capabilities.dismissCommands?.includes(command) === true };
  if (provider === 'codex' && capabilities.dismissCommands?.includes(command)) {
    const parsed = parseSessionCommandMenu(command, text);
    if (parsed) return { ...output, kind: parsed.info ? 'output' : 'commandSelection', parsed };
  }
  if (command === '/model' && capabilities.modelSelection
    && /^\s*(?:select model and effort|select reasoning level for .+|advanced reasoning|(?:current|choose|select|available)\s+models?)\s*$/imu.test(text)) {
    const parsed = parseModelCommandOutput(text);
    if (parsed.items.length) return { ...output, kind: 'modelSelection', parsed };
  }
  if (command === '/skills' && !/^[›>❯]\s*\d+\./mu.test(text)) {
    return { ...output, kind: 'skills', parsed: parseSkillsCommandOutput(text) };
  }
  return output;
}

// A visible native footer, known command heading, and one cursor are required.
// Transcript copies and a picker followed by a composer are never actionable.
export function parseSessionCommandMenu(command, text) {
  if (command === '/usage') {
    const rows = String(text || '').split('\n').map(line => line.trim()).filter(Boolean);
    const header = rows.findLastIndex(line => /^Usage\s*·/u.test(line));
    const footer = rows.at(-1);
    const tabs = rows[header + 1]?.replace(/[‹›]/gu, '').trim() || '';
    if (header >= 0 && /^(?:\d+\s+)?(?:Overview|Usage|Messages|Plugins|Skills|Chats)(?:\s+(?:\d+\s+)?(?:Overview|Usage|Messages|Plugins|Skills|Chats)){1,5}$/u.test(tabs)
      && /^(?:tab\/1[–-]6 report\s*·\s*z dashboard\s*·\s*\? help\s*·\s*R refresh|tab report\s*·\s*z all\s*·\s*\?\s*·\s*R refresh|\? close help)$/u.test(footer || '')
      && /^(?:pgup\/pgdn scroll\s*·\s*)?esc back$/u.test(rows.at(-2) || '')) {
      const items = ['总览', '用量', '消息', '插件', 'Skills', '对话'].map((label, index) => ({ label, description: '', key: String(index + 1) }));
      items.push(...[['切换周期', 'g'], ['仪表盘', 'z'], ['刷新', 'R'], ['←', 'Left'], ['→', 'Right'], ['↑', 'Up'], ['↓', 'Down'],
        ['展开／收起', 'Enter'], ['上一页', 'PPage'], ['下一页', 'NPage'], ['帮助', '?']].map(([label, key]) => ({ label, description: '', key })));
      const help = footer === '? close help';
      if (help) items.splice(0, items.length, { label: '返回用量', description: '', key: '?' });
      return { heading: help ? '用量快捷操作' : '用量分析', dashboard: true, items, cursor: -1, notes: [],
        signature: JSON.stringify(['usage-dashboard', rows[header], items]), raw: text };
    }
  }
  const headings = {
    '/usage': /^(?:Usage|Usage limit resets)$/iu,
    '/status': /^(?:Status|Session status|Account status)$/iu,
    '/clear': /^(?:Clear(?: (?:conversation|chat|context|session|history))?\??|Clear (?:your |the |current )?(?:conversation|chat|context|session|history)\??|Are you sure you want to clear.*\??)$/iu,
  };
  if (!headings[command]) return null;
  const lines = String(text || '').split('\n').map(line => line.replace(/^\s*[│║](.*)[│║]\s*$/u, '$1').trim())
    .filter(line => line && !/^[╭┌╔╰└╚].*[╮┐╗╯┘╝]$/u.test(line));
  if (command === '/usage' && lines.at(-1) === 'esc back') {
    const start = lines.findLastIndex(line => line === 'Usage limit resets');
    if (start >= 0 && !lines.slice(start).some(line => /^[›>❯]?\s*\d+\./u.test(line))) {
      return { heading: lines[start], info: true, items: [], cursor: -1, notes: [], raw: text,
        signature: JSON.stringify(lines.slice(start)) };
    }
  }
  const end = lines.findLastIndex(line => /^(?:Press enter to |enter (?:select|open|choose|confirm)\s*[·•])/iu.test(line));
  const footer = lines.slice(end).join(' ');
  if (end < 0 || !/^(?:Press enter to confirm or esc to (?:go back|cancel|close)\.?|enter (?:select|open|choose|confirm)\s*[·•]\s*esc (?:back|cancel|close))$/iu.test(footer)) return null;
  const start = lines.slice(0, end).findLastIndex(line => headings[command].test(line));
  if (start < 0) return null;
  const items = [], notes = [];
  let cursor = -1;
  for (const line of lines.slice(start + 1, end)) {
    const row = /^([›>❯])?\s*(\d+)\.\s+(.+)$/u.exec(line);
    if (!row) { if (items.length) items.at(-1).description += ` ${line}`; else notes.push(line); continue; }
    if (Number(row[2]) !== items.length + 1) return null;
    if (row[1]) { if (cursor >= 0) return null; cursor = items.length; }
    const [label, ...description] = row[3].split(/\s{2,}/u);
    items.push({ label: label.trim(), description: description.join(' ').trim() });
  }
  if (!items.length || cursor < 0 || new Set(items.map(item => item.label)).size !== items.length) return null;
  const heading = lines[start];
  return { heading, items, notes, cursor, signature: JSON.stringify([heading, items, notes]), raw: text };
}

function stripCommandPrefix(line) {
  return String(line || '').replace(/^[•◦▪▫*-]\s*/, '').trim();
}

function splitCommandLabel(line) {
  const normalized = stripCommandPrefix(line);
  if (!normalized) return null;
  const parts = normalized.split(/\s{2,}|(?:\s+[—–|:]\s+)|(?:\s+·\s+)/u).map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 2) {
    return { label: parts[0], description: parts.slice(1).join(' ') };
  }
  if (/^[A-Za-z0-9._/@+-]{2,64}$/.test(normalized)) {
    return { label: normalized, description: '' };
  }
  return null;
}

function splitModelLabel(line) {
  const normalized = stripCommandPrefix(line);
  if (!normalized) return null;
  const parts = normalized.split(/\s{2,}|(?:\s+[—–|:]\s+)|(?:\s+·\s+)/u).map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 2) {
    return { label: parts[0], description: parts.slice(1).join(' ') };
  }
  const singleSpace = /^([A-Za-z0-9][A-Za-z0-9._/@+-]{1,63})(?:\s+(.+))?$/.exec(normalized);
  if (singleSpace?.[2] && /^[A-Za-z]/.test(singleSpace[2])) {
    return { label: singleSpace[1], description: singleSpace[2] };
  }
  if (/^[A-Za-z0-9][A-Za-z0-9._/@+-]{1,63}(?:\s+[A-Za-z0-9._/@+-]{1,63}){0,3}$/.test(normalized)) {
    return { label: normalized, description: '' };
  }
  return null;
}

function splitNumberedModelLabel(line) {
  const match = /^[›>❯]?\s*\d+\.\s+(.+)$/u.exec(line);
  if (!match) return null;
  const current = /^(.*?)\s+\(current\)(?:\s+(.*))?$/iu.exec(match[1]);
  if (current) {
    return {
      label: current[1].trim(),
      description: (current[2] || '').trim(),
      current: true,
    };
  }
  const parts = match[1].split(/\s{2,}/u).map((part) => part.trim()).filter(Boolean);
  return {
    label: parts[0] || '',
    description: parts.slice(1).join(' '),
    current: false,
  };
}

export function parseSkillsCommandOutput(text) {
  const raw = String(text || '');
  const lines = raw.split('\n').map((line) => line.replace(/\s+$/u, ''));
  const items = [];
  const notes = [];
  let heading = '';
  let count = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^[─━═\-]{4,}$/u.test(trimmed)) continue;
    if (!heading && /^skills?$/iu.test(trimmed)) {
      heading = trimmed;
      continue;
    }
    if (!count && /(?:^|\b)\d+\s+skills?\b/iu.test(trimmed)) {
      count = trimmed;
      continue;
    }
    const item = splitCommandLabel(trimmed);
    if (item) items.push(item);
    else notes.push(trimmed);
  }

  return {
    heading: heading || 'Skills',
    count,
    items,
    notes,
    raw,
  };
}

export function parseModelCommandOutput(text) {
  const raw = String(text || '');
  const lines = raw.split('\n').map((line) => line.replace(/\s+$/u, ''));
  const items = [];
  const notes = [];
  let heading = '';
  let count = '';
  let selected = '';
  const numberedPicker = lines.some((line) => /^[›>❯]?\s*\d+\.\s+/u.test(line.trim()));

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^[─━═\-]{4,}$/u.test(trimmed)) continue;
    if (!heading && /^(?:(?:current|choose|select|available)?\s*models?|select model and effort|select reasoning level for .+|advanced reasoning)$/iu.test(trimmed)) {
      heading = trimmed;
      continue;
    }
    if (!count && /(?:^|\b)\d+\s+models?\b/iu.test(trimmed)) {
      count = trimmed;
      continue;
    }
    if (!selected && /^(?:current|selected)\s+model[:：]\s*/iu.test(trimmed)) {
      selected = trimmed.replace(/^(?:current|selected)\s+model[:：]\s*/iu, '').trim();
      continue;
    }
    const numbered = splitNumberedModelLabel(trimmed);
    if (numbered?.label) {
      const { current, ...item } = numbered;
      items.push(item);
      if (current) selected = item.label;
      continue;
    }
    if (numberedPicker) {
      notes.push(trimmed);
      continue;
    }
    const item = splitModelLabel(trimmed);
    if (item) {
      items.push(item);
      continue;
    }
    notes.push(trimmed);
  }

  return {
    heading: heading || 'Model',
    scopeSelection: /enter default\s*[·•]\s*s session\s*[·•]\s*esc back/iu.test(raw),
    count,
    selected,
    items,
    notes,
    raw,
  };
}
