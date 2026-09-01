import { bindMobileScroll } from './mobile-scroll.js';
import {
  bindTerminalRenderWatchdog,
  createTerminalRevealGate,
  createTerminalResizeGate,
  createTerminalWriteQueue,
  fitTerminalGrid,
  isTerminalCopyShortcut,
  resetTerminalInput,
} from './terminal-utils.js?v=11';
import { createSpeechInput, mergeSpeechDraft } from './remote-speech.js?v=6';
import { acceptStreamCursor, acceptStreamFrame } from './stream-state.js?v=3';
import { applySnapshotPatch } from './snapshot-patch.js?v=2';
import { sessionsRenderSignature } from './session-render.js?v=1';
import { terminalComposerKeyAction, terminalDraftForSend, TERMINAL_SHIFT_TAB } from './terminal-compose.js?v=2';
import { hideSharedCodexBackgroundFooter } from './terminal-output.js?v=1';
import {
  SESSION_FOLDER_EXPANSION_STORAGE_KEY,
  SESSION_FOLDER_PREFIXES_STORAGE_KEY,
  SESSION_VISIBILITY_STORAGE_KEY,
  groupSessionsByPrefix,
  loadExpandedSessionFolders,
  loadHiddenSessionPrefixes,
  loadSessionFolderPrefixes,
  parseSessionPrefixInput,
  partitionSessionsByPrefix,
  saveExpandedSessionFolders,
  saveHiddenSessionPrefixes,
  saveSessionFolderPrefixes,
  setSessionFolderExpanded,
} from './session-visibility.js?v=2';

const { Terminal } = globalThis;
const { FitAddon } = globalThis.FitAddon;

const $ = (selector) => document.querySelector(selector);
// Read the display params before the share-link branch below, which rewrites the URL to
// drop the token and would take ?view= and ?fontSize= with it — leaving a bookmarked
// share link silently back on overview mode, and therefore unwrapped.
const displayParams = new URLSearchParams(location.search);
const sharedToken = new URLSearchParams(location.hash.slice(1)).get('share') || displayParams.get('share');
if (sharedToken) {
  sessionStorage.setItem('codeck-share-token', sharedToken);
  history.replaceState(null, '', location.pathname);
}
const storedShareToken = sessionStorage.getItem('codeck-share-token');
// The owner token lives in localStorage so it survives closing the tab, the phone
// reclaiming the page, and launching again from the home screen — sessionStorage is
// scoped to one tab session, which is why the token had to be retyped so often. Migrate
// anyone still holding the old sessionStorage copy rather than making them type it again.
const legacyOwnerToken = sessionStorage.getItem('codeck-token');
if (legacyOwnerToken && !localStorage.getItem('codeck-token')) localStorage.setItem('codeck-token', legacyOwnerToken);
const storedOwnerToken = localStorage.getItem('codeck-token');
const SESSION_LIST_FALLBACK_MS = 30_000;
const FONT_SIZE_MIN = 8;
const FONT_SIZE_MAX = 32;

function parseFontSizeParam(raw) {
  if (!raw) return null; // Number(null) is 0, so an absent param must not fall through to Number().
  const value = Number(raw);
  return Number.isFinite(value) ? Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(value))) : null;
}

const state = {
  token: sharedToken || storedShareToken || storedOwnerToken || '',
  sessions: [],
  hiddenSessionPrefixes: loadHiddenSessionPrefixes(localStorage),
  folderSessionPrefixes: loadSessionFolderPrefixes(localStorage),
  expandedSessionFolders: loadExpandedSessionFolders(localStorage),
  active: null,
  socket: null,
  sessionFeedSocket: null,
  sessionFeedGeneration: 0,
  sessionFeedReconnectTimer: null,
  sessionStreamCursor: null,
  sessionStreamSnapshot: null,
  sessionStreamHealthy: false,
  terminal: null,
  fit: null,
  sessionsRefreshSeq: 0,
  connectionId: 0,
  terminalDropDepth: 0,
  cancelMobileScroll: null,
  cancelTerminalReveal: null,
  cancelTerminalWrite: null,
  terminalResizeGate: null,
  terminalInputReady: false,
  // `?view=readable` skips the overview font-shrink below so the terminal keeps a fixed,
  // legible size and actually resizes the tmux window to the viewport instead of cramming
  // the desktop pane's full grid onto a phone screen. Bookmarking a link with this plus
  // `?fontSize=` to the home screen gives a phone a consistent, tuned launch every time.
  // `?fontSize=` alone implies the same: overview mode still forces the pty to the desktop
  // pane's column count regardless of the chosen font, which is what was wide enough to
  // run text past the visible edge with no wrap — a fixed font size only makes sense
  // together with letting the pty width match what that font can actually show.
  overview: displayParams.get('view') === 'overview'
    ? true
    : displayParams.get('view') !== 'readable' && !displayParams.has('fontSize'),
  baseFontSize: parseFontSizeParam(displayParams.get('fontSize')) ?? 16,
  fitting: false,
  canManage: true,
  canWrite: true,
  canSwitchSession: false,
  openedShareLink: Boolean(sharedToken || storedShareToken),
};
const relativeTime = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' });
const agentLabels = { codex: { icon: 'C›', name: 'Codex' }, claude: { icon: 'A›', name: 'Claude' }, qodercli: { icon: 'Q›', name: 'Qoder CLI' } };
let terminalVoiceBaseDraft = '';
let terminalVoiceHadResult = false;

const TERMINAL_KEY_HINT = '回车发送 · \u2303J 换行 · @ Tab Esc 直达 CLI';

function setTerminalVoiceState(active, message = '') {
  for (const trigger of document.querySelectorAll('[data-terminal-action="voice"]')) {
    trigger.classList.toggle('listening', active);
    trigger.setAttribute('aria-pressed', String(active));
  }
  const capture = $('#terminalVoiceCaptureButton');
  capture.classList.toggle('listening', active);
  capture.setAttribute('aria-pressed', String(active));
  capture.setAttribute('aria-label', active ? '停止语音输入' : terminalVoiceHadResult ? '重新语音输入' : '开始语音输入');
  $('#terminalVoiceHint').textContent = message || TERMINAL_KEY_HINT;
  $('#terminalVoiceStatus').textContent = message;
}

const voiceInput = createSpeechInput({
  scope: window,
  lang: document.documentElement.lang || navigator.language || 'zh-CN',
  onListeningChange: (listening) => {
    setTerminalVoiceState(listening, listening
      ? '正在听写，再点一次停止录音。'
      : terminalVoiceHadResult ? '识别完成，可以修改后发送。' : '语音输入已结束。');
  },
  onTranscript: ({ transcript }) => {
    $('#terminalVoiceDraft').value = mergeSpeechDraft(terminalVoiceBaseDraft, transcript);
    terminalVoiceHadResult = Boolean(transcript);
    resizeTerminalVoiceDraft();
    syncTerminalVoiceControls();
  },
  onStatus: (message) => setTerminalVoiceState(true, message),
  onError: (message) => {
    setTerminalVoiceState(false, message);
    setConnectionMessage(message);
  },
});
if (!voiceInput.supported) document.documentElement.classList.remove('speech-input');

function resizeTerminalVoiceDraft() {
  const draft = $('#terminalVoiceDraft');
  draft.style.height = 'auto';
  draft.style.height = `${Math.min(96, draft.scrollHeight)}px`;
}

function syncTerminalVoiceControls() {
  const connected = state.canWrite && state.terminalInputReady
    && state.socket?.readyState === WebSocket.OPEN;
  const composerOpen = !$('#terminalVoiceComposer').hidden;
  for (const trigger of document.querySelectorAll('[data-terminal-action="voice"]')) {
    trigger.hidden = !state.canWrite || composerOpen;
    trigger.disabled = !connected;
  }
  $('#terminalVoiceCaptureButton').disabled = !connected;
  $('#sendTerminalVoiceButton').disabled = !connected || !terminalDraftForSend($('#terminalVoiceDraft').value);
  if (!connected && voiceInput.active) {
    voiceInput.abort();
    setTerminalVoiceState(false, '终端连接已断开，语音草稿仍保留。');
  }
  if (!state.canWrite && !$('#terminalVoiceComposer').hidden) closeTerminalVoiceComposer({ restoreFocus: false });
}

function startTerminalVoiceInput() {
  if (!voiceInput.supported || $('#terminalVoiceCaptureButton').disabled) return;
  terminalVoiceBaseDraft = $('#terminalVoiceDraft').value;
  terminalVoiceHadResult = false;
  if (voiceInput.start()) setTerminalVoiceState(true, '正在请求麦克风权限…');
}

