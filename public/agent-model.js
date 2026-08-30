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

function mergeTurnUserMessages(current, incoming) {
  const currentUsers = asArray(current?.items).filter((item) => item?.type === 'userMessage');
  if (!currentUsers.length) return incoming;
  const incomingItems = asArray(incoming?.items);
  const incomingUsers = incomingItems.filter((item) => item?.type === 'userMessage');
  const used = new Set();
  const users = currentUsers.map((currentItem) => {
    let index = incomingUsers.findIndex((item, candidateIndex) => (
      !used.has(candidateIndex) && currentItem.id && item.id === currentItem.id
    ));
    if (index < 0 && currentItem.delivery) {
      const text = userMessageText(currentItem);
      index = incomingUsers.findIndex((item, candidateIndex) => (
        !used.has(candidateIndex) && userMessageText(item) === text
      ));
    }
    if (index < 0) return currentItem;
    used.add(index);
    return incomingUsers[index];
  });
  incomingUsers.forEach((item, index) => {
    if (!used.has(index)) users.push(item);
  });
  return {
    ...incoming,
    items: [...users, ...incomingItems.filter((item) => item?.type !== 'userMessage')],
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
        status: session.status === 'working' || session.status === 'background'
          ? session.status
          : 'done',
        available,
        ...(session.agent?.activity ? { activity: session.agent.activity } : {}),
        ...(liveOutput ? { liveOutput } : {}),
      },
    }];
  });
}

