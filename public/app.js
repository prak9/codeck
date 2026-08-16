const { Terminal } = globalThis;
const { FitAddon } = globalThis.FitAddon;

const $ = (selector) => document.querySelector(selector);
const sharedToken = new URLSearchParams(location.hash.slice(1)).get('share') || new URLSearchParams(location.search).get('share');
if (sharedToken) {
  sessionStorage.setItem('codeck-share-token', sharedToken);
  history.replaceState(null, '', location.pathname);
}
const storedShareToken = sessionStorage.getItem('codeck-share-token');
const SESSION_LIST_POLL_MS = 3_000;
const state = {
  token: sharedToken || storedShareToken || sessionStorage.getItem('codeck-token') || '',
  sessions: [],
  active: null,
  socket: null,
  terminal: null,
  fit: null,
  sessionsRefreshSeq: 0,
  connectionId: 0,
  terminalDropDepth: 0,
  overview: true,
  fitting: false,
  supportsLargestSize: true,
  canManage: true,
  openedShareLink: Boolean(sharedToken || storedShareToken),
};
const relativeTime = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' });
const agentLabels = { codex: { icon: 'C›', name: 'Codex' }, claude: { icon: 'A›', name: 'Claude' }, qodercli: { icon: 'Q›', name: 'Qoder CLI' } };

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
  if (state.token) params.set('token', state.token);
  return `${location.origin}/api/download?${params}`;
}

function extractFileName(filePath) {
  const segments = filePath.split('/').filter(Boolean);
  return segments[segments.length - 1] || 'file';
}

function handleTerminalDragStart(event) {
  if (!state.terminal?.getSelection) return;
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
  state.terminalDropDepth = (state.terminalDropDepth || 0) + 1;
  $('#terminal').closest('.terminal-frame')?.classList.add('drag-over');
  event.dataTransfer.dropEffect = 'copy';
}

function handleTerminalDragOver(event) {
  if (!hasFileDrag(event)) return;
  event.preventDefault();
  event.stopPropagation();
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
  if (status === 'worked') return 'done';
  return 'done';
}

function renderSessions() {
  const list = $('#sessionList');
  const scrollTop = list.scrollTop;
  const focusedSession = document.activeElement?.closest?.('[data-session]')?.dataset.session;
  if (!state.sessions.length) {
    list.innerHTML = '<div class="list-empty"><span>∅</span><p>还没有 tmux 会话</p></div>';
    return;
  }
  list.innerHTML = state.sessions.map((session, index) => {
    const status = resolveSessionStatus(session);
    const statusText = status === 'working' ? '正在干活' : '完成';
    return `
    <div class="session-entry">
      <button type="button" class="session-row ${session.name === state.active ? 'active' : ''}" data-session="${escapeHtml(session.name)}">
        <span class="session-index">${index + 1}</span>
        <span class="session-icon">${session.agent ? agentLabels[session.agent.kind]?.icon || '›_' : (session.attached ? '›_' : '$_')}</span>
        <span class="session-copy"><b title="${escapeHtml(session.agent?.name || session.name)}">${escapeHtml(session.agent?.name || session.name)}</b><small>${session.agent ? `${agentLabels[session.agent.kind]?.name || session.agent.kind} · tmux ${escapeHtml(session.name)}` : `${session.windows} 个窗口`} · ${timeAgo(session.activityAt)}</small></span>
        <span class="presence ${status}" title="${statusText}"></span>
      </button>
      ${state.canManage ? `<button type="button" class="rename-session" data-rename-session="${escapeHtml(session.name)}" title="重命名 tmux 会话" aria-label="重命名 ${escapeHtml(session.name)}">✎</button>` : ''}
    </div>`; 
  }).join('');
  list.querySelectorAll('.session-row').forEach((row) => {
    row.addEventListener('click', (event) => {
      event.preventDefault();
      const target = row.dataset.session;
      if (target) connect(target);
    });
  });
  list.querySelectorAll('.rename-session').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const currentName = button.dataset.renameSession;
      if (currentName) renameSession(currentName);
    });
  });
  if (focusedSession) {
    [...list.querySelectorAll('[data-session]')].find((row) => row.dataset.session === focusedSession)?.focus({ preventScroll: true });
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
  const data = await api('/api/sessions');
  if (requestId !== state.sessionsRefreshSeq) return;
  state.sessions = data.sessions;
  state.supportsLargestSize = data.capabilities?.largestSize !== false;
  state.canManage = data.capabilities?.canManage !== false;
  $('#viewModeButton').hidden = !state.supportsLargestSize;
  for (const id of ['#newButton', '#newButtonBottom', '#emptyNewButton', '#killButton', '#shareButton']) $(id).hidden = !state.canManage;
  if (!state.supportsLargestSize) state.overview = true;
  renderSessions();
  if (state.active && state.terminal) fitTerminalView();
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
  return state.sessions[index - 1] || null;
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
  if (state.sessions.length < 2) return;
  const currentIndex = state.sessions.findIndex((session) => session.name === state.active);
  const nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % state.sessions.length;
  switchToSession(state.sessions[nextIndex].name);
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
  if (state.sessions.length) openQuickSwitcher();
  return true;
}