function toggleTerminalVoiceInput() {
  if (voiceInput.active) {
    voiceInput.stop();
    setTerminalVoiceState(true, '正在完成语音识别…');
    return;
  }
  startTerminalVoiceInput();
}

// 打开输入条本身不需要语音支持 —— 它现在是终端的默认输入面。只有点"语音"才要。
function openTerminalComposer({ focus = false } = {}) {
  if (!state.canWrite || state.socket?.readyState !== WebSocket.OPEN) return false;
  if (!$('#terminalVoiceComposer').hidden) return true;
  $('#terminalVoiceComposer').hidden = false;
  resizeTerminalVoiceDraft();
  setTerminalVoiceState(false, '');
  syncTerminalVoiceControls();
  if (focus) $('#terminalVoiceDraft').focus();
  return true;
}

function openTerminalVoiceComposer() {
  if (!voiceInput.supported) return setConnectionMessage('当前浏览器不支持语音识别');
  if (!state.canWrite) return setConnectionMessage('当前分享链接为只读');
  if (state.socket?.readyState !== WebSocket.OPEN) return setConnectionMessage('终端尚未连接');
  terminalVoiceBaseDraft = '';
  terminalVoiceHadResult = false;
  $('#terminalVoiceDraft').value = '';
  $('#terminalVoiceComposer').hidden = false;
  resizeTerminalVoiceDraft();
  setTerminalVoiceState(false, '准备开始语音识别。');
  syncTerminalVoiceControls();
  startTerminalVoiceInput();
}

function toggleTerminalVoiceComposer() {
  if ($('#terminalVoiceComposer').hidden) return openTerminalVoiceComposer();
  toggleTerminalVoiceInput();
}

function closeTerminalVoiceComposer({ restoreFocus = true } = {}) {
  voiceInput.abort();
  $('#terminalVoiceComposer').hidden = true;
  setTerminalVoiceState(false, '语音输入已关闭。');
  syncTerminalVoiceControls();
  if (restoreFocus && !matchMedia('(pointer: coarse)').matches) state.terminal?.focus();
}

// 本地输入条开着时它才是打字的落点; 逐字符模式下才把焦点给 xterm。
function focusTerminalInput() {
  if (!$('#terminalVoiceComposer').hidden) return $('#terminalVoiceDraft').focus();
  state.terminal?.focus();
}

function insertDraftNewline(stripBackslash = false) {
  const draft = $('#terminalVoiceDraft');
  const end = draft.selectionEnd;
  const start = draft.selectionStart - (stripBackslash ? 1 : 0);
  draft.value = `${draft.value.slice(0, start)}\n${draft.value.slice(end)}`;
  draft.selectionStart = draft.selectionEnd = start + 1;
  resizeTerminalVoiceDraft();
  syncTerminalVoiceControls();
}

function sendTerminalInput(data) {
  if (!state.canWrite || state.socket?.readyState !== WebSocket.OPEN) return false;
  try {
    state.socket.send(JSON.stringify({ type: 'input', data }));
  } catch { return false; }
  return true;
}

// 交权: 输入条收起, 焦点回到终端, 之后每个按键都直通, 直到用户按回车(CLI 收下这一行)
// 或按 Esc(放弃补全) —— 那时再把本地输入条收回来。
function handOffTerminalInput(prefix) {
  if (!sendTerminalInput(prefix)) return setTerminalVoiceState(false, '终端连接已断开，草稿仍保留在这里。');
  $('#terminalVoiceDraft').value = '';
  resizeTerminalVoiceDraft();
  state.handoffTerminalInput = true;
  closeTerminalVoiceComposer({ restoreFocus: false });
  state.terminal?.focus();
  setConnectionMessage('已交给 CLI 补全，回车或 Esc 后恢复本地输入');
}

function submitTerminalVoiceDraft() {
  const socket = state.socket;
  const text = terminalDraftForSend($('#terminalVoiceDraft').value);
  if (!text) return setTerminalVoiceState(false, '请先说话或输入文字。');
  if (!state.canWrite) return setTerminalVoiceState(false, '当前分享链接为只读。');
  if (socket?.readyState !== WebSocket.OPEN) return setTerminalVoiceState(false, '终端连接已断开，草稿仍保留在这里。');
  try {
    socket.send(JSON.stringify({ type: 'input', data: `${text}\r` }));
  } catch {
    return setTerminalVoiceState(false, '发送失败，终端连接可能已断开。');
  }
  voiceInput.abort();
  terminalVoiceBaseDraft = '';
  terminalVoiceHadResult = false;
  $('#terminalVoiceDraft').value = '';
  resizeTerminalVoiceDraft();
  setTerminalVoiceState(false, '已发送到终端。');
  syncTerminalVoiceControls();
  setConnectionMessage('语音文字已发送到终端');
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.token}`, ...options.headers },
  });
  if (response.status === 401) throw new Error('UNAUTHORIZED');
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `请求失败 (${response.status})`);
  }
  return response.status === 204 ? null : response.json();
}

function shellQuotePath(value) {
  return `'${String(value).replaceAll("'", "'\\\\''")}'`;
}

function hasFileDrag(event) {
  return [...(event.dataTransfer?.types || [])].includes('Files');
}

function getEntryFromItem(item) {
  return typeof item?.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null;
}

function readDirectoryEntries(reader) {
  return new Promise((resolve, reject) => {
    reader.readEntries((entries) => resolve(entries || []), (error) => reject(error || new Error('读取目录条目失败')));
  });
}

async function collectFilesFromEntry(entry, prefix = '') {
  if (!entry) return [];
  if (entry.isFile && typeof entry.file === 'function') {
    const file = await new Promise((resolve, reject) => {
      entry.file(resolve, reject);
    });
    return file ? [{ file, relativePath: prefix }] : [];
  }
  if (entry.isDirectory && typeof entry.createReader === 'function') {
    const reader = entry.createReader();
    const childPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
    const files = [];
    while (true) {
      const children = await readDirectoryEntries(reader);
      if (!children.length) break;
      for (const child of children) {
        files.push(...await collectFilesFromEntry(child, childPrefix));
      }
    }
    return files;
  }
  return [];
}

function getFallbackRelativeDirectory(file) {
  const relativePath = String(file?.webkitRelativePath || '');
  const normalized = relativePath.replaceAll('\\', '/');
  const lastSlash = normalized.lastIndexOf('/');
  return lastSlash < 0 ? '' : normalized.slice(0, lastSlash);
}

async function collectDroppedFilesFromDataTransfer(dataTransfer) {
  const items = [...(dataTransfer?.items || [])];
  const files = [];
  for (const item of items) {
    const entry = getEntryFromItem(item);
    if (entry) {
      files.push(...await collectFilesFromEntry(entry, ''));
      continue;
    }
    const file = item?.getAsFile?.();
    if (file) files.push({ file, relativePath: getFallbackRelativeDirectory(file) });
  }
  if (!files.length) {
    for (const file of [...(dataTransfer?.files || [])]) {
      if (file) files.push({ file, relativePath: getFallbackRelativeDirectory(file) });
    }
  }
  return files;
}

async function uploadFileBlob(file, relativePath) {
  const params = new URLSearchParams({ name: file.name });
  if (relativePath) params.set('relativePath', relativePath);
  const response = await fetch(`/api/uploads/files?${params}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', Authorization: `Bearer ${state.token}` },
    body: file,
  });
  if (response.status === 401) throw new Error('UNAUTHORIZED');
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `请求失败 (${response.status})`);
  }
  return response.json();
}

