import {
  agentActivityText,
  applyAgentEvent,
  applyTmuxSnapshot,
  findTmuxThreadReplacement,
  latestRunningTurn,
  normalizeAgentThread,
  normalizeInteractionQuestions,
  shouldRefreshTmuxThread,
  shouldShowTerminalActivity,
  tmuxSessionsToThreads,
  userMessageText,
} from './agent-model.js?v=18';
import { composerControlState, createComposerRequestGate, draftAfterSuccessfulSend } from './remote-composer.js?v=2';
import { agentOutputText, writeAgentOutputToClipboard } from './remote-copy.js?v=1';
import { resolveViewportGeometry } from './remote-viewport.js?v=1';

const $ = (selector) => document.querySelector(selector);
const PROVIDERS = {
  codex: { name: 'Codex', sessionLabel: 'Codex', glyph: 'C›', short: 'Codex', description: 'OpenAI Codex App Server' },
  claude: { name: 'Claude Code', sessionLabel: 'Claude', glyph: 'A›', short: 'Claude', description: 'Anthropic Agent SDK' },
  qodercli: { name: 'QoderCLI', sessionLabel: 'Qoder CLI', glyph: 'Q›', short: 'Qoder', description: 'Qoder Agent SDK' },
};
const SHELL_PROVIDER = { name: 'Shell', sessionLabel: 'Shell', glyph: '$_', short: 'Shell', description: 'tmux shell session' };
const relativeTime = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' });
const SESSION_LIST_POLL_MS = 1_500;
const THREAD_REFRESH_POLL_MS = 1_000;
const THREAD_COMPLETION_REFRESH_MS = 10_000;
let viewportFrame = 0;

const state = {
  token: localStorage.getItem('codeck-token') || '',
  provider: localStorage.getItem('codeck-remote-provider') || 'codex',
  providers: Object.keys(PROVIDERS),
  socket: null,
  socketGeneration: 0,
  reconnectTimer: null,
  reconnectDelay: 1_000,
  requests: new Map(),
  nextRequestId: 1,
  connected: false,
  defaultCwd: '',
  cwd: localStorage.getItem('codeck-remote-cwd') || '',
  hostname: '',
  threads: [],
  activeThreadId: null,
  thread: null,
  approvals: new Map(),
  interactions: new Map(),
  renderFrame: 0,
  forceScroll: false,
  liveMessage: '',
  sessionSnapshot: null,
  threadLoad: null,
  threadRefresh: null,
  threadRefreshUntil: 0,
  threadHandoff: null,
  threadOpening: null,
};
const composerRequestGate = createComposerRequestGate(() => renderComposerState());

