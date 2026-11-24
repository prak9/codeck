// AGY renders slash overlays below its framed composer. Only the rows inside
// that frame's current overlay may authorize keystrokes.
const titles = [
  ['model', /^Switch Model$/i], ['effort', /^Set Effort$/i],
  ['help', /^Antigravity CLI\s+(?:general|commands|shortcuts)\b/i],
  ['credits', /^Antigravity CLI\s+credits\b/i], ['changelog', /^(?:Antigravity CLI )?Changelog\b/i],
  ['skills', /^Skills\b/i], ['tasks', /^Tasks\b/i], ['permissions', /^(?:Permission(?: Config Editor|s\b)|(?:Add|Edit) Rule —)/i],
  ['hooks', /^(?:Hooks\b|.+ — Matchers$)/i], ['agents', /^Create New Agents$/i],
  ['artifact', /^Artifacts?\b/i], ['diff', /^Diff\b/i], ['context', /Context Usage$/i],
  ['mcp', /^MCP Servers\b/i], ['plugin', /^Plugins\b/i], ['projects', /^Projects\b/i],
  ['usage', /Models & Quota$/i], ['config', /^Settings$/i], ['codesearch', /^Code Search:/i],
  ['resume', /^CLI\s+Other\s+\(tab to cycle\)/i], ['rewind', /^Rewind Conversation$/i],
  ['feedback', /^(?:Submit Feedback|Review Submission Data)\b/i],
];
const keyNames = {
  '↑': 'Up', '↓': 'Down', '←': 'Left', '→': 'Right', enter: 'Enter', tab: 'Tab', space: 'Space',
  backspace: 'BSpace', '⌫': 'BSpace', pgup: 'PageUp', pgdown: 'PageDown', 'ctrl+end': 'C-End', 'ctrl+home': 'C-Home',
};
const labels = { Up: '↑', Down: '↓', Left: '←', Right: '→', BSpace: 'Backspace', PageUp: 'PgUp',
  PageDown: 'PgDn', 'C-End': 'Ctrl+End', 'C-Home': 'Ctrl+Home' };

function actions(footer) {
  const items = new Map();
  for (const hint of footer.replace(/^Keyboard:\s*/i, '').split(/\t+|\s{2,}|\s*·\s*/u)) {
    const match = /^(\S+)\s+(.+)$/u.exec(hint.trim());
    if (!match) continue;
    const [, binding, description] = match;
    const digits = /^(\d)-(\d)$/.exec(binding);
    const tokens = binding.toLowerCase().split('/');
    if (digits) {
      tokens.length = 0;
      for (let n = Number(digits[1]); n <= Number(digits[2]); n++) tokens.push(String(n));
    }
    for (const token of tokens) {
      let key = Object.hasOwn(keyNames, token) && keyNames[token];
      if (/^[a-z0-9?]$/.test(token)) key = token;
      if (/^f[1-9]$/.test(token)) key = token.toUpperCase();
      if (/^ctrl\+[a-z]$/.test(token)) key = 'C-' + token.at(-1);
      if (key) items.set(key, { label: labels[key] || key, key, description });
    }
  }
  return [...items.values()];
}

export function agyCommandMenu(screen) {
  const lines = String(screen || '').trimEnd().split('\n').map(line => line.trimEnd());
  const divider = lines.findLastIndex(line => /^─{4,}$/u.test(line));
  const framed = divider >= 2 && /^>/.test(lines[divider - 1]) && /^─{4,}$/u.test(lines[divider - 2]);
  // Diff and changelog can take over the entire pane without a composer.
  const rows = framed ? lines.slice(divider + 1) : lines;
  if (!framed && !titles.some(([, pattern]) => pattern.test(rows.find(line => line.trim())?.trim() || ''))) return null;
  while (rows.length && !rows[0].trim()) rows.shift();
  const heading = rows[0]?.trim();
  if (!heading || /^(?:[>/?]|esc to cancel\b)/iu.test(heading)) return null;
  // Everything after the shortcut legend must belong to that legend or the
  // right-aligned model status. Old menus above a composer are not live.
  if (/^\? for shortcuts(?:\s|$)/i.test(rows.at(-1))) rows.pop();
  else if (/^\s{2,}\S/.test(rows.at(-1)) && !/(?:[↑↓←→]|\b(?:esc|enter|tab|ctrl\+)\b)/iu.test(rows.at(-1))
    && (rows.at(-2) === '' || /\s·\s\w+$/u.test(rows.at(-1)))) rows.pop();
  while (rows.length && !rows.at(-1)) rows.pop();
  let start = rows.findLastIndex(line => /^\s*Keyboard:/iu.test(line));
  if (start < 0) start = rows.findLastIndex(line =>
    /^\s*(?:[↑↓←→]|esc\b|ctrl\+\w+\s)/iu.test(line) && /\s(?:·| {1,})\s*\S+/u.test(line));
  if (start < 1 || rows.slice(0, start).some(line => /^>\s*$|^─{4,}$/u.test(line))) return null;
  const footer = rows.slice(start);
  if (footer.some((line, i) => i && !/^\s+\S/u.test(line))) return null;
  const text = rows.join('\n');
  if (text.length > 64_000) return null;
  const footerText = footer.map(line => line.trim()).join('  ');
  const items = actions(footerText);
  if (!items.length && !/\besc\s+\w/i.test(footerText)) return null;
  const cmd = titles.find(([, pattern]) => pattern.test(heading))?.[0] || 'menu';
  const parsed = { heading, dashboard: true, items, notes: [] };
  if (cmd === 'model') {
    const cursor = rows.findIndex(line => /^> \S/.test(line));
    if (cursor > 0) {
      let first = cursor, last = cursor;
      while (first > 0 && /^ {2}\S/.test(rows[first - 1])) first--;
      while (last < start - 1 && /^ {2}\S/.test(rows[last + 1])) last++;
      parsed.models = rows.slice(first, last + 1).map(line => line.slice(2).trim().replace(/\s+\(current\)$/i, ''));
      parsed.highlighted = parsed.models[cursor - first];
    }
  }
  parsed.textEntry = rows.slice(0, start).some(line => /^(?:Search:|Type to search\b|Additional Details \(optional\):|Enter .+:$)/iu.test(line.trim()));
  return { command: '/' + cmd, kind: 'commandSelection', dismissible: true, text, parsed };
}