function cleanDraggedPath(value) {
  return String(value || '')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .trim()
    .replace(/^[\(\[\{<"'`]+/, '')
    .replace(/[)\]\}>"',。;:!?…。，]*$/, '');
}

function extractDownloadPath(selection) {
  const text = String(selection || '').replace(/\r/g, '').trim();
  if (!text) return null;
  const quotedCandidates = [...text.matchAll(/(["'])(.*?)\1/g)];
  for (const match of quotedCandidates) {
    const raw = cleanDraggedPath(match[2]);
    if (!raw) continue;
    if (raw.startsWith('/home/') || raw.startsWith('~/.codeck/uploads/')) return raw;
  }
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const tokens = lines.flatMap((line) => line.split(/\s+/));
  for (const token of tokens) {
    const raw = cleanDraggedPath(token);
    if (!raw) continue;
    if (raw.startsWith('/home/') || raw.startsWith('~/.codeck/uploads/')) return raw;
  }
  return null;
}

function buildDownloadUrl(filePath) {
  const params = new URLSearchParams({ path: filePath });
  return `${location.origin}/api/download?${params}`;
}

function extractFileName(filePath) {
  const segments = filePath.split('/').filter(Boolean);
  return segments[segments.length - 1] || 'file';
}

function handleTerminalDragStart(event) {
  if (!state.canManage || !state.terminal?.getSelection) return;
  const selected = state.terminal.getSelection();
  const filePath = extractDownloadPath(selected);
  if (!filePath) return;
  const downloadUrl = buildDownloadUrl(filePath);
  const fileName = extractFileName(filePath);
  event.preventDefault();
  event.dataTransfer.effectAllowed = 'copy';
  event.dataTransfer?.setData('DownloadURL', `application/octet-stream:${fileName}:${downloadUrl}`);
  event.dataTransfer?.setData('text/uri-list', downloadUrl);
  event.dataTransfer?.setData('text/plain', filePath);
  event.dataTransfer.dropEffect = 'copy';
}

function handleTerminalDragEnter(event) {
  if (!hasFileDrag(event)) return;
  event.preventDefault();
  event.stopPropagation();
  if (!state.canManage) return;
  state.terminalDropDepth = (state.terminalDropDepth || 0) + 1;
  $('#terminal').closest('.terminal-frame')?.classList.add('drag-over');
  event.dataTransfer.dropEffect = 'copy';
}

function handleTerminalDragOver(event) {
  if (!hasFileDrag(event)) return;
  event.preventDefault();
  event.stopPropagation();
  if (!state.canManage) return;
  state.terminalDropDepth = state.terminalDropDepth || 0;
  event.dataTransfer.dropEffect = 'copy';
}

function handleTerminalDragLeave(event) {
  if (!hasFileDrag(event)) return;
  if (!state.terminalDropDepth) return;
  event.preventDefault();
  event.stopPropagation();
  state.terminalDropDepth = Math.max(0, state.terminalDropDepth - 1);
  if (!state.terminalDropDepth) {
    $('#terminal').closest('.terminal-frame')?.classList.remove('drag-over');
  }
}

function timeAgo(timestamp) {
  const seconds = Math.round((timestamp - Date.now()) / 1000);
  if (Math.abs(seconds) < 60) return '刚刚';
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return relativeTime.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return relativeTime.format(hours, 'hour');
  return relativeTime.format(Math.round(hours / 24), 'day');
}

function resolveSessionStatus(session) {
  const status = (session?.status || '').toString().trim().toLowerCase();
  if (status === 'working' || status === 'running') return 'working';
  if (status === 'background') return 'background';
  if (status === 'worked') return 'done';
  return 'done';
}

function sessionVisibilityPartition(prefixes = state.hiddenSessionPrefixes) {
  return partitionSessionsByPrefix(state.sessions, prefixes);
}

function updateSessionVisibilitySummary(
  hiddenPrefixes = parseSessionPrefixInput($('#hiddenSessionPrefixesInput').value),
  folderPrefixes = parseSessionPrefixInput($('#folderSessionPrefixesInput').value),
) {
  const { visible, hidden } = sessionVisibilityPartition(hiddenPrefixes);
  const folderCount = groupSessionsByPrefix(visible, folderPrefixes)
    .filter((entry) => entry.type === 'folder').length;
  $('#sessionVisibilitySummary').textContent = state.sessions.length
    ? `将显示 ${visible.length} 个会话（${folderCount} 个文件夹），隐藏 ${hidden.length} 个。`
    : '当前没有运行中的 tmux 会话。';
}

function syncSessionVisibilityButton(hiddenCount = sessionVisibilityPartition().hidden.length) {
  const button = $('#sessionVisibilityButton');
  const count = $('#sessionVisibilityRuleCount');
  const hiddenRuleCount = state.hiddenSessionPrefixes.length;
  const folderRuleCount = state.folderSessionPrefixes.length;
  const ruleCount = hiddenRuleCount + folderRuleCount;
  count.hidden = !ruleCount;
  count.textContent = ruleCount > 99 ? '99+' : String(ruleCount);
  const label = ruleCount
    ? `设置会话显示，${folderRuleCount} 个文件夹前缀，${hiddenRuleCount} 个隐藏前缀，当前隐藏 ${hiddenCount} 个会话`
    : '设置会话显示';
  button.setAttribute('aria-label', label);
  button.title = label;
}

function openSessionVisibilityDialog() {
  const folderInput = $('#folderSessionPrefixesInput');
  const hiddenInput = $('#hiddenSessionPrefixesInput');
  folderInput.value = state.folderSessionPrefixes.join('\n');
  hiddenInput.value = state.hiddenSessionPrefixes.join('\n');
  updateSessionVisibilitySummary(state.hiddenSessionPrefixes, state.folderSessionPrefixes);
  const dialog = $('#sessionVisibilityDialog');
  if (!dialog.open) dialog.showModal();
  requestAnimationFrame(() => folderInput.focus({ preventScroll: true }));
}

function applySessionVisibility(hiddenPrefixes, folderPrefixes) {
  state.hiddenSessionPrefixes = saveHiddenSessionPrefixes(localStorage, hiddenPrefixes);
  state.folderSessionPrefixes = saveSessionFolderPrefixes(localStorage, folderPrefixes);
  state.expandedSessionFolders = saveExpandedSessionFolders(
    localStorage,
    state.expandedSessionFolders.filter((prefix) => state.folderSessionPrefixes.includes(prefix)),
  );
  renderSessions();
}

function setSessionFolderOpen(prefix, open) {
  if (state.expandedSessionFolders.includes(prefix) === open) return;
  state.expandedSessionFolders = saveExpandedSessionFolders(
    localStorage,
    setSessionFolderExpanded(state.expandedSessionFolders, prefix, open),
  );
}

function sessionListEmpty(hiddenCount) {
  const empty = document.createElement('div');
  empty.className = 'list-empty';
  const glyph = document.createElement('span');
  glyph.textContent = '∅';
  const copy = document.createElement('p');
  copy.textContent = hiddenCount
    ? `当前浏览器隐藏了 ${hiddenCount} 个会话`
    : '还没有 tmux 会话';
  empty.append(glyph, copy);
  if (hiddenCount) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'visibility-empty-button';
    button.textContent = '调整显示';
    button.addEventListener('click', openSessionVisibilityDialog);
    empty.append(button);
  }
  return empty;
}

function sessionEntryHtml(session, index) {
  const status = resolveSessionStatus(session);
  const statusText = status === 'working'
    ? '正在干活'
    : status === 'background' ? '后台运行' : '已就绪';
  const meta = [statusText, timeAgo(session.activityAt)].filter(Boolean).join(' · ');
  return `
    <div class="session-entry">
      <button type="button" class="session-row ${session.name === state.active ? 'active' : ''}" data-session="${escapeHtml(session.name)}">
        <span class="session-index">${index + 1}</span>
        <span class="session-icon">${session.agent ? agentLabels[session.agent.kind]?.icon || '›_' : '$_'}</span>
        <span class="session-copy"><b title="${escapeHtml(session.name)}">${escapeHtml(session.name)}</b><small>${escapeHtml(meta)}</small></span>
        <span class="presence ${status}" title="${statusText}"></span>
      </button>
      ${state.canManage ? `<button type="button" class="rename-session" data-rename-session="${escapeHtml(session.name)}" title="重命名 tmux 会话" aria-label="重命名 ${escapeHtml(session.name)}">✎</button>` : ''}
    </div>`;
}

function sessionFolderHtml(entry, indexByName) {
  const expanded = state.expandedSessionFolders.includes(entry.prefix);
  const containsActive = entry.items.some((session) => session.name === state.active);
  const label = `${entry.prefix} 文件夹，${entry.items.length} 个会话`;
  return `
    <details class="session-folder${containsActive ? ' contains-active' : ''}" data-session-folder="${escapeHtml(entry.prefix)}"${expanded ? ' open' : ''}>
      <summary class="session-folder-summary" aria-label="${escapeHtml(label)}">
        <span class="session-folder-chevron" aria-hidden="true">›</span>
        <svg class="session-folder-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 7.5h6l1.8 2H20.5v8.8a1.7 1.7 0 0 1-1.7 1.7H5.2a1.7 1.7 0 0 1-1.7-1.7V7.5Z"/></svg>
        <span class="session-folder-name" title="${escapeHtml(entry.prefix)}">${escapeHtml(entry.prefix)}</span>
        <span class="session-folder-count">${entry.items.length}</span>
      </summary>
      <div class="session-folder-children">${entry.items.map((session) => sessionEntryHtml(session, indexByName.get(session.name))).join('')}</div>
    </details>`;
}


// 一次性的事件委托。原来每轮渲染都要给每一行重新 addEventListener, 会话越多越贵,
// 而 innerHTML 重建后旧监听器本就随节点一起丢弃 —— 委托到容器上只需绑一次。
let sessionListDelegated = false;

function bindSessionListDelegates(list) {
  if (sessionListDelegated) return;
  sessionListDelegated = true;
  list.addEventListener('click', (event) => {
    const rename = event.target.closest?.('.rename-session');
    if (rename && list.contains(rename)) {
      event.preventDefault();
      event.stopPropagation();
      if (rename.dataset.renameSession) renameSession(rename.dataset.renameSession);
      return;
    }
    const row = event.target.closest?.('.session-row');
    if (row && list.contains(row)) {
      event.preventDefault();
      if (row.dataset.session) connect(row.dataset.session);
    }
  });
  // toggle 不冒泡, 只能在捕获阶段代理。
  list.addEventListener('toggle', (event) => {
    const folder = event.target.closest?.('.session-folder');
    if (folder && list.contains(folder)) setSessionFolderOpen(folder.dataset.sessionFolder, folder.open);
  }, true);
}

let sessionRenderSignature = null;

function renderSessions({ force = false } = {}) {
  const list = $('#sessionList');
  // 服务端在任一会话工作时按 750ms 推送, 而 activityAt / agent.activity 每秒都在
  // 变。侧栏显示的相对时间是分桶的, 多数帧渲染结果完全一样 —— 没变就别重建 DOM,
  // 那是和 xterm 抢主线程、让打字发涩的原因。
  const signature = sessionsRenderSignature(state.sessions, {
    status: resolveSessionStatus,
    timeLabel: timeAgo,
    active: state.active || '',
    canManage: state.canManage,
    extra: [
      state.overview, state.expandedSessionFolders.join(','),
      state.folderSessionPrefixes.join(','), state.hiddenSessionPrefixes.join(','),
    ].join('|'),
  });
  if (!force && signature === sessionRenderSignature) return;
  sessionRenderSignature = signature;
  const scrollTop = list.scrollTop;
  const focusedSession = document.activeElement?.closest?.('[data-session]')?.dataset.session;
  const focusedFolder = document.activeElement?.closest?.('[data-session-folder]')?.dataset.sessionFolder;
  const { visible, hidden } = sessionVisibilityPartition();
  syncSessionVisibilityButton(hidden.length);
  if ($('#sessionVisibilityDialog').open) updateSessionVisibilitySummary();
  if (!visible.length) {
    list.replaceChildren(sessionListEmpty(hidden.length));
    return;
  }
  const indexByName = new Map(visible.map((session, index) => [session.name, index]));
  const entries = groupSessionsByPrefix(visible, state.folderSessionPrefixes);
  list.innerHTML = entries.map((entry) => entry.type === 'folder'
    ? sessionFolderHtml(entry, indexByName)
    : sessionEntryHtml(entry.item, indexByName.get(entry.item.name))).join('');
  bindSessionListDelegates(list);
  if (focusedSession) {
    [...list.querySelectorAll('[data-session]')].find((row) => row.dataset.session === focusedSession)?.focus({ preventScroll: true });
  } else if (focusedFolder) {
    [...list.querySelectorAll('[data-session-folder]')]
      .find((folder) => folder.dataset.sessionFolder === focusedFolder)
      ?.querySelector('.session-folder-summary')?.focus({ preventScroll: true });
  }
  list.scrollTop = scrollTop;
}

function escapeHtml(value) {
  const node = document.createElement('span');
  node.textContent = value;
  return node.innerHTML;
}

function websocketProtocolToken(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

async function refreshSessions() {
  const requestId = ++state.sessionsRefreshSeq;
  const previousActiveSession = state.sessions.find((item) => item.name === state.active);
  const data = await api('/api/sessions');
  if (requestId !== state.sessionsRefreshSeq) return;
  const activeGridChanged = applySessionSnapshot(data, previousActiveSession);
  if (state.terminal && isMobileOverview() && activeGridChanged) fitTerminalView();
  if (state.canManage) connectSessionFeed();
}

function applySessionSnapshot(data, previousActiveSession = state.sessions.find((item) => item.name === state.active)) {
  state.sessions = data.sessions;
  const activeSession = state.sessions.find((item) => item.name === state.active);
  const activeGridChanged = Boolean(activeSession) && (
    activeSession.width !== previousActiveSession?.width
    || activeSession.height !== previousActiveSession?.height
  );
  state.canManage = data.capabilities?.canManage !== false;
  state.canWrite = data.capabilities?.canWrite ?? state.canManage;
  state.canSwitchSession = data.capabilities?.canSwitchSession === true;
  syncTerminalAccess();
  // A sole tmux 2.7 client can still resize through the pty. The missing window-size
  // option only affects arbitration between clients, so it must not disable readable mode.
  $('#viewModeButton').hidden = false;
  for (const id of ['#newButton', '#newButtonBottom', '#emptyNewButton', '#killButton', '#shareButton']) $(id).hidden = !state.canManage;
  $('#viewModeButton').textContent = state.overview ? '全览' : '可读';
  $('#viewModeButton').setAttribute('aria-pressed', String(state.overview));
  renderSessions();
  return activeGridChanged;
}

function scheduleSessionFeedReconnect() {
  if (!state.token || !state.canManage || state.sessionFeedReconnectTimer || document.hidden) return;
  state.sessionFeedReconnectTimer = setTimeout(() => {
    state.sessionFeedReconnectTimer = null;
    connectSessionFeed();
  }, 2_000);
}

function connectSessionFeed() {
  if (!state.token || !state.canManage || state.sessionFeedSocket?.readyState <= WebSocket.OPEN) return;
  clearTimeout(state.sessionFeedReconnectTimer);
  state.sessionFeedReconnectTimer = null;
  const generation = ++state.sessionFeedGeneration;
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${location.host}/agent?streamVersion=2`, `codeck.${websocketProtocolToken(state.token)}`);
  state.sessionFeedSocket = socket;
  socket.addEventListener('message', (event) => {
    if (generation !== state.sessionFeedGeneration) return;
    let message;
    try { message = JSON.parse(event.data); }
    catch { return; }
    if (message.type === 'ready') {
      if (message.protocol?.epoch !== state.sessionStreamCursor?.epoch) {
        state.sessionStreamCursor = null;
        state.sessionStreamSnapshot = null;
      }
      // v1 由服务端在连接时自动订阅; v2 必须客户端自己发, 否则一帧都收不到。
      if (message.protocol?.version === 2 && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          type: 'subscribeSessions',
          cursor: state.sessionStreamSnapshot ? state.sessionStreamCursor : null,
        }));
      }
      return;
    }
    const applyFeedSnapshot = (snapshot, cursor) => {
      state.sessionStreamCursor = cursor;
      state.sessionStreamSnapshot = snapshot;
      state.sessionStreamHealthy = true;
      state.sessionsRefreshSeq += 1;
      const activeGridChanged = applySessionSnapshot(snapshot);
      if (state.terminal && isMobileOverview() && activeGridChanged) fitTerminalView();
    };
    if (message.type === 'sessionsSnapshot') {
      if (message.version === 2) {
        const accepted = acceptStreamFrame(state.sessionStreamCursor, message.stream, 'snapshot');
        if (!accepted.accepted || !message.snapshot) return;
        applyFeedSnapshot(message.snapshot, accepted.cursor);
        return;
      }
      const accepted = acceptStreamCursor(state.sessionStreamCursor, message.stream);
      state.sessionStreamHealthy = Boolean(message.stream?.epoch && Number.isSafeInteger(message.stream?.sequence));
      if (!accepted.accepted || !message.snapshot) return;
      applyFeedSnapshot(message.snapshot, accepted.cursor);
      return;
    }
    if (message.type === 'sessionsPatch') {
      const accepted = acceptStreamFrame(state.sessionStreamCursor, message.stream, 'delta');
      if (accepted.gap || !state.sessionStreamSnapshot) {
        // 补丁接不上就退回整份快照; 空 cursor 让服务端直接发全量。
        state.sessionStreamSnapshot = null;
        state.sessionStreamCursor = null;
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'subscribeSessions', cursor: null }));
        return;
      }
      if (!accepted.accepted) return;
      try {
        applyFeedSnapshot(applySnapshotPatch(state.sessionStreamSnapshot, message.patch), accepted.cursor);
      } catch {
        state.sessionStreamSnapshot = null;
        state.sessionStreamCursor = null;
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'subscribeSessions', cursor: null }));
      }
      return;
    }
    if (message.type === 'sessionsSynchronized') {
      const accepted = acceptStreamFrame(state.sessionStreamCursor, message.stream, 'synchronized');
      if (accepted.accepted) state.sessionStreamHealthy = true;
      return;
    }
    if (message.type === 'sessionsStreamError') state.sessionStreamHealthy = false;
  });
  socket.addEventListener('close', () => {
    if (generation !== state.sessionFeedGeneration) return;
    state.sessionFeedSocket = null;
    state.sessionStreamHealthy = false;
    scheduleSessionFeedReconnect();
  });
  socket.addEventListener('error', () => {
    if (generation === state.sessionFeedGeneration) state.sessionStreamHealthy = false;
  });
}

function connectedStateLabel() {
  return state.canManage ? '已连接' : state.canWrite ? '已连接（共享协作）' : '已连接（只读）';
}

function syncTerminalAccess() {
  const writable = state.canWrite && state.terminalInputReady;
  if (state.terminal) state.terminal.options.disableStdin = !writable;
  for (const control of document.querySelectorAll('.mobile-keybar [data-terminal-key], .mobile-keybar [data-terminal-action="paste"]')) {
    control.disabled = !writable;
  }
  // 逐字符直通意味着每敲一个键都要一次往返, 跟手程度等于 RTT。默认把输入收到本地
  // 输入条里, 回车才发一次; 补全/中断等按键仍逐键直达 CLI, 见 terminal-compose.js。
  if (writable) openTerminalComposer();
  syncTerminalVoiceControls();
}

function terminalOutputForSession(output, sessionName) {
  const session = state.sessions.find((item) => item.name === sessionName);
  return session?.agent?.kind === 'codex' ? hideSharedCodexBackgroundFooter(output) : output;
}

function isQuickSwitchKey(event) {
  const keyK = event.code === 'KeyK' || event.key?.toLowerCase() === 'k';
  return keyK && (event.metaKey || event.altKey || (event.ctrlKey && event.shiftKey));
}

function parseDigit(event) {
  if (/^Digit[0-9]$/.test(event.code || '')) return Number(event.code.slice(-1));
  if (/^Numpad[0-9]$/.test(event.code || '')) return Number(event.code.slice(-1));
  if (event.key >= '0' && event.key <= '9') return Number(event.key);
  return null;
}

function getSessionByIndex(index) {
  if (!Number.isInteger(index) || index < 1) return null;
  return sessionVisibilityPartition().visible[index - 1] || null;
}

function switchToSession(sessionName) {
  if (!sessionName) return false;
  if (state.active === sessionName) return true;
  connect(sessionName);
  return true;
}

function switchByQuickSessionIndex(index) {
  const session = getSessionByIndex(index);
  if (!session) return false;
  switchToSession(session.name);
  return true;
}

function cycleSession() {
  const sessions = sessionVisibilityPartition().visible;
  if (sessions.length < 2) return;
  const currentIndex = sessions.findIndex((session) => session.name === state.active);
  const nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % sessions.length;
  switchToSession(sessions[nextIndex].name);
}

function handleQuickSwitchKeydown(event) {
  const digit = parseDigit(event);
  if (event.altKey && !event.metaKey && digit !== null) {
    event.preventDefault();
    event.stopPropagation();
    const target = digit === 0 ? 1 : digit;
    if (!switchByQuickSessionIndex(target)) {
      setConnectionMessage(`没有第 ${target} 个会话`);
    }
    return true;
  }
  if (!isQuickSwitchKey(event)) return false;
  event.preventDefault();
  event.stopPropagation();
  if (event.altKey) return cycleSession(), true;
  if (sessionVisibilityPartition().visible.length) openQuickSwitcher();
  return true;
}

function openQuickSwitcher() {
  const list = $('#switchList');
  const sessions = sessionVisibilityPartition().visible;
  list.innerHTML = sessions.map((session, index) => `
    <button class="switch-row ${session.name === state.active ? 'active' : ''}" data-switch-session="${escapeHtml(session.name)}">
      <span class="switch-index">${index + 1}</span>
      <span class="switch-name">${escapeHtml(session.agent?.name || session.name)}</span>
      <small>${session.agent ? `${agentLabels[session.agent.kind]?.name || session.agent.kind} · ${escapeHtml(session.name)}` : 'tmux session'}</small>
    </button>`).join('') || '<p class="list-empty">没有可见的 tmux 会话</p>';
  if (!$('#switchDialog').open) $('#switchDialog').showModal();
  const rows = [...list.querySelectorAll('.switch-row')];
  (rows.find((row) => row.dataset.switchSession === state.active) || rows[0])?.focus();
}

function setConnectionMessage(message, restore = true) {
  $('#connectionState').textContent = message;
  if (restore) setTimeout(() => {
    if ($('#connectionState').textContent === message) $('#connectionState').textContent = state.socket?.readyState === WebSocket.OPEN ? connectedStateLabel() : '连接已断开';
  }, 1800);
}

async function pasteImages(event) {
  const images = [...(event.clipboardData?.items || [])]
    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    .map((item) => item.getAsFile()).filter(Boolean);
  if (!images.length) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (!state.canManage) {
    return setConnectionMessage(state.canWrite ? '协作链接暂不支持上传图片' : '当前分享链接为只读');
  }
  const socket = state.socket;
  if (socket?.readyState !== WebSocket.OPEN) return setConnectionMessage('终端尚未连接');
  setConnectionMessage(images.length > 1 ? `正在上传 ${images.length} 张图片…` : '正在上传图片…', false);
  try {
    const uploads = await Promise.all(images.map((file) => api('/api/uploads/images', {
      method: 'POST', headers: { 'Content-Type': file.type }, body: file,
    })));
    if (state.socket !== socket || socket.readyState !== WebSocket.OPEN) throw new Error('会话已切换');
    const paths = uploads.map((upload) => shellQuotePath(upload.path)).join(' ');
    socket.send(JSON.stringify({ type: 'input', data: paths }));
    setConnectionMessage(images.length > 1 ? `已粘贴 ${images.length} 张图片` : '图片已粘贴');
    state.terminal.focus();
  } catch (error) {
    setConnectionMessage(error.message === 'UNAUTHORIZED' ? '令牌已失效' : `图片上传失败：${error.message}`);
  }
}

async function handleTerminalDrop(event) {
  if (!hasFileDrag(event)) return;
  event.preventDefault();
  event.stopPropagation();
  state.terminalDropDepth = 0;
  $('#terminal').closest('.terminal-frame')?.classList.remove('drag-over');
  if (!state.canManage) {
    return setConnectionMessage(state.canWrite ? '协作链接暂不支持上传文件' : '当前分享链接为只读');
  }
  const socket = state.socket;
  const files = await collectDroppedFilesFromDataTransfer(event.dataTransfer);
  if (!files.length) return;
  if (!socket || socket.readyState !== WebSocket.OPEN) return setConnectionMessage('终端尚未连接');
  setConnectionMessage(files.length > 1 ? `正在上传 ${files.length} 个文件…` : '正在上传文件…', false);
  try {
    const uploads = await Promise.all(files.map((entry) => uploadFileBlob(entry.file, entry.relativePath)));
    if (state.socket !== socket || socket.readyState !== WebSocket.OPEN) throw new Error('会话已切换');
    const paths = uploads.map((upload) => shellQuotePath(upload.path)).join(' ');
    if (paths) socket.send(JSON.stringify({ type: 'input', data: paths }));
    setConnectionMessage(files.length > 1 ? `已上传 ${files.length} 个文件` : '文件已上传');
    state.terminal?.focus();
  } catch (error) {
    setConnectionMessage(error.message === 'UNAUTHORIZED' ? '令牌已失效' : `文件上传失败：${error.message}`);
  }
}

// tmux runs in the outer terminal's alternate screen, which has no scrollback — xterm's
// own viewport has nothing to scroll, so no amount of local scrollTop or wheel handling
// moves anything. The history is tmux's, reachable only through its copy mode, so a touch
// drag is forwarded to the server and replayed as a tmux scroll instead.
// `?debug=touch` prints the gesture chain on screen. Touch behaviour cannot be reproduced
// off-device, so when a gesture misbehaves this shows which link broke rather than
// guessing: whether the hold registered, whether the synthetic mousedown went out, and
// what xterm made of it.
const touchDebug = displayParams.get('debug') === 'touch';
let touchLogLines = [];
function touchLog(message) {
  if (!touchDebug) return;
  let panel = $('#touchDebug');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'touchDebug';
    panel.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:99;max-height:38vh;overflow:auto;padding:6px 8px;background:#000c;color:#8ae234;font:10px/1.35 monospace;white-space:pre-wrap;pointer-events:none';
    document.body.appendChild(panel);
  }
  touchLogLines = [...touchLogLines.slice(-14), `${new Date().toISOString().slice(17, 23)} ${message}`];
  panel.textContent = touchLogLines.join('\n');
}

function ensureTerminal() {
  if (state.terminal) return state.terminal;
  const terminal = new Terminal({
    // convertEol would reset the cursor column on every bare LF. tmux emits those to move
    // down while keeping the column, then erases and redraws from there, so forcing the
    // column to 0 makes the erase miss and leaves the previous frame's text behind.
    cursorBlink: true, cursorStyle: 'block',
    disableStdin: !state.canWrite,
    fontFamily: '"Courier New", "Noto Sans SC Variable", monospace',
    fontSize: 16, lineHeight: 1.2, scrollback: 5000,
    theme: {
      background: '#2e3436', foreground: '#d3d7cf', cursor: '#eeeeec', cursorAccent: '#2e3436',
      selectionBackground: '#e9542066', selectionForeground: '#ffffff',
      black: '#2e3436', red: '#cc0000', green: '#4e9a06', yellow: '#c4a000',
      blue: '#3465a4', magenta: '#75507b', cyan: '#06989a', white: '#d3d7cf',
      brightBlack: '#555753', brightRed: '#ef2929', brightGreen: '#8ae234', brightYellow: '#fce94f',
      brightBlue: '#729fcf', brightMagenta: '#ad7fa8', brightCyan: '#34e2e2', brightWhite: '#eeeeec',
    },
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.open($('#terminal'));
  bindTerminalRenderWatchdog(terminal, { isVisible: () => !document.hidden });
  state.cancelMobileScroll = bindMobileScroll($('#terminal'), terminal, (lines) => {
    if (state.socket?.readyState === WebSocket.OPEN) {
      state.socket.send(JSON.stringify({ type: 'scroll', lines }));
    }
  }, { log: touchLog });
  $('#terminal').addEventListener('paste', pasteImages, true);
  $('#terminal').addEventListener('dragenter', handleTerminalDragEnter, true);
  $('#terminal').addEventListener('dragover', handleTerminalDragOver, true);
  $('#terminal').addEventListener('dragleave', handleTerminalDragLeave, true);
  $('#terminal').addEventListener('drop', handleTerminalDrop, true);
  $('#terminal').addEventListener('dragstart', handleTerminalDragStart, true);
  terminal.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') return true;
    // Let the browser emit its native copy event when xterm has a selection. xterm's
    // copy listener puts its virtual selection on the clipboard without requiring the
    // async Clipboard API. With no selection, Ctrl+C still reaches the pty as SIGINT.
    if (isTerminalCopyShortcut(event, terminal.hasSelection())) return false;
    return !handleQuickSwitchKeydown(event);
  });
  terminal.onData((data) => {
    if (state.canWrite && state.terminalInputReady && state.socket?.readyState === WebSocket.OPEN) {
      state.socket.send(JSON.stringify({ type: 'input', data }));
      if (state.handoffTerminalInput && /[\r\n\x1b]/.test(data)) {
        state.handoffTerminalInput = false;
        openTerminalComposer({ focus: true });
      }
    }
  });
  // Touch browsers have no dependable shortcut or native selection bubble for xterm's
  // virtual selection. Preserve copy-on-select there; pointer devices use the native
  // copy event above, which is synchronous and works even when Clipboard API writes are
  // not permitted.
  terminal.onSelectionChange(() => {
    if (!matchMedia('(pointer: coarse)').matches) return;
    const text = terminal.getSelection();
    if (text) navigator.clipboard?.writeText(text).catch(() => {});
  });
  terminal.onResize(({ cols, rows }) => {
    if (!state.fitting) state.terminalResizeGate?.send(cols, rows);
  });
  new ResizeObserver(fitTerminalView).observe($('#terminal').parentElement);
  state.terminal = terminal;
  state.fit = fit;
  return terminal;
}

function isMobileOverview() {
  return state.overview && matchMedia('(max-width: 720px), (max-width: 932px) and (orientation: landscape)').matches;
}

function fitTerminalView({ suppressResize = false } = {}) {
  if (!state.terminal || state.fitting) return;
  state.fitting = true;
  const terminal = state.terminal;
  const mobileOverview = isMobileOverview();
  const session = state.sessions.find((item) => item.name === state.active);
  const result = fitTerminalGrid(terminal, state.fit, {
    baseFontSize: state.baseFontSize,
    overviewSize: mobileOverview && session?.width > 0 && session?.height > 0
      ? { cols: session.width, rows: session.height }
      : null,
  });
  if (mobileOverview && !result.overview) {
    state.overview = false;
    $('#viewModeButton').textContent = '可读';
    $('#viewModeButton').setAttribute('aria-pressed', 'false');
  }
  state.fitting = false;
  if (!suppressResize) state.terminalResizeGate?.send(terminal.cols, terminal.rows);
}

function markActiveSession(session) {
  for (const row of $('#sessionList').querySelectorAll('[data-session]')) {
    row.classList.toggle('active', row.dataset.session === session);
  }
  for (const folder of $('#sessionList').querySelectorAll('[data-session-folder]')) {
    folder.classList.toggle('contains-active', Boolean(
      [...folder.querySelectorAll('[data-session]')].find((row) => row.dataset.session === session),
    ));
  }
}

async function connect(session) {
  if (state.active === session && state.socket && state.socket.readyState <= WebSocket.OPEN) {
    $('#sidebar').classList.remove('open');
    $('#menuButton').setAttribute('aria-expanded', 'false');
    if (state.socket.readyState === WebSocket.OPEN && state.terminalInputReady) focusTerminalInput();
    return;
  }
  closeTerminalVoiceComposer({ restoreFocus: false });
  const sessionDetails = state.sessions.find((item) => item.name === session);
  const connectionId = ++state.connectionId;
  const needsReset = Boolean(state.terminal);
  const reuseSocket = state.canSwitchSession && state.socket?.readyState === WebSocket.OPEN;
  const currentSocket = state.socket;
  state.cancelTerminalReveal?.();
  state.cancelTerminalReveal = null;
  state.cancelTerminalWrite?.();
  state.cancelTerminalWrite = null;
  state.terminalResizeGate = null;
  state.terminalInputReady = false;
  state.cancelMobileScroll?.();
  stopKeyRepeat();
  if (!reuseSocket) state.socket?.close();
  if (!reuseSocket) state.socket = null;
  state.active = session;
  markActiveSession(session);
  $('#emptyState').hidden = true;
  $('#terminalView').hidden = false;
  $('#terminalTitle').textContent = sessionDetails?.agent?.name || session;
  $('#terminalTitle').title = sessionDetails?.agent ? `tmux: ${session}` : '';
  $('#connectionState').textContent = '正在连接';
  $('#sidebar').classList.remove('open');
  $('#menuButton').setAttribute('aria-expanded', 'false');

  const terminal = ensureTerminal();
  const terminalWrites = createTerminalWriteQueue(terminal);
  state.cancelTerminalWrite = terminalWrites.cancel;
  const terminalElement = $('#terminal');
  terminalElement.style.visibility = 'hidden';
  const reset = needsReset && !reuseSocket ? resetTerminalInput(terminal) : Promise.resolve();
  fitTerminalView({ suppressResize: reuseSocket });

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  // Report the viewport on the URL so the pty attaches at this size. Sending it only as
  // the first resize message races the attach, and a lost resize leaves the grid larger
  // than the visible area.
  const query = new URLSearchParams({ session, cols: String(terminal.cols), rows: String(terminal.rows) });
  const socket = reuseSocket
    ? currentSocket
    : new WebSocket(`${protocol}//${location.host}/ws?${query}`, `codeck.${websocketProtocolToken(state.token)}`);
  const resizeGate = createTerminalResizeGate((cols, rows) => {
    if (state.connectionId !== connectionId || state.socket !== socket
      || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify({ type: 'resize', cols, rows }));
    return true;
  });
  if (!reuseSocket) resizeGate.mark(terminal.cols, terminal.rows);
  state.terminalResizeGate = resizeGate;
  let displayReady = false;
  let awaitingSwitchReset = reuseSocket;
  let terminalResetReady = !needsReset;
  state.socket = socket;
  syncTerminalAccess();
  const enableTerminalInput = () => {
    if (reuseSocket || !terminalResetReady || state.connectionId !== connectionId
      || state.socket !== socket || socket.readyState !== WebSocket.OPEN) return;
    state.terminalInputReady = true;
    syncTerminalAccess();
  };
  const markConnected = () => {
    if (state.connectionId !== connectionId) return;
    $('#connectionState').textContent = connectedStateLabel();
    syncTerminalAccess();
    if (displayReady) focusTerminalInput();
  };
  const revealGate = createTerminalRevealGate(() => {
    if (state.connectionId !== connectionId || state.active !== session
      || state.socket !== socket || socket.readyState !== WebSocket.OPEN) return;
    displayReady = true;
    state.cancelTerminalReveal = null;
    terminalElement.style.visibility = '';
    markConnected();
  });
  state.cancelTerminalReveal = revealGate.cancel;
  socket.onopen = reuseSocket ? null : () => {
    enableTerminalInput();
    markConnected();
    resizeGate.send(terminal.cols, terminal.rows);
  };
  socket.onmessage = (event) => {
    if (state.connectionId !== connectionId) return;
    let switchResetFrame = false;
    if (awaitingSwitchReset) {
      if (event.data !== '\x1bc') return;
      awaitingSwitchReset = false;
      switchResetFrame = true;
    }
    const output = terminalOutputForSession(event.data, session);
    if (!output) return;
    // Preserve terminal byte order and capability-query replies, but keep older frames
    // cancellable instead of filling xterm's internal write buffer before a switch.
    terminalWrites.write(output, () => {
      if (state.connectionId !== connectionId) return;
      if (switchResetFrame) {
        state.terminalInputReady = true;
        syncTerminalAccess();
        return;
      }
      if (output === '\x1bc') return;
      revealGate.parsed();
    });
  };
  socket.onclose = (event) => {
    if (state.connectionId !== connectionId) return;
    state.terminalInputReady = false;
    $('#connectionState').textContent = event.reason || '连接已断开';
    syncTerminalAccess();
  };
  socket.onerror = () => {
    if (state.connectionId !== connectionId) return;
    state.terminalInputReady = false;
    $('#connectionState').textContent = '连接失败';
    syncTerminalAccess();
  };

  if (reuseSocket) {
    try {
      socket.send(JSON.stringify({ type: 'switch', session, cols: terminal.cols, rows: terminal.rows }));
      resizeGate.mark(terminal.cols, terminal.rows);
      return;
    } catch {
      state.socket = null;
      socket.close();
      return connect(session);
    }
  }

  await reset;
  if (state.connectionId !== connectionId || state.active !== session || state.socket !== socket) return;
  terminalResetReady = true;
  enableTerminalInput();
}

function openNewDialog() {
  $('#newError').textContent = '';
  $('#nameInput').value = `agent-${new Date().toISOString().slice(11, 16).replace(':', '')}`;
  $('#newDialog').showModal();
  $('#nameInput').select();
}

async function renameSession(currentName) {
  const newName = prompt(`重命名 tmux 会话“${currentName}”`, currentName)?.trim();
  if (!newName || newName === currentName) return;
  try {
    await api(`/api/sessions/${encodeURIComponent(currentName)}`, {
      method: 'PATCH', body: JSON.stringify({ name: newName }),
    });
    if (state.active === currentName) {
      state.active = newName;
    }
    await refreshSessions();
    if (state.active === newName) {
      const session = state.sessions.find((item) => item.name === newName);
      $('#terminalTitle').textContent = session?.agent?.name || newName;
      $('#terminalTitle').title = session?.agent ? `tmux: ${newName}` : '';
    }
  } catch (error) {
    alert(error.message === 'UNAUTHORIZED' ? '令牌已失效' : `重命名失败：${error.message}`);
  }
}
['#newButton', '#newButtonBottom', '#emptyNewButton'].forEach((id) => $(id).addEventListener('click', openNewDialog));
$('#sessionVisibilityButton').addEventListener('click', openSessionVisibilityDialog);
$('#folderSessionPrefixesInput').addEventListener('input', () => updateSessionVisibilitySummary());
$('#hiddenSessionPrefixesInput').addEventListener('input', () => updateSessionVisibilitySummary());
$('#sessionVisibilityForm').addEventListener('submit', (event) => {
  if (event.submitter?.value === 'cancel') return;
  event.preventDefault();
  applySessionVisibility(
    parseSessionPrefixInput($('#hiddenSessionPrefixesInput').value),
    parseSessionPrefixInput($('#folderSessionPrefixesInput').value),
  );
  $('#sessionVisibilityDialog').close();
});
$('#showAllSessionsButton').addEventListener('click', () => {
  $('#folderSessionPrefixesInput').value = '';
  $('#hiddenSessionPrefixesInput').value = '';
  applySessionVisibility([], []);
  $('#sessionVisibilityDialog').close();
});
$('#menuButton').addEventListener('click', () => {
  const open = $('#sidebar').classList.toggle('open');
  $('#menuButton').setAttribute('aria-expanded', String(open));
});

$('#viewModeButton').addEventListener('click', () => {
  state.overview = !state.overview;
  $('#viewModeButton').textContent = state.overview ? '全览' : '可读';
  $('#viewModeButton').setAttribute('aria-pressed', String(state.overview));
  fitTerminalView();
  focusTerminalInput();
});

// Held keys repeat, the way a physical keyboard does. Without it the arrows move one
// column per tap, so putting the cursor anywhere useful on a phone means tapping a dozen
// times — which is what made tapping the screen directly seem worth attempting.
const TERMINAL_KEYS = { escape: '\x1b', tab: '\t', 'ctrl-c': '\x03', 'ctrl-d': '\x04', 'ctrl-l': '\x0c', left: '\x1b[D', up: '\x1b[A', down: '\x1b[B', right: '\x1b[C' };
const KEY_REPEAT_DELAY_MS = 400;
const KEY_REPEAT_INTERVAL_MS = 55;
// Only movement repeats. Holding Esc or ⌃C should send one, however long the finger rests.
const REPEATABLE_KEYS = new Set(['left', 'up', 'down', 'right']);
let keyRepeatDelay = 0;
let keyRepeatTimer = 0;

function stopKeyRepeat() {
  clearTimeout(keyRepeatDelay);
  clearInterval(keyRepeatTimer);
  keyRepeatDelay = keyRepeatTimer = 0;
}

function sendTerminalKey(name) {
  if (!state.canWrite) return false;
  if (!state.terminalInputReady) return false;
  if (state.socket?.readyState !== WebSocket.OPEN) return false;
  state.socket.send(JSON.stringify({ type: 'input', data: TERMINAL_KEYS[name] }));
  return true;
}

$('.mobile-keybar').addEventListener('pointerdown', (event) => {
  const button = event.target.closest('[data-terminal-key]');
  if (!button) return;
  const name = button.dataset.terminalKey;
  stopKeyRepeat();
  if (!sendTerminalKey(name) || !REPEATABLE_KEYS.has(name)) return;
  // Take the pointer so the repeat still stops if the finger slides off the button.
  button.setPointerCapture?.(event.pointerId);
  keyRepeatDelay = setTimeout(() => {
    keyRepeatTimer = setInterval(() => sendTerminalKey(name) || stopKeyRepeat(), KEY_REPEAT_INTERVAL_MS);
  }, KEY_REPEAT_DELAY_MS);
});
for (const type of ['pointerup', 'pointercancel', 'pointerleave']) {
  $('.mobile-keybar').addEventListener(type, stopKeyRepeat);
}

for (const trigger of document.querySelectorAll('[data-terminal-action="voice"]')) {
  trigger.addEventListener('pointerdown', (event) => event.preventDefault());
  trigger.addEventListener('click', toggleTerminalVoiceComposer);
}
$('#terminalVoiceCaptureButton').addEventListener('pointerdown', (event) => event.preventDefault());
$('#terminalVoiceCaptureButton').addEventListener('click', toggleTerminalVoiceInput);
$('#terminalVoiceComposer').addEventListener('submit', (event) => {
  event.preventDefault();
  submitTerminalVoiceDraft();
});
$('#terminalVoiceDraft').addEventListener('input', () => {
  resizeTerminalVoiceDraft();
  syncTerminalVoiceControls();
});
$('#terminalVoiceDraft').addEventListener('keydown', (event) => {
  const draft = $('#terminalVoiceDraft');
  const action = terminalComposerKeyAction(event, {
    draft: draft.value,
    caret: draft.selectionStart,
    hasSelection: draft.selectionStart !== draft.selectionEnd,
  });
  if (action.type === 'insert') return;
  event.preventDefault();
  if (action.type === 'send') return $('#terminalVoiceComposer').requestSubmit();
  if (action.type === 'newline') return insertDraftNewline(action.stripBackslash);
  if (action.type === 'passthrough') {
    if (action.key === 'tab' && action.shift) return sendTerminalInput(TERMINAL_SHIFT_TAB);
    return sendTerminalKey(action.key);
  }
  // handoff: '@' 之后的补全需要 CLI 逐键接管, 先把已输入的原样送过去(不带回车)。
  handOffTerminalInput(`${$('#terminalVoiceDraft').value}@`);
});

// Neither clipboard direction has a touch gesture to hang off. `.xterm` sets
// user-select:none over virtualized rows, so there is no native selection for a long-press
// "Copy" bubble; xterm's own selection is driven by mousedown, which a touch drag never
// produces; and its paste target is a textarea parked at left:-9999em that the iOS paste
// bubble cannot reach. Both need an explicit button.
function visibleScreenText(terminal) {
  const buffer = terminal.buffer.active;
  const lines = [];
  for (let row = 0; row < terminal.rows; row += 1) {
    lines.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '');
  }
  return lines.join('\n').replace(/\n+$/, '');
}

$('.mobile-keybar').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-terminal-action]');
  if (!button || !state.terminal) return;
  if (button.dataset.terminalAction === 'copy') {
    // Prefer whatever is actually selected — the browser's own selection on touch, or
    // xterm's on a pointer device — and fall back to the visible screen.
    const text = getSelection()?.toString() || (state.terminal.hasSelection() ? state.terminal.getSelection() : visibleScreenText(state.terminal));
    if (!text) return setConnectionMessage('屏幕上没有可复制的内容');
    try {
      await navigator.clipboard.writeText(text);
      setConnectionMessage('已复制当前屏幕');
    } catch { setConnectionMessage('复制失败：浏览器拒绝了剪贴板访问'); }
    return;
  }
  if (button.dataset.terminalAction === 'paste') {
    if (!state.canWrite) return;
    if (state.socket?.readyState !== WebSocket.OPEN) return setConnectionMessage('终端尚未连接');
    try {
      // Reading the clipboard needs the user gesture this click provides; iOS additionally
      // shows its own confirmation before handing the text over.
      const text = await navigator.clipboard.readText();
      if (text) state.socket.send(JSON.stringify({ type: 'input', data: text }));
    } catch { setConnectionMessage('粘贴失败：浏览器拒绝了剪贴板访问'); }
  }
});

$('#shareButton').addEventListener('click', async () => {
  if (!state.active) return;
  $('#shareButton').disabled = true;
  let url = '';
  try {
    const data = await api(`/api/sessions/${encodeURIComponent(state.active)}/share`, { method: 'POST' });
    url = `${location.origin}${data.url}`;
    await navigator.clipboard.writeText(url);
    setConnectionMessage('协作链接已复制，可继续对话，有效期24小时');
  } catch (error) {
    if (url) prompt('复制这个分享链接（24小时内有效）', url);
    else setConnectionMessage(`生成分享链接失败：${error.message}`);
  } finally {
    $('#shareButton').disabled = false;
  }
});

$('#newForm').addEventListener('submit', async (event) => {
  if (event.submitter?.value === 'cancel') return;
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const payload = Object.fromEntries(form);
  if (!payload.cwd) delete payload.cwd;
  $('#createButton').disabled = true;
  $('#createButton').textContent = '正在创建…';
  try {
    await api('/api/sessions', { method: 'POST', body: JSON.stringify(payload) });
    $('#newDialog').close();
    connect(payload.name);
    await refreshSessions();
  } catch (error) { $('#newError').textContent = error.message; }
  finally { $('#createButton').disabled = false; $('#createButton').textContent = '创建会话'; }
});

$('#killButton').addEventListener('click', async () => {
  if (!state.active || !confirm(`确定结束 tmux 会话“${state.active}”吗？其中未保存的进程状态会丢失。`)) return;
  closeTerminalVoiceComposer({ restoreFocus: false });
  await api(`/api/sessions/${encodeURIComponent(state.active)}`, { method: 'DELETE' });
  state.socket?.close();
  state.active = null;
  $('#terminalView').hidden = true;
  $('#emptyState').hidden = false;
  await refreshSessions();
});

$('#tokenForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  state.token = $('#tokenInput').value.trim();
  try {
    await refreshSessions();
    sessionStorage.removeItem('codeck-share-token');
    localStorage.setItem('codeck-token', state.token);
    state.openedShareLink = false;
    $('#tokenDialog').close();
  } catch (error) { $('#tokenError').textContent = error.message === 'UNAUTHORIZED' ? '令牌不正确，请检查服务启动日志。' : error.message; }
});

document.addEventListener('keydown', (event) => {
  if (handleQuickSwitchKeydown(event)) return;
}, true);

document.addEventListener('visibilitychange', () => {
  if (document.hidden && voiceInput.abort()) setTerminalVoiceState(false, '语音输入已暂停，草稿仍保留在这里。');
  if (!document.hidden && state.canManage) connectSessionFeed();
  if (!document.hidden && state.terminal) state.terminal.refresh(0, state.terminal.rows - 1);
});
window.addEventListener('pagehide', () => voiceInput.abort());
window.addEventListener('storage', (event) => {
  const displayKeys = new Set([
    SESSION_VISIBILITY_STORAGE_KEY,
    SESSION_FOLDER_PREFIXES_STORAGE_KEY,
    SESSION_FOLDER_EXPANSION_STORAGE_KEY,
  ]);
  if (event.key !== null && !displayKeys.has(event.key)) return;
  state.hiddenSessionPrefixes = loadHiddenSessionPrefixes(localStorage);
  state.folderSessionPrefixes = loadSessionFolderPrefixes(localStorage);
  state.expandedSessionFolders = loadExpandedSessionFolders(localStorage);
  renderSessions();
  if ($('#sessionVisibilityDialog').open) {
    $('#folderSessionPrefixesInput').value = state.folderSessionPrefixes.join('\n');
    $('#hiddenSessionPrefixesInput').value = state.hiddenSessionPrefixes.join('\n');
    updateSessionVisibilitySummary(state.hiddenSessionPrefixes, state.folderSessionPrefixes);
  }
});

$('#quickSwitchButton').addEventListener('click', openQuickSwitcher);

$('#switchList').addEventListener('click', (event) => {
  const row = event.target.closest('[data-switch-session]');
  if (!row) return;
  $('#switchDialog').close();
  connect(row.dataset.switchSession);
});

$('#switchList').addEventListener('keydown', (event) => {
  const rows = [...$('#switchList').querySelectorAll('.switch-row')];
  const index = rows.indexOf(document.activeElement);
  const nextIndex = event.key === 'ArrowDown' ? (index + 1) % rows.length
    : event.key === 'ArrowUp' ? (index - 1 + rows.length) % rows.length : -1;
  if (nextIndex >= 0) {
    event.preventDefault();
    rows[nextIndex]?.focus();
  }
});

$('#sessionList').addEventListener('keydown', (event) => {
  const folder = event.target.closest('.session-folder');
  if (event.target.matches('.session-folder-summary') && event.key === 'ArrowRight' && !folder.open) {
    event.preventDefault();
    folder.open = true;
    return;
  }
  if (event.target.matches('.session-folder-summary') && event.key === 'ArrowLeft' && folder.open) {
    event.preventDefault();
    folder.open = false;
    return;
  }
  const rows = [...$('#sessionList').querySelectorAll('.session-folder-summary, .session-row')]
    .filter((row) => row.matches('.session-folder-summary') || !row.closest('.session-folder:not([open])'));
  const index = rows.indexOf(document.activeElement);
  if (event.key === 'Escape') {
    $('#sidebar').classList.remove('open');
    $('#menuButton').setAttribute('aria-expanded', 'false');
    focusTerminalInput();
    return;
  }
  const nextIndex = event.key === 'ArrowDown' ? (index + 1) % rows.length
    : event.key === 'ArrowUp' ? (index - 1 + rows.length) % rows.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : -1;
  if (nextIndex >= 0) {
    event.preventDefault();
    rows[nextIndex]?.focus();
  }
});

syncSessionVisibilityButton();
if (state.token) refreshSessions().then(() => {
  if (state.openedShareLink && state.sessions.length === 1) connect(state.sessions[0].name);
}).catch((error) => {
  // A persisted token that the server no longer accepts has to go, or every reload
  // retries it and lands back on this dialog. Other failures — the server being down,
  // say — leave it alone so a working token isn't discarded over a blip.
  if (error.message === 'UNAUTHORIZED') localStorage.removeItem('codeck-token');
  $('#tokenDialog').showModal();
});
else $('#tokenDialog').showModal();
setInterval(() => {
  if (state.token && (!state.canManage || !state.sessionStreamHealthy)) refreshSessions().catch(() => {});
}, SESSION_LIST_FALLBACK_MS);
document.fonts?.ready.then(() => {
  if (!state.terminal) return;
  state.terminal.refresh(0, state.terminal.rows - 1);
  fitTerminalView();
});