if (!PROVIDERS[state.provider]) state.provider = 'codex';

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function websocketProtocolToken(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function providerDetails(provider = state.provider) {
  if (provider === 'shell') return SHELL_PROVIDER;
  return PROVIDERS[provider] || { name: provider, sessionLabel: provider, glyph: '›_', short: provider, description: 'Agent CLI' };
}

function preferredAgentProvider() {
  const saved = localStorage.getItem('codeck-remote-provider');
  if (state.providers.includes(state.provider)) return state.provider;
  if (state.providers.includes(saved)) return saved;
  return state.providers[0] || Object.keys(PROVIDERS)[0];
}

function setConnectionStatus(status, message) {
  state.connected = status === 'online';
  const dot = $('#drawerConnectionDot');
  dot.className = `connection-dot ${status === 'online' ? 'online' : status === 'problem' ? 'problem' : 'busy'}`;
  $('#drawerConnectionText').textContent = message;
  renderComposerState();
}

function setLiveMessage(message) {
  state.liveMessage = message || '';
  $('#liveStatus').textContent = state.liveMessage;
}

async function validateOwnerToken(token) {
  const response = await fetch('/api/sessions', { headers: { Authorization: `Bearer ${token}` } });
  if (response.status === 401) throw new Error('令牌不正确，请检查 Codeck 启动日志。');
  if (!response.ok) throw new Error(`无法连接 Codeck（${response.status}）`);
  const data = await response.json();
  if (data.capabilities?.canManage === false) throw new Error('远程 Agent 需要 owner 令牌，分享令牌只有终端只读权限。');
  return data;
}

function rejectPendingRequests(message) {
  for (const request of state.requests.values()) {
    clearTimeout(request.timeout);
    request.reject(new Error(message));
  }
  state.requests.clear();
}

function connectSocket() {
  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;
  const generation = ++state.socketGeneration;
  state.socket?.close();
  rejectPendingRequests('连接已重置');
  setConnectionStatus('busy', '正在连接');
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${location.host}/agent`, `codeck.${websocketProtocolToken(state.token)}`);
  state.socket = socket;

  socket.addEventListener('message', (event) => {
    if (generation !== state.socketGeneration) return;
    let message;
    try { message = JSON.parse(event.data); }
    catch { return; }
    handleSocketMessage(message);
  });
  socket.addEventListener('close', () => {
    if (generation !== state.socketGeneration) return;
    state.socket = null;
    rejectPendingRequests('Agent 连接已断开');
    setConnectionStatus('problem', '连接已断开');
    scheduleReconnect();
  });
  socket.addEventListener('error', () => {
    if (generation === state.socketGeneration) setConnectionStatus('problem', '连接失败');
  });
}

function scheduleReconnect() {
  if (!state.token || state.reconnectTimer || document.visibilityState === 'hidden') return;
  const delay = state.reconnectDelay;
  state.reconnectDelay = Math.min(15_000, state.reconnectDelay * 1.8);
  state.reconnectTimer = setTimeout(connectSocket, delay);
}

async function handleReady(message) {
  const shellActive = state.provider === 'shell' && Boolean(state.thread?.tmux?.name);
  state.providers = (message.providers || []).map((provider) => provider.id).filter((provider) => PROVIDERS[provider]);
  if (!state.providers.length) state.providers = Object.keys(PROVIDERS);
  if (!shellActive && !state.providers.includes(state.provider)) state.provider = state.providers[0];
  state.defaultCwd = message.defaultCwd || state.defaultCwd || '/';
  if (!state.cwd) state.cwd = state.defaultCwd;
  state.hostname = message.hostname || location.hostname;
  state.approvals.clear();
  state.interactions.clear();
  state.reconnectDelay = 1_000;
  setConnectionStatus('online', '已连接');
  renderProviderControls();
  renderHeader();
  await loadThreads();
  if (state.activeThreadId) {
    const listedThread = state.threads.find((thread) => (
      thread.id === state.activeThreadId && thread.provider === state.provider
    ));
    if (state.provider === 'shell') {
      if (listedThread) openShellThread(listedThread, { quiet: true });
      else startNewThread({ focus: false });
      return;
    }
    if (listedThread?.tmux?.available === false) {
      openPendingThread(listedThread);
      return;
    }
    if (state.thread?.tmux?.available === false) return;
    openThread(state.activeThreadId, {
      quiet: true,
      readOnly: listedThread?.readOnly ?? (state.thread?.readOnly === true),
    })
      .catch((error) => setLiveMessage(error.message));
  }
}

function handleSocketMessage(message) {
  if (message.type === 'ready') {
    handleReady(message).catch((error) => setLiveMessage(error.message));
    return;
  }
  if (message.id != null) {
    const pending = state.requests.get(message.id);
    if (!pending) return;
    state.requests.delete(message.id);
    clearTimeout(pending.timeout);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new Error(message.error || 'Agent 请求失败'));
    return;
  }
  if (message.type === 'event') {
    if (message.method === 'turn/started' || message.method === 'item/started') {
      updateThreadActivity(message.provider, message.params?.threadId, 'working');
    } else if (message.method === 'turn/completed') {
      updateThreadActivity(message.provider, message.params?.threadId, 'done');
    }
    if (message.provider === state.provider && state.thread?.id === message.params?.threadId) {
      state.thread = applyAgentEvent(state.thread, message.method, message.params);
      if (message.method === 'turn/completed') {
        clearPendingForTurn(message.provider, message.params?.threadId, message.params?.turn?.id);
        setLiveMessage('');
        loadThreads({ quiet: true }).catch(() => {});
      }
      scheduleThreadRender(message.method === 'turn/started');
    }
    return;
  }
  if (message.type === 'approval') {
    const key = `${message.provider}:${message.request.id}`;
    state.approvals.set(key, { provider: message.provider, request: message.request });
    scheduleThreadRender(true);
    return;
  }
  if (message.type === 'interaction') {
    const key = `${message.provider}:${message.request.id}`;
    state.interactions.set(key, { provider: message.provider, request: message.request });
    scheduleThreadRender(true);
  }
}

function updateThreadActivity(provider, threadId, status) {
  const thread = state.threads.find((candidate) => candidate.provider === provider && candidate.id === threadId);
  if (thread?.tmux) {
    thread.tmux.status = status;
    thread.tmux.activityAt = Date.now();
  }
  if (state.provider === provider && state.thread?.id === threadId && state.thread.tmux) {
    state.thread.tmux.status = status;
    state.thread.tmux.activityAt = Date.now();
  }
  if (thread) renderThreadList();
}

function clearPendingForTurn(provider, threadId, turnId) {
  for (const pending of [state.approvals, state.interactions]) {
    for (const [key, entry] of pending) {
      const params = entry.request.params || {};
      if (entry.provider === provider && params.threadId === threadId && (!turnId || params.turnId === turnId)) {
        pending.delete(key);
      }
    }
  }
}

function agentRequest(type, payload = {}) {
  if (!state.connected || state.socket?.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error('Agent 尚未连接，请稍后重试'));
  }
  const id = state.nextRequestId++;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      state.requests.delete(id);
      reject(new Error('Agent 请求超时'));
    }, 60_000);
    state.requests.set(id, { resolve, reject, timeout });
    state.socket.send(JSON.stringify({ type, id, ...payload }));
  });
}

function timeAgo(rawTimestamp) {
  const value = Number(rawTimestamp || 0);
  if (!value) return '';
  const seconds = Math.round((value - Date.now()) / 1000);
  if (Math.abs(seconds) < 60) return '刚刚';
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return relativeTime.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return relativeTime.format(hours, 'hour');
  return relativeTime.format(Math.round(hours / 24), 'day');
}

function openPendingThread(thread, { quiet = false, refresh = true } = {}) {
  if (!thread?.tmux?.name || thread.tmux.available !== false) return;
  state.threadHandoff = null;
  state.threadOpening = null;
  if (thread.provider !== state.provider) {
    state.provider = thread.provider;
    localStorage.setItem('codeck-remote-provider', thread.provider);
    renderProviderControls();
  }
  state.activeThreadId = thread.id;
  state.thread = normalizeAgentThread(thread.provider, {
    id: thread.id,
    preview: thread.tmux.title || thread.tmux.name,
    readOnly: thread.readOnly,
    turns: [],
  });
  state.thread.tmux = { ...thread.tmux };
  state.threadRefreshUntil = 0;
  if (!quiet) setLiveMessage('已连接当前终端会话，可直接参与。');
  renderThreadList();
  scheduleThreadRender(false);
  closeDrawer();
  if (refresh) loadThreads({ quiet: true }).catch((error) => setLiveMessage(error.message));
}

function openShellThread(thread, { quiet = false } = {}) {
  if (thread?.provider !== 'shell' || !thread.tmux?.name) return;
  state.threadHandoff = null;
  state.threadOpening = null;
  state.provider = 'shell';
  state.activeThreadId = thread.id;
  state.thread = normalizeAgentThread('shell', {
    id: thread.id,
    preview: thread.tmux.title || thread.tmux.name,
    readOnly: false,
    turns: [],
  });
  state.thread.tmux = { ...thread.tmux };
  state.threadRefreshUntil = 0;
  if (!quiet) setLiveMessage('已连接 Shell 会话，可直接输入命令。');
  renderThreadList();
  scheduleThreadRender(false);
  closeDrawer();
}

function handoffPendingThread(thread) {
  if (state.threadHandoff) return state.threadHandoff.promise;
  const pendingThreadId = state.thread?.id;
  const provider = thread.provider;
  const sessionName = thread.tmux.name;
  const handoff = { promise: null };
  const load = (async () => {
    const result = await agentRequest('openThread', {
      provider,
      threadId: thread.id,
      readOnly: true,
    });
    if (
      state.threadHandoff !== handoff
      || state.provider !== provider
      || state.activeThreadId !== pendingThreadId
      || state.thread?.id !== pendingThreadId
      || state.thread?.tmux?.name !== sessionName
      || state.thread.tmux.available !== false
    ) return;
    state.activeThreadId = thread.id;
    state.thread = normalizeAgentThread(provider, result.thread);
    state.thread.tmux = { ...thread.tmux };
    state.threadRefreshUntil = Date.now() + 2_500;
    setLiveMessage('已同步对话记录，可直接参与。');
    renderThreadList();
    scheduleThreadRender(true);
  })();
  handoff.promise = load.finally(() => {
    if (state.threadHandoff === handoff) state.threadHandoff = null;
  });
  state.threadHandoff = handoff;
  return handoff.promise;
}

async function loadThreads({ quiet = false } = {}) {
  if (state.threadLoad) return state.threadLoad;
  const load = (async () => {
    if (!quiet) {
      $('#threadList').replaceChildren(element('div', 'thread-empty', '正在读取会话…'));
    }
    const snapshot = state.sessionSnapshot || await validateOwnerToken(state.token);
    state.sessionSnapshot = null;
    state.threads = tmuxSessionsToThreads(snapshot.sessions)
      .filter((thread) => thread.provider === 'shell' || state.providers.includes(thread.provider));
    const activeThread = state.threads.find((thread) => (
      thread.id === state.thread?.id && thread.provider === state.provider
    ));
    if (activeThread?.tmux && state.thread) {
      if (applyTmuxSnapshot(state.thread, activeThread.tmux)) {
        state.threadRefreshUntil = Date.now() + THREAD_COMPLETION_REFRESH_MS;
        refreshActiveThread({ force: true }).catch(() => {});
      }
    }
    const replacement = findTmuxThreadReplacement(state.threads, state.thread);
    if (replacement?.provider === 'shell') openShellThread(replacement, { quiet: true });
    else if (replacement?.tmux?.available === false) {
      openPendingThread(replacement, { quiet: true, refresh: false });
    }
    else if (replacement) await handoffPendingThread(replacement);
    renderThreadList();
    updateTerminalActivity();
    renderComposerState();
  })();
  state.threadLoad = load;
  try {
    await load;
  } finally {
    if (state.threadLoad === load) state.threadLoad = null;
  }
}

async function openThread(threadId, { provider = state.provider, quiet = false, readOnly = false } = {}) {
  state.threadHandoff = null;
  const opening = {};
  state.threadOpening = opening;
  if (provider !== state.provider) {
    state.provider = provider;
    localStorage.setItem('codeck-remote-provider', provider);
    renderProviderControls();
  }
  const listedThread = state.threads.find((thread) => thread.id === threadId && thread.provider === provider);
  if (!quiet) setLiveMessage('正在读取会话…');
  renderComposerState();
  const directSession = Boolean(listedThread?.tmux?.name);
  try {
    const result = await agentRequest('openThread', { provider, threadId, readOnly: directSession || readOnly });
    if (state.threadOpening !== opening) return;
    state.activeThreadId = threadId;
    state.thread = normalizeAgentThread(provider, result.thread);
    if (listedThread?.tmux) state.thread.tmux = { ...listedThread.tmux };
    state.threadRefreshUntil = directSession ? Date.now() + 2_500 : 0;
    setLiveMessage(directSession ? '已连接当前终端会话，可直接参与。' : state.thread.readOnly ? '当前以只读方式查看。' : '');
    renderThreadList();
    scheduleThreadRender(true);
    closeDrawer();
  } finally {
    if (state.threadOpening === opening) {
      state.threadOpening = null;
      renderComposerState();
    }
  }
}

async function refreshActiveThread({ force = false } = {}) {
  if (state.threadRefresh || !state.connected || document.visibilityState !== 'visible') return;
  const current = state.thread;
  if (current?.provider === 'shell') return;
  const sessionName = current?.tmux?.name;
  if (!shouldRefreshTmuxThread(current, {
    force, refreshUntil: state.threadRefreshUntil,
  })) return;
  const provider = state.provider;
  const threadId = current.id;
  const load = agentRequest('openThread', { provider, threadId, readOnly: true });
  state.threadRefresh = load;
  try {
    const result = await load;
    if (state.provider !== provider || state.thread?.id !== threadId || state.thread?.tmux?.name !== sessionName) return;
    const refreshed = normalizeAgentThread(provider, result.thread);
    refreshed.tmux = { ...state.thread.tmux };
    state.thread = refreshed;
    scheduleThreadRender(false);
  } finally {
    if (state.threadRefresh === load) state.threadRefresh = null;
  }
}

function startNewThread({ focus = true } = {}) {
  state.threadHandoff = null;
  state.threadOpening = null;
  if (!state.providers.includes(state.provider)) {
    state.provider = preferredAgentProvider();
    localStorage.setItem('codeck-remote-provider', state.provider);
    renderProviderControls();
  }
  state.activeThreadId = null;
  state.thread = null;
  state.threadRefreshUntil = 0;
  setLiveMessage('');
  renderThreadList();
  scheduleThreadRender(false);
  closeDrawer();
  if (focus) setTimeout(() => $('#composerInput').focus(), 50);
}

async function switchProvider(provider) {
  if (!state.providers.includes(provider)) return;
  state.threadHandoff = null;
  state.threadOpening = null;
  state.provider = provider;
  localStorage.setItem('codeck-remote-provider', provider);
  state.activeThreadId = null;
  state.thread = null;
  state.threadRefreshUntil = 0;
  renderProviderControls();
  renderThreadList();
  scheduleThreadRender(false);
  $('#providerDialog').open && $('#providerDialog').close();
}

function renderProviderControls() {
  const selectedProvider = preferredAgentProvider();
  const welcome = state.providers.map((provider) => {
    const details = providerDetails(provider);
    const button = element('button', `welcome-provider${provider === selectedProvider ? ' selected' : ''}`);
    button.type = 'button';
    button.append(element('b', '', details.glyph), element('span', '', details.short));
    button.addEventListener('click', () => switchProvider(provider).then(() => $('#composerInput').focus()).catch((error) => setLiveMessage(error.message)));
    return button;
  });
  $('#welcomeProviders').replaceChildren(...welcome);

  const options = state.providers.map((provider) => {
    const details = providerDetails(provider);
    const button = element('button', `provider-option${provider === selectedProvider ? ' selected' : ''}`);
    button.type = 'button';
    const copy = element('span');
    copy.append(element('strong', '', details.name), element('small', '', details.description));
    button.append(element('b', '', details.glyph), copy, element('i'));
    button.addEventListener('click', () => switchProvider(provider).catch((error) => setLiveMessage(error.message)));
    return button;
  });
  $('#providerOptions').replaceChildren(...options);

  const select = $('#settingsProvider');
  select.replaceChildren(...state.providers.map((provider) => {
    const option = element('option', '', providerDetails(provider).name);
    option.value = provider;
    return option;
  }));
  select.value = selectedProvider;
  renderHeader();
}

function renderThreadList() {
  if (!state.threads.length) {
    const empty = element('div', 'thread-empty');
    empty.append(element('span', '', '∅'), document.createTextNode('当前没有运行中的 tmux 会话。'));
    empty.style.whiteSpace = 'pre-line';
    $('#threadList').replaceChildren(empty);
    return;
  }
  const rows = state.threads.map((thread, index) => {
    const active = thread.id === state.activeThreadId && thread.provider === state.provider;
    const details = providerDetails(thread.provider);
    const button = element('button', `thread-row${active ? ' active' : ''}`);
    button.type = 'button';
    button.dataset.threadId = thread.id;
    const copy = element('span', 'thread-copy');
    const tmux = thread.tmux || {};
    const title = tmux.name || thread.name || thread.preview || '未命名会话';
    const status = tmux.status === 'working' ? 'working' : 'done';
    const statusText = status === 'working' ? '正在干活' : '完成';
    const meta = [statusText, timeAgo(tmux.activityAt)].filter(Boolean).join(' · ');
    copy.append(
      element('b', '', title),
      element('small', '', meta),
    );
    const presence = element('span', `presence ${status}`);
    presence.title = statusText;
    button.append(
      element('span', 'thread-index', index + 1),
      element('span', 'thread-glyph', details.glyph),
      copy,
      presence,
    );
    if (tmux.available === false) button.title = '已连接终端，可直接参与';
    button.addEventListener('click', () => {
      if (thread.provider === 'shell') {
        openShellThread(thread);
        return;
      }
      if (tmux.available === false) {
        openPendingThread(thread);
        return;
      }
      openThread(thread.id, {
        provider: thread.provider,
        readOnly: thread.readOnly,
      }).catch((error) => setLiveMessage(error.message));
    });
    return button;
  });
  $('#threadList').replaceChildren(...rows);
}

function renderHeader() {
  const details = providerDetails();
  $('#providerGlyph').textContent = details.glyph;
  $('#providerName').textContent = details.name;
  $('#welcomeMark').textContent = details.glyph;
  $('#hostLabel').textContent = state.hostname || location.hostname || '服务器';
  $('#threadTitle').textContent = state.thread?.tmux?.title || state.thread?.name || state.thread?.preview || '新对话';
  const active = latestRunningTurn(state.thread) || state.thread?.tmux?.status === 'working';
  $('#composerInput').placeholder = state.thread?.readOnly && !state.thread?.tmux?.name
    ? '当前会话只读'
    : active ? '跟进当前任务' : state.thread?.tmux?.name ? `参与 ${details.name} 会话` : `给 ${details.name} 发消息`;
  const cwd = state.thread?.cwd || state.cwd || state.defaultCwd || '工作目录';
  $('#cwdLabel').textContent = compactPath(cwd);
  $('#cwdButton').title = cwd;
  renderComposerState();
}

function compactPath(value) {
  const parts = String(value || '').split('/').filter(Boolean);
  if (parts.length <= 2) return value || '工作目录';
  return `…/${parts.slice(-2).join('/')}`;
}

function statusText(status) {
  if (status === 'inProgress' || status === 'running') return '运行中';
  if (status === 'failed' || status === 'errored') return '失败';
  if (status === 'declined') return '已拒绝';
  return '完成';
}

function safeJson(value) {
  if (value == null || value === '') return '';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2); }
  catch { return String(value); }
}

function clippedText(value, limit = 80_000) {
  const text = String(value || '');
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n… 内容过长，已在手机界面截断 …`;
}

function toolCard({ id, icon, title, body, status, className = '' }) {
  const details = element('details', `tool-card ${className}`.trim());
  details.dataset.itemId = id || '';
  const summary = element('summary');
  const statusNode = element('span', `tool-status ${status === 'inProgress' ? 'running' : status === 'failed' ? 'failed' : ''}`, statusText(status));
  summary.append(element('span', 'tool-icon', icon), element('span', 'tool-title', title || 'Agent 操作'), statusNode);
  details.append(summary);
  if (body) details.append(element('pre', 'tool-body', clippedText(body)));
  return details;
}

function itemNode(item, turn) {
  if (item.type === 'userMessage') return element('div', 'message user-message', userMessageText(item));
  if (item.type === 'agentMessage') {
    const node = element('div', 'message assistant-message', item.text || '');
    if (turn.status === 'inProgress' && item === turn.items.at(-1)) node.classList.add('streaming');
    return node;
  }
  if (item.type === 'reasoning') {
    const summary = Array.isArray(item.summary) ? item.summary.join('\n') : item.summary || item.text || '';
    return toolCard({ id: item.id, icon: '◌', title: '思考过程', body: summary, status: item.status || 'completed', className: 'reasoning-card' });
  }
  if (item.type === 'commandExecution') {
    const command = Array.isArray(item.command) ? item.command.join(' ') : item.command || item.actions?.map((action) => action.command).filter(Boolean).join('\n') || '运行命令';
    const body = [command, item.aggregatedOutput || item.output || ''].filter(Boolean).join('\n\n');
    return toolCard({ id: item.id, icon: '$_', title: command, body, status: item.status });
  }
  if (item.type === 'fileChange') {
    const paths = (item.changes || []).map((change) => change.path || change.file || '').filter(Boolean);
    const title = paths.length ? `修改 ${paths.length} 个文件` : '修改文件';
    return toolCard({ id: item.id, icon: '±', title, body: safeJson(item.changes || item.patch || item.diff), status: item.status, className: 'file-card' });
  }
  if (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall') {
    const name = item.tool || item.name || item.server || '工具调用';
    const body = [safeJson(item.arguments || item.input), safeJson(item.result || item.output || item.error)].filter(Boolean).join('\n\n');
    return toolCard({ id: item.id, icon: '◇', title: name, body, status: item.status });
  }
  if (item.type === 'webSearch') {
    return toolCard({ id: item.id, icon: '◎', title: item.query || '搜索网页', body: safeJson(item), status: item.status || 'completed' });
  }
  if (item.type === 'plan') {
    return toolCard({ id: item.id, icon: '≡', title: '执行计划', body: item.text || safeJson(item.items || item), status: item.status || 'completed' });
  }
  if (item.type === 'collabAgentToolCall') {
    return toolCard({ id: item.id, icon: '↗', title: item.tool || '子 Agent', body: safeJson(item), status: item.status });
  }
  return toolCard({ id: item.id, icon: '·', title: item.type || 'Agent 事件', body: safeJson(item), status: item.status || 'completed' });
}

function agentOutputActions(text) {
  const actions = element('div', 'agent-message-actions');
  const button = element('button', 'message-copy-button', '复制输出');
  button.type = 'button';
  button.setAttribute('aria-label', '复制本轮模型输出');
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await writeAgentOutputToClipboard(text);
      button.dataset.copyState = 'success';
      button.textContent = '已复制';
      setLiveMessage('已复制模型输出');
    } catch (error) {
      button.dataset.copyState = 'error';
      button.textContent = '复制失败';
      setLiveMessage(error.message);
    }
    setTimeout(() => {
      if (!button.isConnected) return;
      button.disabled = false;
      delete button.dataset.copyState;
      button.textContent = '复制输出';
    }, 1_600);
  });
  actions.append(button);
  return actions;
}

