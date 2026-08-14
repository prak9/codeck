const { Terminal } = globalThis;
const { FitAddon } = globalThis.FitAddon;

const $ = (selector) => document.querySelector(selector);
const state = { token: sessionStorage.getItem('codeck-token') || '', sessions: [], active: null, socket: null, terminal: null };
const relativeTime = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' });

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

function timeAgo(timestamp) {
  const seconds = Math.round((timestamp - Date.now()) / 1000);
  if (Math.abs(seconds) < 60) return '刚刚';
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return relativeTime.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return relativeTime.format(hours, 'hour');
  return relativeTime.format(Math.round(hours / 24), 'day');
}

function renderSessions() {
  const list = $('#sessionList');
  if (!state.sessions.length) {
    list.innerHTML = '<div class="list-empty"><span>∅</span><p>还没有 tmux 会话</p></div>';
    return;
  }
  list.innerHTML = state.sessions.map((session) => `
    <button class="session-row ${session.name === state.active ? 'active' : ''}" data-session="${escapeHtml(session.name)}">
      <span class="session-icon">${session.attached ? '›_' : '$_'}</span>
      <span class="session-copy"><b>${escapeHtml(session.name)}</b><small>${session.windows} 个窗口 · ${timeAgo(session.activityAt)}</small></span>
      <span class="presence ${session.attached ? 'online' : ''}" title="${session.attached ? '已连接' : '空闲'}"></span>
    </button>`).join('');
}

function escapeHtml(value) {
  const node = document.createElement('span');
  node.textContent = value;
  return node.innerHTML;
}

async function refreshSessions() {
  const data = await api('/api/sessions');
  state.sessions = data.sessions;
  renderSessions();
}

function connect(session) {
  state.socket?.close();
  state.terminal?.dispose();
  state.active = session;
  renderSessions();
  $('#emptyState').hidden = true;
  $('#terminalView').hidden = false;
  $('#terminalTitle').textContent = session;
  $('#connectionState').textContent = '正在连接';

  const terminal = new Terminal({
    cursorBlink: true, cursorStyle: 'block', convertEol: true,
    fontFamily: '"Courier New", "Microsoft YaHei", "微软雅黑", monospace',
    fontSize: 14, lineHeight: 1.2, scrollback: 5000,
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
  fit.fit();
  state.terminal = terminal;

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${location.host}/ws?session=${encodeURIComponent(session)}`, `codeck.${state.token}`);
  state.socket = socket;
  socket.addEventListener('open', () => {
    $('#connectionState').textContent = '已连接';
    socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
    terminal.focus();
  });
  socket.addEventListener('message', (event) => terminal.write(event.data));
  socket.addEventListener('close', () => $('#connectionState').textContent = '连接已断开');
  socket.addEventListener('error', () => $('#connectionState').textContent = '连接失败');
  terminal.onData((data) => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ type: 'input', data })));
  terminal.onResize(({ cols, rows }) => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ type: 'resize', cols, rows })));
  const observer = new ResizeObserver(() => fit.fit());
  observer.observe($('#terminal').parentElement);
  socket.addEventListener('close', () => observer.disconnect());
  $('#sidebar').classList.remove('open');
  $('#menuButton').setAttribute('aria-expanded', 'false');
}

function openNewDialog() {
  $('#newError').textContent = '';
  $('#nameInput').value = `agent-${new Date().toISOString().slice(11, 16).replace(':', '')}`;
  $('#newDialog').showModal();
  $('#nameInput').select();
}

$('#sessionList').addEventListener('click', (event) => {
  const row = event.target.closest('[data-session]');
  if (row) connect(row.dataset.session);
});
['#newButton', '#newButtonBottom', '#emptyNewButton'].forEach((id) => $(id).addEventListener('click', openNewDialog));
$('#menuButton').addEventListener('click', () => {
  const open = $('#sidebar').classList.toggle('open');
  $('#menuButton').setAttribute('aria-expanded', String(open));
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
  state.token = $('#tokenInput').value;
  try {
    await refreshSessions();
    sessionStorage.setItem('codeck-token', state.token);
    $('#tokenDialog').close();
  } catch (error) { $('#tokenError').textContent = error.message === 'UNAUTHORIZED' ? '令牌不正确，请检查服务启动日志。' : error.message; }
});

document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    $('#sidebar').classList.add('open');
    $('#sessionList .session-row')?.focus();
  }
});

if (state.token) refreshSessions().catch(() => $('#tokenDialog').showModal());
else $('#tokenDialog').showModal();
setInterval(() => state.token && refreshSessions().catch(() => {}), 10000);