function openQuickSwitcher() {
  const list = $('#switchList');
  list.innerHTML = state.sessions.map((session, index) => `
    <button class="switch-row ${session.name === state.active ? 'active' : ''}" data-switch-session="${escapeHtml(session.name)}">
      <span class="switch-index">${index + 1}</span>
      <span class="switch-name">${escapeHtml(session.agent?.name || session.name)}</span>
      <small>${session.agent ? `${agentLabels[session.agent.kind]?.name || session.agent.kind} · ${escapeHtml(session.name)}` : 'tmux session'}</small>
    </button>`).join('') || '<p class="list-empty">还没有 tmux 会话</p>';
  if (!$('#switchDialog').open) $('#switchDialog').showModal();
  const rows = [...list.querySelectorAll('.switch-row')];
  (rows.find((row) => row.dataset.switchSession === state.active) || rows[0])?.focus();
}

function setConnectionMessage(message, restore = true) {
  $('#connectionState').textContent = message;
  if (restore) setTimeout(() => {
    if ($('#connectionState').textContent === message) $('#connectionState').textContent = state.socket?.readyState === WebSocket.OPEN ? '已连接' : '连接已断开';
  }, 1800);
}

async function pasteImages(event) {
  const images = [...(event.clipboardData?.items || [])]
    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    .map((item) => item.getAsFile()).filter(Boolean);
  if (!images.length) return;
  event.preventDefault();
  event.stopImmediatePropagation();
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

function ensureTerminal() {
  if (state.terminal) return state.terminal;
  const terminal = new Terminal({
    cursorBlink: true, cursorStyle: 'block', convertEol: true,
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
  $('#terminal').addEventListener('paste', pasteImages, true);
  $('#terminal').addEventListener('dragenter', handleTerminalDragEnter, true);
  $('#terminal').addEventListener('dragover', handleTerminalDragOver, true);
  $('#terminal').addEventListener('dragleave', handleTerminalDragLeave, true);
  $('#terminal').addEventListener('drop', handleTerminalDrop, true);
  $('#terminal').addEventListener('dragstart', handleTerminalDragStart, true);
  terminal.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') return true;
    return !handleQuickSwitchKeydown(event);
  });
  terminal.onData((data) => {
    if (state.socket?.readyState === WebSocket.OPEN) {
      state.socket.send(JSON.stringify({ type: 'input', data }));
    }
  });
  terminal.onResize(({ cols, rows }) => {
    if (!state.fitting && state.socket?.readyState === WebSocket.OPEN) state.socket.send(JSON.stringify({ type: 'resize', cols, rows }));
  });
  new ResizeObserver(fitTerminalView).observe($('#terminal').parentElement);
  state.terminal = terminal;
  state.fit = fit;
  return terminal;
}

function fitTerminalView() {
  if (!state.terminal || state.fitting) return;
  state.fitting = true;
  const terminal = state.terminal;
  const mobileOverview = matchMedia('(max-width: 720px), (max-width: 932px) and (orientation: landscape)').matches && state.overview;
  const session = state.sessions.find((item) => item.name === state.active);
  terminal.options.fontSize = 16;
  state.fit.fit();
  if (mobileOverview && session?.width > 0 && session?.height > 0) {
    for (let attempt = 0; attempt < 3 && (terminal.cols < session.width || terminal.rows < session.height); attempt += 1) {
      const ratio = Math.min(terminal.cols / session.width, terminal.rows / session.height, 1);
      terminal.options.fontSize = Math.max(1, Math.floor(terminal.options.fontSize * ratio * 9.7) / 10);
      state.fit.fit();
    }
    terminal.resize(session.width, session.height);
  }
  state.fitting = false;
  if (state.socket?.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
  }
}

function markActiveSession(session) {
  for (const row of $('#sessionList').querySelectorAll('[data-session]')) {
    row.classList.toggle('active', row.dataset.session === session);
  }
}

function connect(session) {
  const sessionDetails = state.sessions.find((item) => item.name === session);
  const connectionId = ++state.connectionId;
  state.socket?.close();
  state.socket = null;
  state.active = session;
  markActiveSession(session);
  $('#emptyState').hidden = true;
  $('#terminalView').hidden = false;
  $('#terminalTitle').textContent = sessionDetails?.agent?.name || session;
  $('#terminalTitle').title = sessionDetails?.agent ? `tmux: ${session}` : '';
  $('#connectionState').textContent = '正在连接';

  const terminal = ensureTerminal();
  terminal.reset();
  terminal.clear();
  fitTerminalView();

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${location.host}/ws?session=${encodeURIComponent(session)}`, `codeck.${websocketProtocolToken(state.token)}`);
  state.socket = socket;
  socket.addEventListener('open', () => {
    if (state.connectionId !== connectionId) return;
    $('#connectionState').textContent = '已连接';
    socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
    terminal.focus();
  });
  socket.addEventListener('message', (event) => {
    if (state.connectionId !== connectionId) return;
    terminal.write(event.data);
  });
  socket.addEventListener('close', () => state.connectionId === connectionId && ($('#connectionState').textContent = '连接已断开'));
  socket.addEventListener('error', () => state.connectionId === connectionId && ($('#connectionState').textContent = '连接失败'));
  $('#sidebar').classList.remove('open');
  $('#menuButton').setAttribute('aria-expanded', 'false');
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
$('#menuButton').addEventListener('click', () => {
  const open = $('#sidebar').classList.toggle('open');
  $('#menuButton').setAttribute('aria-expanded', String(open));
});

$('#viewModeButton').addEventListener('click', () => {
  state.overview = !state.overview;
  $('#viewModeButton').textContent = state.overview ? '全览' : '可读';
  $('#viewModeButton').setAttribute('aria-pressed', String(state.overview));
  fitTerminalView();
  state.terminal?.focus();
});

$('.mobile-keybar').addEventListener('click', (event) => {
  const button = event.target.closest('[data-terminal-key]');
  if (!button || state.socket?.readyState !== WebSocket.OPEN) return;
  const keys = { escape: '\x1b', tab: '\t', 'ctrl-c': '\x03', 'ctrl-d': '\x04', 'ctrl-l': '\x0c', left: '\x1b[D', up: '\x1b[A', down: '\x1b[B', right: '\x1b[C' };
  state.socket.send(JSON.stringify({ type: 'input', data: keys[button.dataset.terminalKey] }));
});

$('#shareButton').addEventListener('click', async () => {
  if (!state.active) return;
  $('#shareButton').disabled = true;
  let url = '';
  try {
    const data = await api(`/api/sessions/${encodeURIComponent(state.active)}/share`, { method: 'POST' });
    url = `${location.origin}${data.url}`;
    await navigator.clipboard.writeText(url);
    setConnectionMessage('分享链接已复制，有效期24小时');
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
    await refreshSessions();
    connect(payload.name);
  } catch (error) { $('#newError').textContent = error.message; }
  finally { $('#createButton').disabled = false; $('#createButton').textContent = '创建会话'; }
});

$('#killButton').addEventListener('click', async () => {
  if (!state.active || !confirm(`确定结束 tmux 会话“${state.active}”吗？其中未保存的进程状态会丢失。`)) return;
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
    sessionStorage.setItem('codeck-token', state.token);
    state.openedShareLink = false;
    $('#tokenDialog').close();
  } catch (error) { $('#tokenError').textContent = error.message === 'UNAUTHORIZED' ? '令牌不正确，请检查服务启动日志。' : error.message; }
});

document.addEventListener('keydown', (event) => {
  if (handleQuickSwitchKeydown(event)) return;
}, true);

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
  const rows = [...$('#sessionList').querySelectorAll('.session-row')];
  const index = rows.indexOf(document.activeElement);
  if (event.key === 'Escape') {
    $('#sidebar').classList.remove('open');
    $('#menuButton').setAttribute('aria-expanded', 'false');
    state.terminal?.focus();
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

if (state.token) refreshSessions().then(() => {
  if (state.openedShareLink && state.sessions.length === 1) connect(state.sessions[0].name);
}).catch(() => $('#tokenDialog').showModal());
else $('#tokenDialog').showModal();
setInterval(() => state.token && refreshSessions().catch(() => {}), SESSION_LIST_POLL_MS);
document.fonts?.ready.then(() => {
  if (!state.terminal) return;
  state.terminal.refresh(0, state.terminal.rows - 1);
  state.fit.fit();
});