function renderTurn(turn) {
  const section = element('section', 'turn');
  section.dataset.turnId = turn.id;
  for (const item of turn.items || []) section.append(itemNode(item, turn));
  if (turn.error) section.append(element('div', 'turn-error', turn.error));
  const output = agentOutputText(turn);
  if (output && turn.status !== 'inProgress' && turn.status !== 'running') {
    section.append(agentOutputActions(output));
  }
  const foot = element('div', 'turn-foot');
  if (turn.status === 'inProgress') foot.append(element('span', 'spinner'), element('span', 'working', '正在处理'));
  else {
    const duration = Number.isFinite(turn.durationMs) ? ` · ${Math.max(.1, turn.durationMs / 1000).toFixed(1)} 秒` : '';
    foot.textContent = `${statusText(turn.status)}${duration}`;
  }
  section.append(foot);
  return section;
}

function terminalActivityNode() {
  const section = element('section', 'turn terminal-activity');
  const foot = element('div', 'turn-foot');
  const shell = state.thread?.provider === 'shell';
  const working = state.thread?.tmux?.status === 'working';
  section.dataset.activityStatus = working ? 'working' : 'done';
  foot.setAttribute('role', 'status');
  foot.setAttribute('aria-live', 'polite');
  if (working) foot.append(element('span', 'spinner'));
  foot.append(element('span', 'working', shell
    ? working ? 'Shell 命令正在运行' : 'Shell 当前输出'
    : !working ? '终端当前输出'
      : agentActivityText(state.thread) || '终端 Agent 正在工作'));
  const output = element('pre', 'terminal-live-output', state.thread?.tmux?.liveOutput || '');
  output.hidden = !state.thread?.tmux?.liveOutput;
  output.tabIndex = 0;
  output.setAttribute('aria-label', 'tmux 当前实时输出');
  section.append(foot, output);
  requestAnimationFrame(() => {
    if (output.isConnected) output.scrollTop = output.scrollHeight;
  });
  return section;
}

