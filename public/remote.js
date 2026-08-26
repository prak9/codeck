import {
  agentActivityText,
  applyAgentEvent,
  applyTmuxSnapshot,
  findTmuxThreadTarget,
  findTmuxThreadReplacement,
  latestRunningTurn,
  normalizeAgentThread,
  normalizeInteractionQuestions,
  reconcileAgentThreadRefresh,
  shouldRefreshTmuxThread,
  shouldShowTerminalActivity,
  tmuxSessionsToThreads,
  userMessageText,
} from './agent-model.js?v=24';
import { composerControlState, composerSubmitAction, createComposerRequestGate, draftAfterSuccessfulSend, sessionStatusAfterSend } from './remote-composer.js?v=5';
import { attachmentMessage, validateAttachmentSelection } from './remote-attachments.js?v=1';
import { agentOutputText, writeAgentOutputToClipboard } from './remote-copy.js?v=1';
import { parseModelCommandOutput, parseSkillsCommandOutput } from './remote-command-output.js?v=2';
import { resolveViewportGeometry } from './remote-viewport.js?v=1';
import { createSpeechInput, mergeSpeechDraft } from './remote-speech.js?v=3';
import {
  completeSlashCommand,
  slashCommandKeyAction,
  slashCommandMenuAvailable,
  slashCommandSuggestions,
} from './slash-commands.js?v=1';
import {
  createRemoteSessionPayload,
  findCreatedRemoteSession,
  nextThreadAfterClose,
  suggestedRemoteSessionName,
} from './remote-session.js?v=2';
import {
  SESSION_VISIBILITY_STORAGE_KEY,
  loadHiddenSessionPrefixes,
  parseSessionPrefixInput,
  partitionSessionsByPrefix,
  saveHiddenSessionPrefixes,
} from './session-visibility.js?v=1';

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
  theme: document.documentElement.dataset.theme === 'light' ? 'light' : 'dark',
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
  hiddenSessionPrefixes: loadHiddenSessionPrefixes(localStorage),
  activeThreadId: null,
  thread: null,
  approvals: new Map(),
  interactions: new Map(),
  renderFrame: 0,
  forceScroll: false,
  liveMessage: '',
  sessionSnapshot: null,
  threadLoad: null,
  threadListGeneration: 0,
  threadRefresh: null,
  threadRefreshUntil: 0,
  threadHandoff: null,
  threadOpening: null,
  slashCommandIndex: 0,
  slashCommandDismissedValue: null,
  attachments: [],
  attachmentDragDepth: 0,
  sessionCreationPending: false,
  sessionClosePending: false,
  sessionCloseTarget: null,
};
const composerRequestGate = createComposerRequestGate(() => renderComposerState());
let speechBaseDraft = '';
let speechHadResult = false;

function setSpeechInputState(active, message = '') {
  const button = $('#voiceInputButton');
  button.classList.toggle('listening', active);
  button.setAttribute('aria-pressed', String(active));
  const label = active ? '停止语音输入' : '开始语音输入';
  button.setAttribute('aria-label', label);
  button.title = label;
  $('#speechInputStatus').textContent = message;
}

const speechInput = createSpeechInput({
  scope: window,
  lang: document.documentElement.lang || navigator.language || 'zh-CN',
  onListeningChange: (listening) => {
    setSpeechInputState(listening, listening
      ? '正在听写，再点一次麦克风停止。'
      : speechHadResult ? '语音已写入草稿。' : '语音输入已结束。');
  },
  onTranscript: ({ transcript }) => {
    const input = $('#composerInput');
    input.value = mergeSpeechDraft(speechBaseDraft, transcript);
    speechHadResult = Boolean(transcript);
    state.slashCommandIndex = 0;
    state.slashCommandDismissedValue = null;
    resizeComposer();
  },
  onError: (message) => {
    setSpeechInputState(false, message);
    setLiveMessage(message);
  },
});
if (!speechInput.supported) document.documentElement.classList.remove('speech-input');

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

function preferredNewSessionProvider() {
  const saved = localStorage.getItem('codeck-remote-provider');
  return state.providers.includes(saved) ? saved : preferredAgentProvider();
}

