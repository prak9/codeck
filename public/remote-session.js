const SESSION_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;
const CLIENTS = new Set(['shell', 'codex', 'claude', 'qodercli']);

export function createRemoteSessionPayload({ name, provider, cwd }) {
  const sessionName = typeof name === 'string' ? name.trim() : '';
  if (!SESSION_NAME.test(sessionName)) {
    throw new Error('会话名只能包含字母、数字、点、短横线或下划线，最长 64 个字符');
  }
  if (!CLIENTS.has(provider)) throw new Error('未知的 Agent 类型');
  const workingDirectory = typeof cwd === 'string' ? cwd.trim() : '';
  if (workingDirectory && !workingDirectory.startsWith('/')) {
    throw new Error('请输入服务器上的绝对路径');
  }
  return {
    name: sessionName,
    client: provider,
    ...(workingDirectory ? { cwd: workingDirectory } : {}),
  };
}

export function suggestedRemoteSessionName(provider, sessionNames = [], now = new Date()) {
  const prefix = provider === 'qodercli' ? 'qoder' : CLIENTS.has(provider) ? provider : 'agent';
  const stamp = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
  const base = `${prefix}-${stamp}`;
  const occupied = new Set(sessionNames.filter((name) => typeof name === 'string'));
  if (!occupied.has(base)) return base;
  let suffix = 2;
  while (occupied.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

export function findCreatedRemoteSession(threads, name, provider) {
  return (Array.isArray(threads) ? threads : []).find((thread) => (
    thread?.provider === provider && thread.tmux?.name === name
  )) || null;
}

export function nextThreadAfterClose(threads, sessionName) {
  const list = Array.isArray(threads) ? threads : [];
  const closedIndex = list.findIndex((thread) => thread?.tmux?.name === sessionName);
  if (closedIndex < 0) return null;
  return list[closedIndex + 1] || list[closedIndex - 1] || null;
}