function updateTerminalActivity() {
  const section = $('.terminal-activity');
  const current = $('.terminal-activity .working');
  const output = $('.terminal-activity .terminal-live-output');
  const shell = state.thread?.provider === 'shell';
  const status = state.thread?.tmux?.status === 'working' ? 'working' : 'done';
  const visible = shouldShowTerminalActivity(state.thread);
  if (!visible) {
    if (current) scheduleThreadRender(false);
    return;
  }
  if (!current || !output) {
    scheduleThreadRender(false);
    return;
  }
  if (section?.dataset.activityStatus !== status) {
    scheduleThreadRender(false);
    return;
  }
  const transcript = $('#transcript');
  const nearBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 100;
  const outputNearBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 40;
  const activity = shell
    ? status === 'working' ? 'Shell 命令正在运行' : 'Shell 当前输出'
    : status !== 'working' ? '终端当前输出'
      : agentActivityText(state.thread) || '终端 Agent 正在工作';
  const liveOutput = state.thread?.tmux?.liveOutput || '';
  const changed = current.textContent !== activity || output.textContent !== liveOutput || output.hidden !== !liveOutput;
  if (current.textContent !== activity) current.textContent = activity;
  if (output.textContent !== liveOutput) output.textContent = liveOutput;
  output.hidden = !liveOutput;
  if (changed) requestAnimationFrame(() => {
    if (outputNearBottom) output.scrollTop = output.scrollHeight;
    if (nearBottom) transcript.scrollTop = transcript.scrollHeight;
  });
}