function applyTheme(theme, { persist = false } = {}) {
  const selected = theme === 'light' ? 'light' : 'dark';
  state.theme = selected;
  document.documentElement.dataset.theme = selected;
  document.querySelector('meta[name="theme-color"]').content = selected === 'light' ? '#ffffff' : '#151517';
  const select = $('#settingsTheme');
  if (select) select.value = selected;
  if (persist) localStorage.setItem('codeck-remote-theme', selected);
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

function attachmentSize(size) {
  const bytes = Number(size || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function attachmentBadge(file) {
  if (file.type?.startsWith('image/')) return 'IMG';
  const extension = file.name?.split('.').at(-1);
  return extension && extension !== file.name ? extension.slice(0, 4).toUpperCase() : 'FILE';
}

function attachmentStatus(attachment) {
  if (attachment.status === 'uploading') return '正在上传…';
  if (attachment.status === 'uploaded') return `${attachmentSize(attachment.file.size)} · 已上传`;
  if (attachment.status === 'error') return '上传失败，发送时重试';
  return `${attachmentSize(attachment.file.size)} · 待上传`;
}

function renderAttachments() {
  const tray = $('#attachmentTray');
  if (!tray) return;
  const disabled = composerRequestGate.pending || Boolean(state.threadOpening);
  const items = state.attachments.map((attachment) => {
    const item = element('div', `attachment-item${attachment.status === 'error' ? ' error' : ''}`);
    const preview = element('span', 'attachment-preview', attachmentBadge(attachment.file));
    if (attachment.previewUrl) {
      const image = document.createElement('img');
      image.src = attachment.previewUrl;
      image.alt = '';
      image.width = 44;
      image.height = 44;
      image.addEventListener('error', () => preview.replaceChildren(document.createTextNode('IMG')));
      preview.replaceChildren(image);
    }
    const copy = element('span', 'attachment-copy');
    copy.append(
      element('strong', '', attachment.file.name || '未命名文件'),
      element('small', '', attachmentStatus(attachment)),
    );
    const remove = element('button', 'attachment-remove', '×');
    remove.type = 'button';
    remove.disabled = disabled || attachment.status === 'uploading';
    remove.setAttribute('aria-label', `移除附件 ${attachment.file.name || '未命名文件'}`);
    remove.addEventListener('click', () => removeAttachment(attachment.id));
    item.append(preview, copy, remove);
    return item;
  });
  tray.replaceChildren(...items);
  tray.hidden = !items.length;
}

function removeAttachment(id) {
  const attachment = state.attachments.find((candidate) => candidate.id === id);
  if (!attachment || attachment.status === 'uploading' || composerRequestGate.pending) return;
  if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
  state.attachments = state.attachments.filter((candidate) => candidate.id !== id);
  renderAttachments();
  renderComposerState();
}

function clearAttachments(attachments) {
  const sentIds = new Set(attachments.map((attachment) => attachment.id));
  for (const attachment of state.attachments) {
    if (sentIds.has(attachment.id) && attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
  }
  state.attachments = state.attachments.filter((attachment) => !sentIds.has(attachment.id));
  renderAttachments();
}

function addAttachmentFiles(files) {
  const { accepted, rejected } = validateAttachmentSelection(files, state.attachments.length);
  for (const file of accepted) {
    state.attachments.push({
      id: crypto.randomUUID(),
      file,
      previewUrl: file.type?.startsWith('image/') ? URL.createObjectURL(file) : '',
      status: 'pending',
      path: '',
      error: '',
    });
  }
  renderAttachments();
  renderComposerState();
  if (rejected.length) setLiveMessage([...new Set(rejected.map((item) => item.message))].join('；'));
  else if (accepted.length && state.provider === 'shell') setLiveMessage('附件已就绪，请输入要执行的 Shell 命令。');
  else if (accepted.length) setLiveMessage(`已添加 ${accepted.length} 个附件`);
}

async function uploadAttachment(attachment) {
  if (attachment.path) return attachment.path;
  attachment.status = 'uploading';
  attachment.error = '';
  renderAttachments();
  const params = new URLSearchParams({
    name: `${Date.now()}-${attachment.id.slice(0, 8)}-${attachment.file.name || 'attachment'}`,
    relativePath: 'remote',
  });
  try {
    const response = await fetch(`/api/uploads/files?${params}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        Authorization: `Bearer ${state.token}`,
      },
      body: attachment.file,
    });
    if (response.status === 401) throw new Error('访问令牌已失效');
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `上传失败 (${response.status})`);
    }
    const result = await response.json();
    if (!result.path) throw new Error('服务器没有返回附件路径');
    attachment.path = result.path;
    attachment.status = 'uploaded';
    renderAttachments();
    return result.path;
  } catch (error) {
    attachment.status = 'error';
    attachment.error = error.message;
    renderAttachments();
    throw error;
  }
}

async function uploadAttachments(attachments) {
  const outcomes = await Promise.allSettled(attachments.map(uploadAttachment));
  const failure = outcomes.find((outcome) => outcome.status === 'rejected');
  if (failure) throw failure.reason;
  return outcomes.map((outcome) => outcome.value);
}

async function validateOwnerToken(token) {
  const response = await fetch('/api/sessions', { headers: { Authorization: `Bearer ${token}` } });
  if (response.status === 401) throw new Error('令牌不正确，请检查 Codeck 启动日志。');
  if (!response.ok) throw new Error(`无法连接 Codeck（${response.status}）`);
  const data = await response.json();
  if (data.capabilities?.canManage === false) throw new Error('远程 Agent 需要 owner 令牌，分享令牌只有终端只读权限。');
  return data;
}

async function requestSessionCreation(payload) {
  const response = await fetch('/api/sessions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${state.token}`,
    },
    body: JSON.stringify(payload),
  });
  if (response.status === 401) throw new Error('访问令牌已失效');
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `创建会话失败 (${response.status})`);
  }
  return response.json();
}

async function requestSessionClose(name) {
  const response = await fetch(`/api/sessions/${encodeURIComponent(name)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${state.token}` },
  });
  if (response.status === 401) throw new Error('访问令牌已失效');
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `关闭会话失败 (${response.status})`);
  }
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
    const listedThread = findTmuxThreadTarget(state.threads, {
      id: state.activeThreadId,
      provider: state.provider,
      tmux: state.thread?.tmux,
    });
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
      tmuxSession: listedThread?.tmux?.name,
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
    }
    // A completed turn may leave Agent-owned work behind. The tmux snapshot loaded
    // below decides between background and done instead of flashing a false ready state.
    if (message.provider === state.provider && state.thread?.id === message.params?.threadId) {
      if (message.method === 'turn/started' && state.thread.tmux?.commandOutput) {
        delete state.thread.tmux.commandOutput;
      }
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
  const matches = state.threads.filter((candidate) => candidate.provider === provider && candidate.id === threadId);
  const thread = matches.length === 1 ? matches[0] : findTmuxThreadTarget(matches, state.thread);
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

function handoffTmuxThread(thread) {
  if (state.threadHandoff) return state.threadHandoff.promise;
  const previousThreadId = state.thread?.id;
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
      || state.activeThreadId !== previousThreadId
      || state.thread?.id !== previousThreadId
      || state.thread?.tmux?.name !== sessionName
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
  const generation = state.threadListGeneration;
  const load = (async () => {
    if (!quiet) {
      $('#threadList').replaceChildren(element('div', 'thread-empty', '正在读取会话…'));
    }
    const snapshot = state.sessionSnapshot || await validateOwnerToken(state.token);
    state.sessionSnapshot = null;
    if (generation !== state.threadListGeneration) return;
    state.threads = tmuxSessionsToThreads(snapshot.sessions)
      .filter((thread) => thread.provider === 'shell' || state.providers.includes(thread.provider));
    const activeThread = findTmuxThreadTarget(state.threads, state.thread);
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
    else if (replacement) await handoffTmuxThread(replacement);
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

async function openThread(threadId, {
  provider = state.provider, quiet = false, readOnly = false, tmuxSession = null,
} = {}) {
  state.threadHandoff = null;
  const opening = {};
  state.threadOpening = opening;
  if (provider !== state.provider) {
    state.provider = provider;
    localStorage.setItem('codeck-remote-provider', provider);
    renderProviderControls();
  }
  const listedThread = findTmuxThreadTarget(state.threads, {
    id: threadId,
    provider,
    ...(tmuxSession ? { tmux: { name: tmuxSession } } : {}),
  });
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
    const reconciled = reconcileAgentThreadRefresh(state.thread, refreshed);
    if (reconciled === state.thread) return;
    state.thread = reconciled;
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

  for (const select of [$('#settingsProvider'), $('#sessionProvider')]) {
    select.replaceChildren(...state.providers.map((provider) => {
      const option = element('option', '', providerDetails(provider).name);
      option.value = provider;
      return option;
    }));
    select.value = selectedProvider;
  }
  renderHeader();
}

function openListedThread(thread, { quiet = false } = {}) {
  if (thread.provider === 'shell') {
    openShellThread(thread, { quiet });
    return Promise.resolve();
  }
  if (thread.tmux?.available === false) {
    openPendingThread(thread, { quiet });
    return Promise.resolve();
  }
  return openThread(thread.id, {
    provider: thread.provider,
    quiet,
    readOnly: thread.readOnly,
    tmuxSession: thread.tmux?.name,
  });
}

function sessionVisibilityPartition(prefixes = state.hiddenSessionPrefixes) {
  return partitionSessionsByPrefix(state.threads, prefixes, (thread) => thread.tmux?.name);
}

function updateSessionVisibilitySummary(prefixes = parseSessionPrefixInput($('#hiddenSessionPrefixesInput').value)) {
  const { visible, hidden } = sessionVisibilityPartition(prefixes);
  $('#sessionVisibilitySummary').textContent = state.threads.length
    ? `将显示 ${visible.length} 个会话，隐藏 ${hidden.length} 个。`
    : '当前没有运行中的 tmux 会话。';
}

function syncSessionVisibilityButton(hiddenCount = sessionVisibilityPartition().hidden.length) {
  const button = $('#sessionVisibilityButton');
  const count = $('#sessionVisibilityRuleCount');
  const ruleCount = state.hiddenSessionPrefixes.length;
  count.hidden = !ruleCount;
  count.textContent = ruleCount > 99 ? '99+' : String(ruleCount);
  const label = ruleCount
    ? `设置会话显示，已配置 ${ruleCount} 个隐藏前缀，当前隐藏 ${hiddenCount} 个会话`
    : '设置会话显示';
  button.setAttribute('aria-label', label);
  button.title = label;
}

function openSessionVisibilityDialog() {
  const input = $('#hiddenSessionPrefixesInput');
  input.value = state.hiddenSessionPrefixes.join('\n');
  updateSessionVisibilitySummary(state.hiddenSessionPrefixes);
  const dialog = $('#sessionVisibilityDialog');
  if (!dialog.open) dialog.showModal();
  requestAnimationFrame(() => input.focus({ preventScroll: true }));
}

function applySessionVisibility(prefixes) {
  state.hiddenSessionPrefixes = saveHiddenSessionPrefixes(localStorage, prefixes);
  renderThreadList();
}

function threadListEmpty(hiddenCount) {
  const empty = element('div', 'thread-empty');
  empty.append(
    element('span', '', '∅'),
    document.createTextNode(hiddenCount
      ? `当前浏览器隐藏了 ${hiddenCount} 个会话`
      : '当前没有运行中的 tmux 会话。'),
  );
  if (hiddenCount) {
    const button = element('button', 'visibility-empty-button', '调整显示');
    button.type = 'button';
    button.addEventListener('click', openSessionVisibilityDialog);
    empty.append(button);
  }
  return empty;
}

function renderThreadList() {
  const { visible, hidden } = sessionVisibilityPartition();
  syncSessionVisibilityButton(hidden.length);
  if ($('#sessionVisibilityDialog').open) updateSessionVisibilitySummary();
  if (!visible.length) {
    $('#threadList').replaceChildren(threadListEmpty(hidden.length));
    return;
  }
  const rows = visible.map((thread, index) => {
    const active = thread.id === state.activeThreadId
      && findTmuxThreadTarget([thread], state.thread) === thread;
    const details = providerDetails(thread.provider);
    const button = element('button', `thread-row${active ? ' active' : ''}`);
    button.type = 'button';
    button.disabled = state.sessionClosePending;
    button.dataset.threadId = thread.id;
    const copy = element('span', 'thread-copy');
    const tmux = thread.tmux || {};
    const title = tmux.name || thread.name || thread.preview || '未命名会话';
    const status = tmux.status === 'working' || tmux.status === 'background'
      ? tmux.status
      : 'done';
    const statusText = status === 'working'
      ? '正在干活'
      : status === 'background' ? '后台运行' : '已就绪';
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
      openListedThread(thread).catch((error) => setLiveMessage(error.message));
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

function skillCard({ name, description }) {
  const row = element('div', 'skill-row');
  row.append(
    element('code', 'skill-name', name),
    element('span', 'skill-description', description || ''),
  );
  return row;
}

function commandPendingMessage(text) {
  const command = text.match(/^\/\S+/)?.[0];
  if (command === '/model') {
    const label = text.slice(command.length).trim();
    return label ? `正在切换到 ${label}…` : '正在切换模型…';
  }
  if (command === '/status') return '正在读取状态…';
  return '正在发送…';
}

function modelRowButton({ label, description }, selected) {
  const button = element('button', `model-row${label === selected ? ' primary' : ''}`);
  button.type = 'button';
  button.append(
    element('code', 'model-name', label),
    element('span', 'model-description', description || '点击直接切换模型'),
  );
  button.addEventListener('click', () => {
    const input = $('#composerInput');
    const form = $('#composerForm');
    if (!input || input.disabled || !form || composerRequestGate.pending || state.threadOpening) return;
    dismissCommandDialog({ restoreFocus: false });
    input.value = `/model ${label}`;
    state.slashCommandIndex = 0;
    state.slashCommandDismissedValue = input.value;
    resizeComposer();
    renderComposerState();
    setLiveMessage(commandPendingMessage(input.value));
    form.requestSubmit();
  });
  return button;
}

function modelCommandDialog(commandOutput) {
  const parsed = parseModelCommandOutput(commandOutput.text);
  const panel = element('div', 'model-panel');
  if (parsed.items.length) {
    const list = element('div', 'model-list');
    parsed.items.forEach((item) => list.append(modelRowButton(item, parsed.selected)));
    panel.append(list);
  }
  if (parsed.notes.length) {
    const details = element('details', 'model-raw');
    details.append(
      element('summary', '', '原始输出'),
      element('pre', 'model-raw-body', parsed.notes.join('\n')),
    );
    panel.append(details);
  }
  if (!parsed.items.length && !parsed.notes.length) {
    panel.append(element('pre', 'terminal-live-output', commandOutput.text));
  }
  return {
    kicker: 'MODEL',
    title: '选择模型',
    summary: [parsed.selected && `当前 ${parsed.selected}`, parsed.count]
      .filter(Boolean).join(' · ') || parsed.heading || '选择后立即应用到当前会话',
    content: panel,
    focusSelector: '.model-row.primary, .model-row',
  };
}

function skillsCommandDialog(commandOutput) {
  const parsed = parseSkillsCommandOutput(commandOutput.text);
  const panel = element('div', 'skills-panel');
  if (parsed.items.length) {
    const list = element('div', 'skills-list');
    parsed.items.forEach((item) => list.append(skillCard(item)));
    panel.append(list);
  }
  if (parsed.notes.length) {
    const details = element('details', 'skills-raw');
    details.append(
      element('summary', '', '原始输出'),
      element('pre', 'skills-raw-body', parsed.notes.join('\n')),
    );
    panel.append(details);
  }
  if (!parsed.items.length && !parsed.notes.length) {
    panel.append(element('pre', 'terminal-live-output', commandOutput.text));
  }
  return {
    kicker: 'SKILLS',
    title: parsed.heading || 'Skills',
    summary: parsed.count || `${parsed.items.length || parsed.notes.length || 0} 项`,
    content: panel,
  };
}

function commandDialogPresentation(commandOutput) {
  if (commandOutput.command === '/model') return modelCommandDialog(commandOutput);
  if (commandOutput.command === '/skills') return skillsCommandDialog(commandOutput);
  const output = element('pre', 'terminal-live-output command-output-body', commandOutput.text);
  output.tabIndex = 0;
  return {
    kicker: 'COMMAND',
    title: commandOutput.command || '命令结果',
    summary: '命令输出',
    content: output,
    focusSelector: '.command-output-body',
  };
}

function openCommandDialog(commandOutput) {
  const dialog = $('#commandDialog');
  const commandKey = `${state.provider}:${state.thread?.id || ''}:${commandOutput.command}:${commandOutput.text}`;
  if (dialog.open && dialog.dataset.commandKey === commandKey) return;
  const presentation = commandDialogPresentation(commandOutput);
  $('#commandDialogKicker').textContent = presentation.kicker;
  $('#commandDialogTitle').textContent = presentation.title;
  $('#commandDialogSummary').textContent = presentation.summary;
  $('#commandDialogContent').replaceChildren(presentation.content);
  dialog.dataset.commandKey = commandKey;
  if (!dialog.open) {
    $('#composerInput').blur();
    dialog.showModal();
  }
  requestAnimationFrame(() => {
    const target = (presentation.focusSelector && dialog.querySelector(presentation.focusSelector))
      || $('#commandDialogClose');
    target.focus({ preventScroll: true });
  });
}

function dismissCommandDialog({ restoreFocus = true } = {}) {
  const dialog = $('#commandDialog');
  const commandOutput = state.thread?.tmux?.commandOutput;
  if (commandOutput?.command?.startsWith('/')) {
    delete state.thread.tmux.commandOutput;
  }
  if (dialog.open) dialog.close();
  dialog.dataset.commandKey = '';
  $('#commandDialogContent').replaceChildren();
  scheduleThreadRender(false);
  if (restoreFocus) requestAnimationFrame(() => $('#composerInput').focus({ preventScroll: true }));
}

function syncCommandDialog(commandOutput) {
  const dialog = $('#commandDialog');
  if (commandOutput) {
    openCommandDialog(commandOutput);
    return;
  }
  if (dialog.open) dialog.close();
  dialog.dataset.commandKey = '';
  $('#commandDialogContent').replaceChildren();
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
  const content = terminalActivityContent();
  const section = element('section', 'turn terminal-activity');
  section.dataset.activityStatus = content.status;
  section.dataset.activityKind = 'text';
  const foot = element('div', 'turn-foot');
  foot.setAttribute('role', 'status');
  foot.setAttribute('aria-live', 'polite');
  if (content.working) foot.append(element('span', 'spinner'));
  foot.append(element('span', 'working', content.label));
  const output = element('pre', 'terminal-live-output', content.output);
  output.hidden = !content.output;
  output.tabIndex = 0;
  output.setAttribute('aria-label', content.ariaLabel);
  section.append(foot, output);
  requestAnimationFrame(() => {
    if (output.isConnected) output.scrollTop = output.scrollHeight;
  });
  return section;
}

function terminalActivityContent() {
  const commandOutput = state.thread?.tmux?.commandOutput;
  if (commandOutput?.command?.startsWith('/') && commandOutput.text) return {
    kind: 'command',
    commandOutput,
    status: 'command',
    working: false,
    label: `${commandOutput.command} 输出`,
    output: commandOutput.text,
    ariaLabel: `${commandOutput.command} 命令输出`,
  };
  if (commandOutput?.text) return {
    kind: 'text',
    status: 'command',
    working: false,
    label: `${commandOutput.command} 输出`,
    output: commandOutput.text,
    ariaLabel: `${commandOutput.command} 终端输出`,
  };
  const shell = state.thread?.provider === 'shell';
  const working = state.thread?.tmux?.status === 'working';
  return {
    status: working ? 'working' : 'done',
    working,
    label: shell
      ? working ? 'Shell 命令正在运行' : 'Shell 当前输出'
      : !working ? '终端当前输出'
        : agentActivityText(state.thread) || '终端 Agent 正在工作',
    output: state.thread?.tmux?.liveOutput || '',
    ariaLabel: 'tmux 当前实时输出',
  };
}

function updateTerminalActivity() {
  const section = $('.terminal-activity');
  const current = $('.terminal-activity .working');
  const output = $('.terminal-activity .terminal-live-output');
  const content = terminalActivityContent();
  const visible = shouldShowTerminalActivity(state.thread);
  if (!visible) {
    syncCommandDialog(null);
    if (current) scheduleThreadRender(false);
    return;
  }
  if (content.kind === 'command') {
    syncCommandDialog(content.commandOutput);
    return;
  }
  syncCommandDialog(null);
  if (!current || !output) {
    scheduleThreadRender(false);
    return;
  }
  if (section?.dataset.activityKind !== content.kind || section?.dataset.activityStatus !== content.status) {
    scheduleThreadRender(false);
    return;
  }
  const transcript = $('#transcript');
  const nearBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 100;
  const outputNearBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 40;
  const changed = current.textContent !== content.label
    || output.textContent !== content.output
    || output.hidden !== !content.output;
  if (current.textContent !== content.label) current.textContent = content.label;
  if (output.textContent !== content.output) output.textContent = content.output;
  output.hidden = !content.output;
  output.setAttribute('aria-label', content.ariaLabel);
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
  const terminalContent = terminalActivityContent();
  if (shouldShowTerminalActivity(state.thread) && terminalContent.kind !== 'command') {
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
  syncCommandDialog(terminalContent.kind === 'command' ? terminalContent.commandOutput : null);
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
  const background = state.thread?.tmux?.status === 'background';
  const readOnly = Boolean(state.thread?.readOnly && !sessionName);
  const hasText = Boolean(input.value.trim());
  const hasContent = hasText || Boolean(state.attachments.length && state.provider !== 'shell');
  const shellAttachmentOnly = state.provider === 'shell' && state.attachments.length && !hasText;
  const pending = composerRequestGate.pending;
  const opening = Boolean(state.threadOpening);
  const closing = state.sessionClosePending;
  const controls = composerControlState({
    active, connected: state.connected, hasText: hasContent, opening: opening || closing, pending, readOnly,
  });
  sendButton.classList.toggle('stop-mode', controls.stopMode && !shellAttachmentOnly);
  input.disabled = readOnly || opening || closing;
  $('.composer').classList.toggle('read-only', readOnly);
  $('.composer').setAttribute('aria-busy', String(pending || opening || closing));
  sendButton.disabled = controls.disabled || Boolean(shellAttachmentOnly);
  sendButton.setAttribute('aria-label', shellAttachmentOnly ? '请先输入 Shell 命令' : controls.ariaLabel);
  $('#composerPlus').disabled = readOnly || opening || closing || pending || !state.connected;
  const voiceButton = $('#voiceInputButton');
  voiceButton.disabled = !speechInput.supported || readOnly || opening || closing || pending || !state.connected;
  if (voiceButton.disabled && speechInput.active) speechInput.abort();
  for (const remove of document.querySelectorAll('.attachment-remove')) remove.disabled = opening || pending;
  const status = $('#composerStatus');
  status.replaceChildren();
  const dot = element('i', `connection-dot ${state.connected ? active || background ? 'busy' : 'online' : 'problem'}`);
  const message = closing
    ? '正在关闭会话…'
    : opening
    ? '正在读取会话…'
    : !state.connected
      ? '连接已断开'
      : sessionName
        ? state.thread?.provider === 'shell'
          ? active ? 'Shell 命令正在运行 · 可直接输入' : '已连接 Shell 会话 · 可直接输入'
          : active ? `${activity || '终端 Agent 正在工作'} · 可直接输入`
            : background ? 'Agent 后台任务运行中 · 可直接输入' : '已连接当前终端会话 · 可直接输入'
        : readOnly ? '当前会话只读' : active ? `${activity || '正在处理'} · 可继续输入` : '已连接';
  status.append(dot, document.createTextNode(message));
  input.placeholder = closing
    ? '正在关闭会话…'
    : opening
    ? '正在读取会话…'
    : readOnly
      ? '当前会话只读'
      : state.thread?.provider === 'shell' ? '输入 Shell 命令'
        : active ? '跟进当前任务' : sessionName ? `参与 ${providerDetails().name} 会话` : `给 ${providerDetails().name} 发消息`;
  renderSlashCommandMenu();
}

function currentSlashCommandSuggestions() {
  const input = $('#composerInput');
  if (
    !input
    || input.disabled
    || !state.connected
    || state.threadOpening
    || composerRequestGate.pending
    || state.attachments.length
    || state.slashCommandDismissedValue === input.value
    || !slashCommandMenuAvailable({
      provider: state.provider,
      tmuxSession: state.thread?.tmux?.name,
    })
  ) return [];
  return slashCommandSuggestions(state.provider, input.value);
}

function applySlashCommandCompletion(command) {
  const input = $('#composerInput');
  const completed = completeSlashCommand(input.value, command);
  if (completed === input.value && completed !== command) return;
  input.value = completed;
  input.setSelectionRange(completed.length, completed.length);
  state.slashCommandIndex = 0;
  state.slashCommandDismissedValue = completed;
  resizeComposer();
  input.focus({ preventScroll: true });
}

function renderSlashCommandMenu() {
  const input = $('#composerInput');
  const menu = $('#slashCommandMenu');
  if (!input || !menu) return;
  const suggestions = currentSlashCommandSuggestions();
  if (!suggestions.length) {
    menu.hidden = true;
    menu.replaceChildren();
    menu.dataset.renderKey = '';
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    return;
  }
  state.slashCommandIndex = Math.min(Math.max(0, state.slashCommandIndex), suggestions.length - 1);
  const renderKey = `${state.provider}:${input.value}:${state.slashCommandIndex}`;
  input.setAttribute('aria-expanded', 'true');
  input.setAttribute('aria-activedescendant', `slash-command-option-${state.slashCommandIndex}`);
  if (!menu.hidden && menu.dataset.renderKey === renderKey) return;
  const options = suggestions.map((suggestion, index) => {
    const option = element('button', `slash-command-option${index === state.slashCommandIndex ? ' active' : ''}`);
    option.type = 'button';
    option.tabIndex = -1;
    option.id = `slash-command-option-${index}`;
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', String(index === state.slashCommandIndex));
    option.append(
      element('code', '', suggestion.command),
      element('span', '', suggestion.description),
    );
    option.addEventListener('pointerdown', (event) => {
      event.preventDefault();
    });
    option.addEventListener('click', (event) => {
      event.preventDefault();
      applySlashCommandCompletion(suggestion.command);
    });
    return option;
  });
  menu.replaceChildren(...options);
  menu.dataset.renderKey = renderKey;
  menu.hidden = false;
}

function resizeComposer() {
  const input = $('#composerInput');
  input.style.height = 'auto';
  input.style.height = `${Math.min(144, input.scrollHeight)}px`;
  renderComposerState();
}

async function submitComposer() {
  if (composerRequestGate.pending || state.threadOpening) return;
  abortSpeechInput();
  const input = $('#composerInput');
  const draft = input.value;
  const text = draft.trim();
  const running = latestRunningTurn(state.thread);
  const sessionName = state.thread?.tmux?.name;
  const active = Boolean(running || state.thread?.tmux?.status === 'working');
  const attachments = [...state.attachments];
  const submitAction = composerSubmitAction({
    active, attachmentCount: attachments.length, provider: state.provider, text,
  });
  if (state.thread?.readOnly && !sessionName) {
    setLiveMessage('当前会话只读。');
    return;
  }
  if (submitAction === 'needsShellCommand') {
    setLiveMessage('请先输入 Shell 命令，附件路径会安全追加到命令末尾。');
    return;
  }
  if (submitAction === 'interrupt') {
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
  if (submitAction === 'none') return;
  if (!state.thread) {
    setLiveMessage('请先为新的 tmux 会话命名。');
    openNewSession();
    return;
  }
  await composerRequestGate.run(async () => {
    setLiveMessage(attachments.length ? `正在上传 ${attachments.length} 个附件…` : commandPendingMessage(text));
    let sentPendingSession = false;
    try {
      const targetProvider = state.provider;
      const targetThreadId = state.thread?.id || null;
      const targetSessionName = sessionName || null;
      const paths = await uploadAttachments(attachments);
      if (
        state.provider !== targetProvider
        || (state.thread?.id || null) !== targetThreadId
        || (state.thread?.tmux?.name || null) !== targetSessionName
      ) throw new Error('会话已切换，附件未发送');
      const message = attachmentMessage({ provider: targetProvider, text, paths });
      if (!message) throw new Error('请输入要发送的内容');
      if (attachments.length) setLiveMessage('附件已上传，正在发送…');
      if (sessionName) {
        const previousStatus = state.thread.tmux.status;
        sentPendingSession = state.thread.tmux.available === false;
        const result = await agentRequest('sendSessionMessage', {
          provider: targetProvider,
          threadId: targetThreadId,
          tmuxSession: sessionName,
          text: message,
        });
        const nextStatus = sessionStatusAfterSend({ previousStatus, result });
        const workingAfterSend = nextStatus === 'working';
        const stillActive = state.provider === targetProvider
          && state.thread?.id === targetThreadId
          && state.thread?.tmux?.name === sessionName;
        if (stillActive) {
          delete state.thread.tmux.commandOutput;
          if (result?.terminalOutput && !workingAfterSend) {
            state.thread.tmux.commandOutput = {
              command: message.match(/^\/\S*/)?.[0] || '终端命令',
              text: result.terminalOutput,
            };
          }
          state.thread.tmux.status = nextStatus;
          state.thread.tmux.activityAt = Date.now();
        }
        const listedThread = findTmuxThreadTarget(state.threads, {
          id: targetThreadId,
          provider: targetProvider,
          ...(targetSessionName ? { tmux: { name: targetSessionName } } : {}),
        });
        if (listedThread?.tmux) {
          listedThread.tmux.status = nextStatus;
          listedThread.tmux.activityAt = Date.now();
        }
        if (stillActive) state.threadRefreshUntil = workingAfterSend && !sentPendingSession
          ? Date.now() + 10_000
          : 0;
        renderThreadList();
        renderComposerState();
        if (stillActive) {
          scheduleThreadRender(true);
          if (sentPendingSession || targetProvider === 'shell') loadThreads({ quiet: true }).catch(() => {});
          else if (workingAfterSend) refreshActiveThread({ force: true }).catch(() => {});
        }
      } else {
        await agentRequest('sendMessage', {
          provider: targetProvider,
          threadId: state.thread.id,
          turnId: running?.id,
          mode: running ? 'steer' : 'followUp',
          text: message,
        });
        scheduleThreadRender(true);
      }
      input.value = draftAfterSuccessfulSend(input.value, draft);
      clearAttachments(attachments);
      resizeComposer();
      setLiveMessage(sentPendingSession ? '消息已发送，正在同步对话…' : '');
    } catch (error) {
      setLiveMessage(error.message);
    }
  });
}

function toggleSpeechInput() {
  if (speechInput.active) {
    speechInput.stop();
    setSpeechInputState(true, '正在完成语音识别…');
    return;
  }
  const input = $('#composerInput');
  if (!speechInput.supported || input.disabled || $('#voiceInputButton').disabled) return;
  speechBaseDraft = input.value;
  speechHadResult = false;
  if (speechInput.start()) setSpeechInputState(true, '正在请求麦克风权限…');
}

function abortSpeechInput() {
  if (!speechInput.abort()) return;
  setSpeechInputState(false, '');
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

function openAttachmentDialog() {
  const button = $('#composerPlus');
  if (button.disabled) return;
  $('#attachmentDialog').showModal();
}

function chooseAttachments(input) {
  $('#attachmentDialog').close();
  input.click();
}

function handleAttachmentInput(input) {
  addAttachmentFiles(input.files);
  input.value = '';
}

function hasDraggedFiles(event) {
  return [...(event.dataTransfer?.types || [])].includes('Files');
}

function handleAttachmentPaste(event) {
  const files = [...(event.clipboardData?.items || [])]
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter(Boolean);
  if (!files.length) return;
  event.preventDefault();
  addAttachmentFiles(files);
}

function openNewSession() {
  if (state.sessionCreationPending || state.sessionClosePending) return;
  const provider = preferredNewSessionProvider();
  $('#sessionProvider').value = provider;
  $('#sessionCwdInput').value = state.thread?.cwd || state.cwd || state.defaultCwd;
  $('#sessionError').textContent = '';
  updateSuggestedSessionName(provider, { force: true });
  $('#newSessionDialog').showModal();
}

function openSettings() {
  $('#settingsTheme').value = state.theme;
  $('#settingsProvider').value = preferredNewSessionProvider();
  $('#cwdInput').value = state.cwd || state.defaultCwd;
  $('#settingsError').textContent = '';
  const sessionName = state.thread?.tmux?.name || '';
  const closeButton = $('#closeSessionButton');
  closeButton.hidden = !sessionName;
  closeButton.disabled = !sessionName || state.sessionClosePending || Boolean(state.threadOpening);
  closeButton.title = sessionName ? `关闭 tmux 会话“${sessionName}”` : '';
  closeButton.setAttribute('aria-label', closeButton.title || '关闭当前会话');
  $('#settingsDialog').showModal();
}

function dismissCloseSessionDialog() {
  if (state.sessionClosePending) return;
  const dialog = $('#closeSessionDialog');
  if (dialog.open) dialog.close();
  state.sessionCloseTarget = null;
  $('#closeSessionError').textContent = '';
}

function openCloseSessionDialog() {
  const sessionName = state.thread?.tmux?.name;
  if (!sessionName || state.sessionClosePending || state.threadOpening) return;
  state.sessionCloseTarget = sessionName;
  $('#settingsDialog').open && $('#settingsDialog').close();
  $('#closeSessionName').textContent = sessionName;
  $('#closeSessionError').textContent = '';
  $('#closeSessionDialog').showModal();
  requestAnimationFrame(() => $('#cancelCloseSessionButton').focus({ preventScroll: true }));
}

async function closeCurrentSession() {
  const sessionName = state.sessionCloseTarget;
  if (!sessionName || state.sessionClosePending) return;
  const nextThread = nextThreadAfterClose(state.threads, sessionName);
  const controls = [...$('#closeSessionForm').querySelectorAll('button')];
  const confirmButton = $('#confirmCloseSessionButton');
  state.sessionClosePending = true;
  for (const control of controls) control.disabled = true;
  confirmButton.textContent = '正在关闭…';
  $('#closeSessionError').textContent = '';
  renderComposerState();

  try {
    await requestSessionClose(sessionName);
  } catch (error) {
    state.sessionClosePending = false;
    for (const control of controls) control.disabled = false;
    confirmButton.textContent = '关闭会话';
    $('#closeSessionError').textContent = error.message;
    renderComposerState();
    return;
  }

  $('#closeSessionDialog').close();
  state.sessionCloseTarget = null;
  state.threadListGeneration += 1;
  const staleThreadLoad = state.threadLoad;
  state.sessionSnapshot = null;
  state.threads = state.threads.filter((thread) => thread.tmux?.name !== sessionName);
  startNewThread({ focus: false });
  abortSpeechInput();
  const input = $('#composerInput');
  input.value = '';
  clearAttachments([...state.attachments]);
  state.slashCommandIndex = 0;
  state.slashCommandDismissedValue = null;
  syncCommandDialog(null);
  resizeComposer();
  renderThreadList();
  scheduleThreadRender(false);

  if (staleThreadLoad) await staleThreadLoad.catch(() => {});
  let refreshError = '';
  try {
    await loadThreads({ quiet: true });
  } catch (error) {
    refreshError = error.message;
  }
  const nextSessionName = nextThread?.tmux?.name;
  const replacement = state.threads.find((thread) => thread.tmux?.name === nextSessionName)
    || state.threads[0]
    || null;
  let openError = '';
  if (replacement) {
    try {
      await openListedThread(replacement, { quiet: true });
    } catch (error) {
      openError = error.message;
    }
  }

  state.sessionClosePending = false;
  for (const control of controls) control.disabled = false;
  confirmButton.textContent = '关闭会话';
  renderThreadList();
  renderComposerState();
  const switchedTo = replacement && !openError ? `，已切换到“${replacement.tmux?.name || replacement.preview}”` : '';
  const warning = openError || refreshError;
  setLiveMessage(`已关闭会话“${sessionName}”${switchedTo}${warning ? `；${warning}` : '。'}`);
}

function updateSuggestedSessionName(provider, { force = false } = {}) {
  const input = $('#sessionNameInput');
  if (!force && input.value.trim() && input.value.trim() !== input.dataset.suggested) return;
  const suggestion = suggestedRemoteSessionName(
    provider,
    state.threads.map((thread) => thread.tmux?.name).filter(Boolean),
  );
  input.value = suggestion;
  input.dataset.suggested = suggestion;
}

async function waitForCreatedSession(name, provider, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  let threads = [];
  while (true) {
    const snapshot = await validateOwnerToken(state.token);
    threads = tmuxSessionsToThreads(snapshot.sessions)
      .filter((thread) => thread.provider === 'shell' || state.providers.includes(thread.provider));
    const created = findCreatedRemoteSession(threads, name, provider);
    if (created) {
      state.threads = threads;
      renderThreadList();
      return created;
    }
    if (Date.now() >= deadline) {
      state.threads = threads;
      renderThreadList();
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
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
$('#drawerNewButton').addEventListener('click', openNewSession);
$('#sessionVisibilityButton').addEventListener('click', openSessionVisibilityDialog);
$('#hiddenSessionPrefixesInput').addEventListener('input', () => updateSessionVisibilitySummary());
$('#sessionVisibilityForm').addEventListener('submit', (event) => {
  if (event.submitter?.value === 'cancel') return;
  event.preventDefault();
  applySessionVisibility(parseSessionPrefixInput($('#hiddenSessionPrefixesInput').value));
  $('#sessionVisibilityDialog').close();
});
$('#showAllSessionsButton').addEventListener('click', () => {
  $('#hiddenSessionPrefixesInput').value = '';
  applySessionVisibility([]);
  $('#sessionVisibilityDialog').close();
});
$('#newThreadButton').addEventListener('click', openNewSession);
$('#providerButton').addEventListener('click', openProviderDialog);
$('#settingsButton').addEventListener('click', openSettings);
$('#closeSessionButton').addEventListener('click', openCloseSessionDialog);
$('#composerPlus').addEventListener('click', openAttachmentDialog);
$('#voiceInputButton').addEventListener('pointerdown', (event) => {
  event.preventDefault();
});
$('#voiceInputButton').addEventListener('click', toggleSpeechInput);
$('#cwdButton').addEventListener('click', openSettings);
$('#chooseImagesButton').addEventListener('click', () => chooseAttachments($('#attachmentImageInput')));
$('#chooseFilesButton').addEventListener('click', () => chooseAttachments($('#attachmentFileInput')));
$('#attachmentImageInput').addEventListener('change', () => handleAttachmentInput($('#attachmentImageInput')));
$('#attachmentFileInput').addEventListener('change', () => handleAttachmentInput($('#attachmentFileInput')));
$('#commandDialogClose').addEventListener('click', () => dismissCommandDialog());
$('#commandDialog').addEventListener('cancel', (event) => {
  event.preventDefault();
  dismissCommandDialog();
});
$('#commandDialog').addEventListener('click', (event) => {
  if (event.target === event.currentTarget) dismissCommandDialog();
});
$('#closeSessionDialogClose').addEventListener('click', dismissCloseSessionDialog);
$('#cancelCloseSessionButton').addEventListener('click', dismissCloseSessionDialog);
$('#closeSessionDialog').addEventListener('cancel', (event) => {
  if (state.sessionClosePending) {
    event.preventDefault();
    return;
  }
  state.sessionCloseTarget = null;
  $('#closeSessionError').textContent = '';
});
$('#closeSessionForm').addEventListener('submit', (event) => {
  event.preventDefault();
  closeCurrentSession();
});
$('#newSessionDialog').addEventListener('cancel', (event) => {
  if (state.sessionCreationPending) event.preventDefault();
});
$('#settingsTheme').addEventListener('change', (event) => applyTheme(event.target.value, { persist: true }));
$('#sessionProvider').addEventListener('change', (event) => updateSuggestedSessionName(event.target.value));
$('#composerInput').addEventListener('paste', handleAttachmentPaste);
$('#composerInput').addEventListener('input', () => {
  state.slashCommandIndex = 0;
  state.slashCommandDismissedValue = null;
  resizeComposer();
});
$('#composerInput').addEventListener('blur', () => {
  if ($('#slashCommandMenu').hidden) return;
  state.slashCommandDismissedValue = $('#composerInput').value;
  renderSlashCommandMenu();
});
$('#composerInput').addEventListener('keydown', (event) => {
  const slashCommandKey = event.key === 'ArrowDown'
    || event.key === 'ArrowUp'
    || event.key === 'Tab'
    || event.key === 'Escape'
    || event.key === 'Enter';
  if (slashCommandKey && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey && !event.isComposing) {
    const action = slashCommandKeyAction({
      key: event.key,
      value: $('#composerInput').value,
      suggestions: currentSlashCommandSuggestions(),
      activeIndex: state.slashCommandIndex,
    });
    if (action) {
      event.preventDefault();
      event.stopPropagation();
      if (action.type === 'select') {
        state.slashCommandIndex = action.index;
        renderSlashCommandMenu();
      } else if (action.type === 'complete') {
        applySlashCommandCompletion(action.command);
      } else {
        state.slashCommandDismissedValue = $('#composerInput').value;
        renderSlashCommandMenu();
      }
      return;
    }
  }
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $('#composerForm').requestSubmit();
  }
});
$('#composerForm').addEventListener('submit', (event) => {
  event.preventDefault();
  submitComposer();
});
$('.composer-area').addEventListener('dragenter', (event) => {
  if (!hasDraggedFiles(event)) return;
  event.preventDefault();
  state.attachmentDragDepth += 1;
  $('.composer-area').classList.add('drag-over');
});
$('.composer-area').addEventListener('dragover', (event) => {
  if (!hasDraggedFiles(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
});
$('.composer-area').addEventListener('dragleave', (event) => {
  if (!hasDraggedFiles(event)) return;
  state.attachmentDragDepth = Math.max(0, state.attachmentDragDepth - 1);
  if (!state.attachmentDragDepth) $('.composer-area').classList.remove('drag-over');
});
$('.composer-area').addEventListener('drop', (event) => {
  if (!hasDraggedFiles(event)) return;
  event.preventDefault();
  state.attachmentDragDepth = 0;
  $('.composer-area').classList.remove('drag-over');
  addAttachmentFiles(event.dataTransfer.files);
});
$('#newSessionForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (state.sessionCreationPending) return;
  if (event.submitter?.value === 'cancel') {
    $('#newSessionDialog').close();
    return;
  }
  const button = $('#createSessionButton');
  $('#sessionError').textContent = '';
  let payload;
  try {
    payload = createRemoteSessionPayload({
      name: $('#sessionNameInput').value,
      provider: $('#sessionProvider').value,
      cwd: $('#sessionCwdInput').value,
    });
  } catch (error) {
    $('#sessionError').textContent = error.message;
    return;
  }
  const controls = [...$('#newSessionForm').querySelectorAll('button, input, select')];
  state.sessionCreationPending = true;
  for (const control of controls) control.disabled = true;
  button.disabled = true;
  button.textContent = '正在创建…';
  let created = false;
  try {
    await requestSessionCreation(payload);
    created = true;
    state.sessionSnapshot = null;
    state.provider = payload.client;
    state.cwd = payload.cwd || state.defaultCwd;
    localStorage.setItem('codeck-remote-provider', state.provider);
    localStorage.setItem('codeck-remote-cwd', state.cwd);
    renderProviderControls();
    startNewThread({ focus: false });
    setLiveMessage(`正在启动 tmux 会话“${payload.name}”…`);
    const thread = await waitForCreatedSession(payload.name, payload.client);
    $('#newSessionDialog').close();
    if (!thread) {
      setLiveMessage(`tmux 会话“${payload.name}”已创建，Agent 仍在启动，请稍后从左栏进入。`);
      return;
    }
    if (thread.tmux.available === false) openPendingThread(thread, { refresh: false });
    else await openThread(thread.id, {
      provider: thread.provider,
      readOnly: true,
      tmuxSession: thread.tmux?.name,
    });
    setTimeout(() => $('#composerInput').focus(), 50);
  } catch (error) {
    if (created) {
      $('#newSessionDialog').open && $('#newSessionDialog').close();
      setLiveMessage(error.message);
    } else {
      $('#sessionError').textContent = error.message;
    }
  } finally {
    state.sessionCreationPending = false;
    for (const control of controls) control.disabled = false;
    button.disabled = false;
    button.textContent = '创建会话';
  }
});
$('#settingsForm').addEventListener('submit', (event) => {
  event.preventDefault();
  if (event.submitter?.value === 'cancel') {
    $('#settingsDialog').close();
    return;
  }
  const cwd = $('#cwdInput').value.trim() || state.defaultCwd;
  if (!cwd.startsWith('/')) {
    $('#settingsError').textContent = '请输入服务器上的绝对路径';
    return;
  }
  const provider = $('#settingsProvider').value;
  state.cwd = cwd;
  localStorage.setItem('codeck-remote-provider', provider);
  localStorage.setItem('codeck-remote-cwd', cwd);
  if (!state.thread) {
    state.provider = provider;
    renderProviderControls();
    scheduleThreadRender(false);
  }
  $('#settingsDialog').close();
  setLiveMessage('设置已保存。');
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
  if (document.visibilityState !== 'visible') {
    abortSpeechInput();
    return;
  }
  if (state.token && !state.socket) connectSocket();
  else if (state.connected) {
    loadThreads({ quiet: true }).catch(() => {});
    refreshActiveThread({ force: true }).catch(() => {});
  }
});
window.visualViewport?.addEventListener('resize', syncViewportHeight);
window.visualViewport?.addEventListener('scroll', syncViewportHeight);
window.addEventListener('resize', syncViewportHeight);
window.addEventListener('storage', (event) => {
  if (event.key !== null && event.key !== SESSION_VISIBILITY_STORAGE_KEY) return;
  state.hiddenSessionPrefixes = loadHiddenSessionPrefixes(localStorage);
  renderThreadList();
  if ($('#sessionVisibilityDialog').open) {
    $('#hiddenSessionPrefixesInput').value = state.hiddenSessionPrefixes.join('\n');
    updateSessionVisibilitySummary(state.hiddenSessionPrefixes);
  }
});
window.addEventListener('pagehide', () => {
  abortSpeechInput();
  for (const attachment of state.attachments) {
    if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
  }
});
setInterval(() => {
  if (state.connected && document.visibilityState === 'visible') loadThreads({ quiet: true }).catch(() => {});
}, SESSION_LIST_POLL_MS);
setInterval(() => {
  refreshActiveThread().catch(() => {});
}, THREAD_REFRESH_POLL_MS);

applyTheme(state.theme);
syncViewportHeight();
renderProviderControls();
syncSessionVisibilityButton();
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
