function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function copyItem(item) {
  if (!item || typeof item !== 'object') return { id: crypto.randomUUID(), type: 'unknown' };
  return {
    ...item,
    content: Array.isArray(item.content) ? item.content.map((part) => ({ ...part })) : item.content,
    changes: Array.isArray(item.changes) ? item.changes.map((change) => ({ ...change })) : item.changes,
    arguments: item.arguments && typeof item.arguments === 'object' ? { ...item.arguments } : item.arguments,
  };
}

function copyTurn(turn) {
  return {
    ...(turn || {}),
    id: turn?.id || crypto.randomUUID(),
    status: turn?.status || 'completed',
    items: asArray(turn?.items).map(copyItem),
  };
}

export function tmuxSessionsToThreads(sessions) {
  return asArray(sessions).flatMap((session) => {
    if (!session?.name) return [];
    const provider = session.agent?.kind || 'shell';
    const available = provider === 'shell' || Boolean(session.agent.id);
    const liveOutput = provider === 'shell' ? session.liveOutput : session.agent?.liveOutput;
    return [{
      id: session.agent?.id || `tmux:${provider}:${session.name}`,
      provider,
      readOnly: provider === 'codex',
      tmux: {
        name: session.name,
        title: session.agent?.name || session.name,
        activityAt: session.activityAt,
        status: session.status === 'working' ? 'working' : 'done',
        available,
        ...(session.agent?.activity ? { activity: session.agent.activity } : {}),
        ...(liveOutput ? { liveOutput } : {}),
      },
    }];
  });
}

export function findTmuxThreadReplacement(threads, currentThread) {
  const currentTmux = currentThread?.tmux;
  if (!currentTmux?.name) return null;
  const sameSession = asArray(threads).filter((thread) => thread.tmux?.name === currentTmux.name);
  if (currentThread.provider === 'shell') {
    return sameSession.find((thread) => thread.provider !== 'shell') || null;
  }
  const shell = sameSession.find((thread) => thread.provider === 'shell');
  if (shell) return shell;
  if (currentTmux.available !== false) return null;
  return sameSession.find((thread) => (
    thread.provider === currentThread.provider
    && thread.tmux.available === true
  )) || null;
}

export function normalizeAgentThread(provider, thread) {
  return {
    ...(thread || {}),
    id: thread?.id || '',
    provider,
    preview: thread?.name || thread?.preview || '新会话',
    turns: asArray(thread?.turns).map(copyTurn),
  };
}

export function normalizeInteractionQuestions(params) {
  return asArray(params?.questions).slice(0, 4).map((question, index) => ({
    id: typeof question?.id === 'string' && question.id ? question.id : `question-${index + 1}`,
    header: question?.header || `问题 ${index + 1}`,
    question: question?.question || '请补充信息',
    options: asArray(question?.options).slice(0, 8).map((option) => (
      typeof option === 'string'
        ? { label: option, description: '' }
        : { label: option?.label || '', description: option?.description || '' }
    )).filter((option) => option.label),
    multiSelect: Boolean(question?.multiSelect),
    isOther: Boolean(question?.isOther),
    isSecret: Boolean(question?.isSecret),
  }));
}

function ensureTurn(thread, turnId) {
  let turn = thread.turns.find((candidate) => candidate.id === turnId);
  if (!turn) {
    turn = { id: turnId || crypto.randomUUID(), status: 'inProgress', items: [] };
    thread.turns.push(turn);
  }
  return turn;
}

function mergeTurn(current, incoming) {
  if (!current) return copyTurn(incoming);
  const incomingItems = asArray(incoming?.items);
  return {
    ...current,
    ...(incoming || {}),
    items: incomingItems.length ? incomingItems.map(copyItem) : current.items,
  };
}