export function findTmuxThreadTarget(threads, target) {
  if (!target?.id || !target?.provider) return null;
  const sessionName = target.tmux?.name;
  return asArray(threads).find((thread) => (
    thread.id === target.id
    && thread.provider === target.provider
    && (!sessionName || thread.tmux?.name === sessionName)
  )) || null;
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
  return sameSession.find((thread) => (
    thread.provider === currentThread.provider
    && thread.tmux.available === true
    && thread.id !== currentThread.id
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

function renderedThreadMetadata(thread) {
  return JSON.stringify([
    thread?.id,
    thread?.name,
    thread?.preview,
    thread?.cwd,
    thread?.readOnly,
    thread?.status,
  ]);
}

export function reconcileAgentThreadRefresh(current, refreshed) {
  if (!current) return refreshed;
  const currentTurns = asArray(current.turns);
  const currentById = new Map(currentTurns.map((turn) => [turn.id, turn]));
  const turns = asArray(refreshed.turns).map((turn) => {
    const existing = currentById.get(turn.id);
    if (!existing) return turn;
    const merged = mergeTurnUserMessages(existing, turn);
    return JSON.stringify(existing) === JSON.stringify(merged) ? existing : merged;
  });
  const sameTurns = turns.length === currentTurns.length
    && turns.every((turn, index) => turn === currentTurns[index]);
  if (sameTurns && renderedThreadMetadata(current) === renderedThreadMetadata(refreshed)) return current;
  return {
    ...refreshed,
    turns,
    ...(current?.tmux ? { tmux: { ...current.tmux } } : {}),
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

function mergeTurn(current, incoming) {
  if (!current) return copyTurn(incoming);
  const incomingItems = asArray(incoming?.items);
  return mergeTurnUserMessages(current, {
    ...current,
    ...(incoming || {}),
    items: incomingItems.length ? incomingItems.map(copyItem) : current.items,
  });
}

function updateTurn(thread, turnId, update) {
  const turns = asArray(thread.turns);
  const index = turns.findIndex((candidate) => candidate.id === turnId);
  const current = index < 0
    ? { id: turnId || crypto.randomUUID(), status: 'inProgress', items: [] }
    : turns[index];
  const next = update(current, index >= 0);
  if (next === current && index >= 0) return thread;
  const updated = [...turns];
  if (index < 0) updated.push(next);
  else updated[index] = next;
  return { ...thread, turns: updated };
}

export function applyAgentEvent(currentThread, method, params = {}) {
  if (!currentThread || params.threadId !== currentThread.id) return currentThread;
  if (method === 'turn/started' || method === 'turn/completed') {
    const incoming = params.turn || { id: params.turnId };
    const turnId = incoming.id || params.turnId;
    return updateTurn(currentThread, turnId, (turn, exists) => (
      exists ? mergeTurn(turn, incoming) : copyTurn({ ...incoming, id: turnId })
    ));
  }
  if (method === 'item/started' || method === 'item/completed') {
    const item = copyItem(params.item);
    return updateTurn(currentThread, params.turnId, (turn) => {
      const items = asArray(turn.items);
      let index = items.findIndex((candidate) => candidate.id === item.id);
      if (index < 0 && item.type === 'userMessage') {
        index = items.findIndex((candidate) => (
          candidate.type === 'userMessage'
          && candidate.delivery
          && userMessageText(candidate) === userMessageText(item)
        ));
      }
      const updated = [...items];
      if (index < 0) updated.push(item);
      else updated[index] = { ...items[index], ...item };
      return { ...turn, items: updated };
    });
  }
  if (method === 'item/agentMessage/delta') {
    return updateTurn(currentThread, params.turnId, (turn) => {
      const items = asArray(turn.items);
      const index = items.findIndex((candidate) => candidate.id === params.itemId);
      const item = index < 0
        ? { id: params.itemId, type: 'agentMessage', text: params.delta || '' }
        : { ...items[index], text: `${items[index].text || ''}${params.delta || ''}` };
      const updated = [...items];
      if (index < 0) updated.push(item);
      else updated[index] = item;
      return { ...turn, items: updated };
    });
  }
  if (method === 'item/commandExecution/outputDelta' || method === 'item/fileChange/outputDelta') {
    return updateTurn(currentThread, params.turnId, (turn) => {
      const items = asArray(turn.items);
      const index = items.findIndex((candidate) => candidate.id === params.itemId);
      const existing = index < 0
        ? { id: params.itemId, type: 'commandExecution', command: '', status: 'inProgress' }
        : items[index];
      const item = {
        ...existing,
        aggregatedOutput: `${existing.aggregatedOutput || ''}${params.delta || ''}`,
      };
      const updated = [...items];
      if (index < 0) updated.push(item);
      else updated[index] = item;
      return { ...turn, items: updated };
    });
  }
  if (method === 'thread/status/changed') {
    return { ...currentThread, status: params.status };
  }
  if (method === 'error') {
    return updateTurn(currentThread, params.turnId || `error-${Date.now()}`, (turn) => ({
      ...turn,
      status: 'failed',
      error: params.message || 'Agent request failed',
    }));
  }
  return currentThread;
}

export function applyAcceptedUserMessage(currentThread, {
  turnId, text, commandId,
} = {}) {
  if (!currentThread || !turnId || !commandId || typeof text !== 'string' || !text.trim()) {
    return currentThread;
  }
  return updateTurn(currentThread, turnId, (turn) => {
    const id = `delivery:${commandId}`;
    const items = asArray(turn.items);
    if (items.some((item) => item.id === id)) return turn;
    return {
      ...turn,
      items: [...items, {
        id,
        type: 'userMessage',
        content: [{ type: 'text', text }],
        delivery: { status: 'accepted' },
      }],
    };
  });
}

export function latestRunningTurn(thread) {
  return [...asArray(thread?.turns)].reverse().find((turn) => turn.status === 'inProgress') || null;
}

export function applyTmuxSnapshot(thread, tmux) {
  if (!thread || !tmux) return false;
  const completed = thread.tmux?.status === 'working' && tmux.status !== 'working';
  const started = thread.tmux?.status !== 'working' && tmux.status === 'working';
  const commandOutput = thread.tmux?.commandOutput;
  thread.tmux = { ...tmux, ...(!started && commandOutput ? { commandOutput } : {}) };
  return completed;
}

export function shouldRefreshTmuxThread(thread, {
  force = false, now = Date.now(), refreshUntil = 0,
} = {}) {
  const tmux = thread?.tmux;
  if (!thread?.id || !tmux?.name || tmux.available === false) return false;
  if (force) return true;
  const working = tmux.status === 'working';
  if (working && (tmux.liveOutput || tmux.activity === '后台任务运行中')) return false;
  return working || now < refreshUntil;
}

export function shouldShowTerminalActivity(thread) {
  const tmux = thread?.tmux;
  if (!tmux) return false;
  if (tmux.commandOutput?.text) return true;
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
