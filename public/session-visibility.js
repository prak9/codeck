export const SESSION_VISIBILITY_STORAGE_KEY = 'codeck-hidden-session-prefixes-v1';
export const SESSION_FOLDER_PREFIXES_STORAGE_KEY = 'codeck-session-folder-prefixes-v1';
export const SESSION_FOLDER_EXPANSION_STORAGE_KEY = 'codeck-expanded-session-folders-v1';

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

export function groupSessionsByPrefix(items, folderPrefixes, getName = (item) => item?.name) {
  const prefixes = normalizeSessionPrefixes(folderPrefixes)
    .sort((left, right) => right.length - left.length);
  const folders = new Map();
  const sessions = [];
  for (const item of items || []) {
    const name = String(getName(item) || '');
    const prefix = prefixes.find((candidate) => name.startsWith(candidate));
    if (!prefix) {
      sessions.push({ type: 'session', item });
      continue;
    }
    let folder = folders.get(prefix);
    if (!folder) {
      folder = { type: 'folder', prefix, items: [] };
      folders.set(prefix, folder);
    }
    folder.items.push(item);
  }
  return [...folders.values(), ...sessions];
}

export function setSessionFolderExpanded(expandedPrefixes, prefix, expanded) {
  const normalized = normalizeSessionPrefixes(expandedPrefixes);
  const selected = normalizeSessionPrefixes([prefix])[0];
  if (!selected) return normalized;
  if (expanded && !normalized.includes(selected)) return [...normalized, selected];
  if (!expanded) return normalized.filter((candidate) => candidate !== selected);
  return normalized;
}

function loadSessionPrefixes(storage, key) {
  try {
    const raw = storage?.getItem(key);
    if (!raw) return [];
    return normalizeSessionPrefixes(JSON.parse(raw));
  } catch {
    return [];
  }
}

function saveSessionPrefixes(storage, key, prefixes) {
  const normalized = normalizeSessionPrefixes(prefixes);
  try {
    if (normalized.length) storage?.setItem(key, JSON.stringify(normalized));
    else storage?.removeItem(key);
  } catch {
    // Browser privacy modes can deny localStorage writes. The in-memory rules still apply
    // for this page, while the next load safely falls back to showing every session.
  }
  return normalized;
}

export function loadHiddenSessionPrefixes(storage) {
  return loadSessionPrefixes(storage, SESSION_VISIBILITY_STORAGE_KEY);
}

export function saveHiddenSessionPrefixes(storage, prefixes) {
  return saveSessionPrefixes(storage, SESSION_VISIBILITY_STORAGE_KEY, prefixes);
}

export function loadSessionFolderPrefixes(storage) {
  return loadSessionPrefixes(storage, SESSION_FOLDER_PREFIXES_STORAGE_KEY);
}

export function saveSessionFolderPrefixes(storage, prefixes) {
  return saveSessionPrefixes(storage, SESSION_FOLDER_PREFIXES_STORAGE_KEY, prefixes);
}

export function loadExpandedSessionFolders(storage) {
  return loadSessionPrefixes(storage, SESSION_FOLDER_EXPANSION_STORAGE_KEY);
}

export function saveExpandedSessionFolders(storage, prefixes) {
  return saveSessionPrefixes(storage, SESSION_FOLDER_EXPANSION_STORAGE_KEY, prefixes);
}