function approvalNode(key, entry) {
  const params = entry.request.params || {};
  const card = element('section', 'approval-card');
  card.dataset.requestKey = key;
  card.append(
    element('h3', '', params.title || `${providerDetails(entry.provider).name} 请求授权`),
    element('p', '', params.description || params.reason || `${params.toolName || 'Agent'} 需要你确认后才能继续。`),
  );
  const input = params.input || params.command || params.changes || params.permissions;
  if (input) card.append(element('pre', 'approval-input', clippedText(safeJson(input), 20_000)));
  const actions = element('div', 'approval-actions');
  const decisions = [['accept', '允许一次', 'allow']];
  if (params.canAcceptForSession !== false) {
    decisions.push(['acceptForSession', '本次会话允许', 'allow']);
  }
  decisions.push(['decline', '拒绝', 'deny']);
  for (const [decision, label, className] of decisions) {
    const button = element('button', className, label);
    button.type = 'button';
    button.addEventListener('click', () => resolveApproval(key, entry, decision, card));
    actions.append(button);
  }
  card.append(actions);
  return card;
}

function interactionNode(key, entry) {
  const questions = normalizeInteractionQuestions(entry.request.params);
  const form = element('form', 'question-card');
  form.dataset.requestKey = key;
  form.append(
    element('span', 'question-kicker', `${providerDetails(entry.provider).name} 需要你的回答`),
    element('h3', '', questions.length > 1 ? '继续前请确认以下问题' : questions[0]?.header || '需要补充信息'),
  );

  for (const [index, question] of questions.entries()) {
    const fieldset = element('fieldset', 'question-field');
    fieldset.dataset.questionId = question.id;
    fieldset.dataset.multiSelect = String(question.multiSelect);
    if (questions.length > 1) fieldset.append(element('legend', '', question.header));
    fieldset.append(element('p', '', question.question));
    const options = element('div', 'question-options');
    const inputType = question.multiSelect ? 'checkbox' : 'radio';
    for (const option of question.options) {
      const label = element('label', 'question-option');
      const input = element('input');
      input.type = inputType;
      input.name = `question-${index}`;
      input.value = option.label;
      const copy = element('span');
      copy.append(element('strong', '', option.label));
      if (option.description) copy.append(element('small', '', option.description));
      label.append(input, copy);
      options.append(label);
    }
    if (question.options.length) fieldset.append(options);
    if (question.isOther || !question.options.length) {
      const other = element('input', 'question-other');
      other.type = question.isSecret ? 'password' : 'text';
      other.placeholder = question.options.length ? '其他答案…' : '输入回答…';
      other.autocomplete = 'off';
      other.dataset.other = 'true';
      if (!question.multiSelect) {
        other.addEventListener('input', () => {
          if (other.value) for (const option of fieldset.querySelectorAll('.question-option input')) option.checked = false;
        });
        for (const option of fieldset.querySelectorAll('.question-option input')) {
          option.addEventListener('change', () => { if (option.checked) other.value = ''; });
        }
      }
      fieldset.append(other);
    }
    form.append(fieldset);
  }
  const error = element('p', 'question-error');
  error.setAttribute('role', 'alert');
  const actions = element('div', 'question-actions');
  const submit = element('button', 'allow', '回答并继续');
  submit.type = 'submit';
  actions.append(submit);
  form.append(error, actions);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    resolveInteraction(key, entry, questions, form).catch((resolveError) => setLiveMessage(resolveError.message));
  });
  return form;
}

