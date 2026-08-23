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

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^[─━═\-]{4,}$/u.test(trimmed)) continue;
    if (!heading && /^(?:current|choose|select|available)?\s*models?$/iu.test(trimmed)) {
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
    const item = splitModelLabel(trimmed);
    if (item) {
      items.push(item);
      continue;
    }
    notes.push(trimmed);
  }

  return {
    heading: heading || 'Model',
    count,
    selected,
    items,
    notes,
    raw,
  };
}
