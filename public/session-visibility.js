export const SESSION_VISIBILITY_STORAGE_KEY = 'codeck-hidden-session-prefixes-v1';

const MAX_PREFIX_RULES = 100;

export function normalizeSessionPrefixes(prefixes) {
  const normalized = [];
  const seen = new Set();
  if (!Array.isArray(prefixes)) return normalized;
  for (const value of prefixes) {
    if (value == null) continue;
    const prefix = String(value).trim();
    if (!prefix || seen.has(prefix)) continue;
    seen.add(prefix);
    normalized.push(prefix);
    if (normalized.length >= MAX_PREFIX_RULES) break;
  }
  return normalized;
}

export function parseSessionPrefixInput(value) {
  return normalizeSessionPrefixes(String(value || '').split(/\r?\n/));
}

export function isSessionVisible(sessionName, hiddenPrefixes) {
  const name = String(sessionName || '');
  return !hiddenPrefixes.some((prefix) => name.startsWith(prefix));
}

export function partitionSessionsByPrefix(items, hiddenPrefixes, getName = (item) => item?.name) {
  const prefixes = normalizeSessionPrefixes(hiddenPrefixes);
  const visible = [];
  const hidden = [];
  for (const item of items || []) {
    (isSessionVisible(getName(item), prefixes) ? visible : hidden).push(item);
  }
  return { visible, hidden };
}

export function loadHiddenSessionPrefixes(storage) {
  try {
    const raw = storage?.getItem(SESSION_VISIBILITY_STORAGE_KEY);
    if (!raw) return [];
    return normalizeSessionPrefixes(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function saveHiddenSessionPrefixes(storage, prefixes) {
  const normalized = normalizeSessionPrefixes(prefixes);
  try {
    if (normalized.length) storage?.setItem(SESSION_VISIBILITY_STORAGE_KEY, JSON.stringify(normalized));
    else storage?.removeItem(SESSION_VISIBILITY_STORAGE_KEY);
  } catch {
    // Browser privacy modes can deny localStorage writes. The in-memory rules still apply
    // for this page, while the next load safely falls back to showing every session.
  }
  return normalized;
}