async function resolveInteraction(key, entry, questions, form) {
  const answers = {};
  for (const question of questions) {
    const fieldset = [...form.querySelectorAll('.question-field')]
      .find((candidate) => candidate.dataset.questionId === question.id);
    const values = [...fieldset.querySelectorAll('.question-option input:checked')].map((input) => input.value);
    const other = fieldset.querySelector('.question-other')?.value.trim();
    if (other) values.push(other);
    if (!values.length) {
      form.querySelector('.question-error').textContent = `请回答“${question.header}”。`;
      (fieldset.querySelector('input') || fieldset).focus();
      return;
    }
    answers[question.id] = question.multiSelect ? values : [values.at(-1)];
  }
  form.querySelector('.question-error').textContent = '';
  for (const control of form.querySelectorAll('button, input')) control.disabled = true;
  try {
    await agentRequest('resolveInteraction', {
      provider: entry.provider,
      requestId: entry.request.id,
      answers,
    });
    state.interactions.delete(key);
    scheduleThreadRender(false);
  } catch (error) {
    for (const control of form.querySelectorAll('button, input')) control.disabled = false;
    if (/already resolved|expired/i.test(error.message)) {
      state.interactions.delete(key);
      scheduleThreadRender(false);
    }
    throw error;
  }
}

async function resolveApproval(key, entry, decision, card) {
  for (const button of card.querySelectorAll('button')) button.disabled = true;
  try {
    await agentRequest('resolveApproval', {
      provider: entry.provider,
      requestId: entry.request.id,
      decision,
    });
    state.approvals.delete(key);
    scheduleThreadRender(false);
  } catch (error) {
    if (/already resolved|expired/i.test(error.message)) {
      state.approvals.delete(key);
      scheduleThreadRender(false);
    }
    setLiveMessage(error.message);
  }
}

function scheduleThreadRender(forceBottom = false) {
  state.forceScroll ||= forceBottom;
  if (state.renderFrame) return;
  state.renderFrame = requestAnimationFrame(() => {
    state.renderFrame = 0;
    renderThread();
  });
}