export function applyAgentEvent(currentThread, method, params = {}) {
  if (!currentThread || params.threadId !== currentThread.id) return currentThread;
  const thread = normalizeAgentThread(currentThread.provider, currentThread);
  if (method === 'turn/started' || method === 'turn/completed') {
    const incoming = params.turn || { id: params.turnId };
    const index = thread.turns.findIndex((turn) => turn.id === incoming.id);
    if (index < 0) thread.turns.push(copyTurn(incoming));
    else thread.turns[index] = mergeTurn(thread.turns[index], incoming);
    return thread;
  }
  if (method === 'item/started' || method === 'item/completed') {
    const turn = ensureTurn(thread, params.turnId);
    const item = copyItem(params.item);
    const index = turn.items.findIndex((candidate) => candidate.id === item.id);
    if (index < 0) turn.items.push(item);
    else turn.items[index] = { ...turn.items[index], ...item };
    return thread;
  }
  if (method === 'item/agentMessage/delta') {
    const turn = ensureTurn(thread, params.turnId);
    let item = turn.items.find((candidate) => candidate.id === params.itemId);
    if (!item) {
      item = { id: params.itemId, type: 'agentMessage', text: '' };
      turn.items.push(item);
    }
    item.text = `${item.text || ''}${params.delta || ''}`;
    return thread;
  }
  if (method === 'item/commandExecution/outputDelta' || method === 'item/fileChange/outputDelta') {
    const turn = ensureTurn(thread, params.turnId);
    let item = turn.items.find((candidate) => candidate.id === params.itemId);
    if (!item) {
      item = { id: params.itemId, type: 'commandExecution', command: '', status: 'inProgress' };
      turn.items.push(item);
    }
    item.aggregatedOutput = `${item.aggregatedOutput || ''}${params.delta || ''}`;
    return thread;
  }
  if (method === 'thread/status/changed') {
    thread.status = params.status;
    return thread;
  }
  if (method === 'error') {
    const turn = ensureTurn(thread, params.turnId || `error-${Date.now()}`);
    turn.status = 'failed';
    turn.error = params.message || 'Agent request failed';
    return thread;
  }
  return thread;
}

export function latestRunningTurn(thread) {
  return [...asArray(thread?.turns)].reverse().find((turn) => turn.status === 'inProgress') || null;
}

export function applyTmuxSnapshot(thread, tmux) {
  if (!thread || !tmux) return false;
  const completed = thread.tmux?.status === 'working' && tmux.status === 'done';
  thread.tmux = { ...tmux };
  return completed;
}

export function shouldRefreshTmuxThread(thread, {
  force = false, now = Date.now(), refreshUntil = 0,
} = {}) {
  const tmux = thread?.tmux;
  if (!thread?.id || !tmux?.name || tmux.available === false) return false;
  if (force) return true;
  const working = tmux.status === 'working';
  if (working && tmux.liveOutput) return false;
  return working || now < refreshUntil;
}

export function shouldShowTerminalActivity(thread) {
  const tmux = thread?.tmux;
  if (!tmux) return false;
  if (thread.provider === 'shell' || tmux.available === false) return true;
  if (latestRunningTurn(thread)) return false;
  return tmux.status === 'working';
}

export function agentActivityText(thread) {
  const turn = latestRunningTurn(thread);
  if (!turn) return thread?.tmux?.status === 'working'
    ? thread.tmux.activity || '终端 Agent 正在工作'
    : '';
  const items = asArray(turn.items);
  const item = [...items].reverse().find((candidate) => (
    candidate?.status === 'inProgress' || candidate?.status === 'running'
  )) || items.at(-1);
  if (!item) return '正在处理';
  if (item.type === 'reasoning') return '正在思考';
  if (item.type === 'commandExecution') return '正在运行命令';
  if (item.type === 'fileChange') return '正在修改文件';
  if (item.type === 'agentMessage') return '正在回复';
  if (/tool|mcp/i.test(item.type || '')) return '正在调用工具';
  return '正在处理';
}

export function threadTimestamp(thread) {
  const raw = thread?.updatedAt || thread?.createdAt || 0;
  return raw > 10_000_000_000 ? raw : raw * 1000;
}

export function userMessageText(item) {
  if (typeof item?.content === 'string') return item.content;
  return asArray(item?.content).filter((part) => part?.type === 'text' || typeof part?.text === 'string')
    .map((part) => part.text || '').join('\n');
}