function renderThread() {
  const transcript = $('#transcript');
  const nearBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 100;
  const openItems = new Set([...$('#turns').querySelectorAll('details[open]')].map((item) => item.dataset.itemId));
  $('#welcome').hidden = Boolean(state.thread);
  const nodes = (state.thread?.turns || []).map(renderTurn);
  if (shouldShowTerminalActivity(state.thread)) {
    nodes.push(terminalActivityNode());
  }
  $('#turns').replaceChildren(...nodes);
  for (const details of $('#turns').querySelectorAll('details')) {
    if (openItems.has(details.dataset.itemId)) details.open = true;
  }
  const approvals = [...state.approvals.entries()].filter(([, entry]) => (
    entry.provider === state.provider && entry.request.params?.threadId === state.thread?.id
  ));
  const interactions = [...state.interactions.entries()].filter(([, entry]) => (
    entry.provider === state.provider && entry.request.params?.threadId === state.thread?.id
  ));
  const existingRequests = new Map([...$('#approvalStack').children]
    .filter((node) => node.dataset.requestKey)
    .map((node) => [node.dataset.requestKey, node]));
  $('#approvalStack').replaceChildren(
    ...interactions.map(([key, entry]) => existingRequests.get(key) || interactionNode(key, entry)),
    ...approvals.map(([key, entry]) => existingRequests.get(key) || approvalNode(key, entry)),
  );
  renderHeader();
  if (state.forceScroll || nearBottom) requestAnimationFrame(() => { transcript.scrollTop = transcript.scrollHeight; });
  state.forceScroll = false;
}

function renderComposerState() {
  const input = $('#composerInput');
  const sendButton = $('#sendButton');
  if (!input || !sendButton) return;
  const running = latestRunningTurn(state.thread);
  const activity = agentActivityText(state.thread);
  const sessionName = state.thread?.tmux?.name;
  const active = Boolean(running || state.thread?.tmux?.status === 'working');
  const readOnly = Boolean(state.thread?.readOnly && !sessionName);
  const hasText = Boolean(input.value.trim());
  const pending = composerRequestGate.pending;
  const opening = Boolean(state.threadOpening);
  const controls = composerControlState({
    active, connected: state.connected, hasText, opening, pending, readOnly,
  });
  sendButton.classList.toggle('stop-mode', controls.stopMode);
  input.disabled = readOnly || opening;
  $('.composer').classList.toggle('read-only', readOnly);
  $('.composer').setAttribute('aria-busy', String(pending || opening));
  sendButton.disabled = controls.disabled;
  sendButton.setAttribute('aria-label', controls.ariaLabel);
  const status = $('#composerStatus');
  status.replaceChildren();
  const dot = element('i', `connection-dot ${state.connected ? active ? 'busy' : 'online' : 'problem'}`);
  const message = opening
    ? '正在读取会话…'
    : !state.connected
      ? '连接已断开'
      : sessionName
        ? state.thread?.provider === 'shell'
          ? active ? 'Shell 命令正在运行 · 可直接输入' : '已连接 Shell 会话 · 可直接输入'
          : active ? `${activity || '终端 Agent 正在工作'} · 可直接输入` : '已连接当前终端会话 · 可直接输入'
        : readOnly ? '当前会话只读' : active ? `${activity || '正在处理'} · 可继续输入` : '已连接';
  status.append(dot, document.createTextNode(message));
  input.placeholder = opening
    ? '正在读取会话…'
    : readOnly
      ? '当前会话只读'
      : state.thread?.provider === 'shell' ? '输入 Shell 命令'
        : active ? '跟进当前任务' : sessionName ? `参与 ${providerDetails().name} 会话` : `给 ${providerDetails().name} 发消息`;
}

function resizeComposer() {
  const input = $('#composerInput');
  input.style.height = 'auto';
  input.style.height = `${Math.min(144, input.scrollHeight)}px`;
  renderComposerState();
}

async function submitComposer() {
  if (composerRequestGate.pending || state.threadOpening) return;
  const input = $('#composerInput');
  const draft = input.value;
  const text = draft.trim();
  const running = latestRunningTurn(state.thread);
  const sessionName = state.thread?.tmux?.name;
  const active = Boolean(running || state.thread?.tmux?.status === 'working');
  if (state.thread?.readOnly && !sessionName) {
    setLiveMessage('当前会话只读。');
    return;
  }
  if (!text && active) {
    await composerRequestGate.run(async () => {
      try {
        setLiveMessage('正在停止任务…');
        if (sessionName) {
          await agentRequest('interruptSession', {
            provider: state.provider,
            threadId: state.thread.id,
            tmuxSession: sessionName,
          });
          state.threadRefreshUntil = Date.now() + 3_000;
        } else {
          await agentRequest('interruptTurn', {
            provider: state.provider,
            threadId: state.thread.id,
            turnId: running.id,
          });
        }
        setLiveMessage('已发送停止请求');
      } catch (error) { setLiveMessage(error.message); }
    });
    return;
  }
  if (!text) return;
  await composerRequestGate.run(async () => {
    setLiveMessage('正在发送…');
    let sentPendingSession = false;
    try {
      if (!state.thread) {
        const result = await agentRequest('newThread', {
          provider: state.provider,
          cwd: state.cwd || state.defaultCwd,
          text,
        });
        state.activeThreadId = result.thread.id;
        state.thread = normalizeAgentThread(state.provider, result.thread);
        scheduleThreadRender(true);
        await loadThreads({ quiet: true });
      } else if (sessionName) {
        sentPendingSession = state.thread.tmux.available === false;
        await agentRequest('sendSessionMessage', {
          provider: state.provider,
          threadId: state.thread.id,
          tmuxSession: sessionName,
          text,
        });
        state.thread.tmux.status = 'working';
        state.thread.tmux.activityAt = Date.now();
        const listedThread = state.threads.find((candidate) => (
          candidate.id === state.thread.id && candidate.provider === state.provider
        ));
        if (listedThread?.tmux) {
          listedThread.tmux.status = 'working';
          listedThread.tmux.activityAt = Date.now();
        }
        state.threadRefreshUntil = sentPendingSession ? 0 : Date.now() + 10_000;
        renderThreadList();
        renderComposerState();
        if (sentPendingSession || state.provider === 'shell') loadThreads({ quiet: true }).catch(() => {});
        else refreshActiveThread({ force: true }).catch(() => {});
      } else {
        await agentRequest('sendMessage', {
          provider: state.provider,
          threadId: state.thread.id,
          turnId: running?.id,
          mode: running ? 'steer' : 'followUp',
          text,
        });
        scheduleThreadRender(true);
      }
      input.value = draftAfterSuccessfulSend(input.value, draft);
      resizeComposer();
      setLiveMessage(sentPendingSession ? '消息已发送，正在同步对话…' : '');
    } catch (error) {
      setLiveMessage(error.message);
    }
  });
}

function openDrawer() {
  $('#threadDrawer').classList.add('open');
  $('#drawerScrim').classList.add('open');
  $('#drawerButton').setAttribute('aria-expanded', 'true');
}

function closeDrawer() {
  $('#threadDrawer').classList.remove('open');
  $('#drawerScrim').classList.remove('open');
  $('#drawerButton').setAttribute('aria-expanded', 'false');
}

function openProviderDialog() {
  renderProviderControls();
  $('#providerDialog').showModal();
}

function openSettings() {
  $('#settingsProvider').value = preferredAgentProvider();
  $('#cwdInput').value = state.thread?.cwd || state.cwd || state.defaultCwd;
  $('#settingsDialog').showModal();
}

function syncViewportHeight() {
  if (viewportFrame) return;
  viewportFrame = requestAnimationFrame(() => {
    viewportFrame = 0;
    const transcript = $('#transcript');
    const nearBottom = transcript
      && transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 100;
    const { height, top } = resolveViewportGeometry(window.visualViewport, window.innerHeight);
    const root = document.documentElement;
    const nextHeight = `${height}px`;
    const nextTop = `${top}px`;
    const changed = root.style.getPropertyValue('--app-height') !== nextHeight
      || root.style.getPropertyValue('--app-top') !== nextTop;
    if (!changed) return;
    root.style.setProperty('--app-height', nextHeight);
    root.style.setProperty('--app-top', nextTop);
    if (nearBottom) requestAnimationFrame(() => { transcript.scrollTop = transcript.scrollHeight; });
  });
}

$('#drawerButton').addEventListener('click', openDrawer);
$('#drawerScrim').addEventListener('click', closeDrawer);
$('#drawerNewButton').addEventListener('click', () => startNewThread());
$('#newThreadButton').addEventListener('click', () => startNewThread());
$('#providerButton').addEventListener('click', openProviderDialog);
$('#settingsButton').addEventListener('click', openSettings);
$('#composerPlus').addEventListener('click', openSettings);
$('#cwdButton').addEventListener('click', openSettings);
$('#composerInput').addEventListener('input', resizeComposer);
$('#composerInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $('#composerForm').requestSubmit();
  }
});
$('#composerForm').addEventListener('submit', (event) => {
  event.preventDefault();
  submitComposer();
});
$('#settingsForm').addEventListener('submit', (event) => {
  event.preventDefault();
  if (event.submitter?.value === 'cancel') {
    $('#settingsDialog').close();
    return;
  }
  const cwd = $('#cwdInput').value.trim();
  if (!cwd.startsWith('/')) {
    $('#cwdInput').setCustomValidity('请输入服务器上的绝对路径');
    $('#cwdInput').reportValidity();
    return;
  }
  $('#cwdInput').setCustomValidity('');
  state.cwd = cwd;
  localStorage.setItem('codeck-remote-cwd', cwd);
  const provider = $('#settingsProvider').value;
  $('#settingsDialog').close();
  const changed = provider !== state.provider;
  const action = changed ? switchProvider(provider) : Promise.resolve();
  action.then(() => startNewThread()).catch((error) => setLiveMessage(error.message));
});
$('#forgetTokenButton').addEventListener('click', () => {
  localStorage.removeItem('codeck-token');
  state.token = '';
  state.sessionSnapshot = null;
  state.socketGeneration += 1;
  state.socket?.close();
  state.socket = null;
  $('#settingsDialog').close();
  $('#tokenInput').value = '';
  $('#tokenDialog').showModal();
});
$('#tokenDialog').addEventListener('cancel', (event) => event.preventDefault());
$('#tokenForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const token = $('#tokenInput').value.trim();
  $('#tokenError').textContent = '';
  try {
    state.sessionSnapshot = await validateOwnerToken(token);
    state.token = token;
    localStorage.setItem('codeck-token', token);
    $('#tokenDialog').close();
    connectSocket();
  } catch (error) {
    $('#tokenError').textContent = error.message;
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeDrawer();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (state.token && !state.socket) connectSocket();
  else if (state.connected) {
    loadThreads({ quiet: true }).catch(() => {});
    refreshActiveThread({ force: true }).catch(() => {});
  }
});
window.visualViewport?.addEventListener('resize', syncViewportHeight);
window.visualViewport?.addEventListener('scroll', syncViewportHeight);
window.addEventListener('resize', syncViewportHeight);
setInterval(() => {
  if (state.connected && document.visibilityState === 'visible') loadThreads({ quiet: true }).catch(() => {});
}, SESSION_LIST_POLL_MS);
setInterval(() => {
  refreshActiveThread().catch(() => {});
}, THREAD_REFRESH_POLL_MS);

syncViewportHeight();
renderProviderControls();
renderThreadList();
renderThread();
resizeComposer();
if (state.token) {
  validateOwnerToken(state.token).then((snapshot) => {
    state.sessionSnapshot = snapshot;
    connectSocket();
  }).catch((error) => {
    if (/令牌|owner/.test(error.message)) localStorage.removeItem('codeck-token');
    $('#tokenError').textContent = error.message;
    $('#tokenDialog').showModal();
  });
} else {
  $('#tokenDialog').showModal();
}
