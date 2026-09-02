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
    delivery: item.delivery && typeof item.delivery === 'object' ? { ...item.delivery } : item.delivery,
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

function threadUserMessageEntries(thread) {
  return asArray(thread?.turns).flatMap((turn, turnIndex) => (
    asArray(turn?.items).filter((item) => item?.type === 'userMessage')
      .map((item) => ({ item, turn, turnIndex }))
  ));
}

function threadUserMessages(thread) {
  return threadUserMessageEntries(thread).map((entry) => entry.item);
}

function usersAfterDeliveryBaseline(thread, delivery) {
  if (delivery?.baselineVersion !== 2) return null;
  const incoming = threadUserMessageEntries(thread).filter((entry) => !entry.item.delivery);
  if (delivery.baselineUserMessageId) {
    const anchorIndex = incoming.findIndex((entry) => entry.item.id === delivery.baselineUserMessageId);
    return anchorIndex < 0 ? null : incoming.slice(anchorIndex + 1);
  }
  if (delivery.baselineTurnId) {
    const turnIndex = asArray(thread?.turns).findIndex((turn) => turn.id === delivery.baselineTurnId);
    return turnIndex < 0 ? null : incoming.filter((entry) => entry.turnIndex > turnIndex);
  }
  return incoming;
}

function matchingUserAfterDeliveryBaseline(thread, deliveryItem) {
  const candidates = usersAfterDeliveryBaseline(thread, deliveryItem.delivery);
  if (!candidates) return null;
  const ordinal = Number.isSafeInteger(deliveryItem.delivery?.baselineMatchingTextCount)
    && deliveryItem.delivery.baselineMatchingTextCount >= 0
    ? deliveryItem.delivery.baselineMatchingTextCount
    : 0;
  return candidates.filter((entry) => userMessageText(entry.item) === userMessageText(deliveryItem))[ordinal]?.item || null;
}

function resolvedDeliveryIds(current, refreshed) {
  const resolved = new Set();
  for (const delivery of threadUserMessages(current).filter((item) => item.delivery)) {
    if (matchingUserAfterDeliveryBaseline(refreshed, delivery)) resolved.add(delivery.id);
  }
  return resolved;
}

function mergeTurnUserMessages(current, incoming, resolvedDeliveries = new Set()) {
  const currentUsers = asArray(current?.items).filter((item) => (
    item?.type === 'userMessage' && !resolvedDeliveries.has(item.id)
  ));
  if (!currentUsers.length) return incoming;
  const incomingItems = asArray(incoming?.items);
  const incomingUsers = incomingItems.filter((item) => item?.type === 'userMessage');
  const used = new Set();
  const users = currentUsers.map((currentItem) => {
    const index = incomingUsers.findIndex((item, candidateIndex) => (
      !used.has(candidateIndex) && currentItem.id && item.id === currentItem.id
    ));
    if (index < 0) return currentItem;
    used.add(index);
    const incomingItem = incomingUsers[index];
    if (!currentItem.delivery || !incomingItem.delivery) return incomingItem;
    return {
      ...incomingItem,
      delivery: { ...currentItem.delivery, ...incomingItem.delivery },
    };
  });
  incomingUsers.forEach((item, index) => {
    if (!used.has(index)) users.push(item);
  });
  return {
    ...incoming,
    items: [...users, ...incomingItems.filter((item) => item?.type !== 'userMessage')],
  };
}

function removeUserMessage(thread, itemId) {
  let changed = false;
  const turns = asArray(thread?.turns).flatMap((turn) => {
    const items = asArray(turn.items).filter((item) => item.id !== itemId);
    if (items.length === asArray(turn.items).length) return [turn];
    changed = true;
    if (turn.deliveryOnly && !items.length) return [];
    return [{ ...turn, items }];
  });
  return changed ? { ...thread, turns } : thread;
}

export function tmuxSessionsToThreads(sessions) {
  return asArray(sessions).flatMap((session) => {
    if (!session?.name) return [];
    const provider = session.agent?.kind || 'shell';
    const available = provider === 'shell' || Boolean(session.agent.id);
    // 有结构化会话的, pane 摘录走 thread 通道 (只发给正在看的人), 不在这里广播。
    // 但 shell 会话与还没暴露 thread id 的 agent 会话从不调 openThread ——
    // openShellThread / openPendingThread 直接以 turns: [] 建线程, 会话列表是它们
    // 唯一的内容来源, 摘掉就连最近的输出都看不到。
    const liveOutput = provider === 'shell'
      ? session.liveOutput
      : (session.agent?.id ? '' : session.agent?.liveOutput);
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

export function userMessageDeliveryBaseline(thread, text) {
  const entries = threadUserMessageEntries(thread);
  const actual = entries.filter((entry) => !entry.item.delivery);
  const anchor = actual.at(-1);
  const baselineUserMessageId = typeof anchor?.item.id === 'string' && anchor.item.id
    ? anchor.item.id
    : null;
  const baselineTurnId = anchor?.turn.id || [...asArray(thread?.turns)]
    .reverse().find((turn) => !turn.deliveryOnly)?.id || null;
  const baselineMatchingTextCount = entries.filter(({ item }) => (
    item.delivery?.baselineVersion === 2
    && item.delivery.baselineUserMessageId === baselineUserMessageId
    && item.delivery.baselineTurnId === baselineTurnId
    && userMessageText(item) === text
  )).length;
  return {
    baselineVersion: 2,
    baselineUserMessageId,
    baselineTurnId,
    baselineMatchingTextCount,
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
    thread?.liveOutput,
  ]);
}

export function reconcileAgentThreadRefresh(current, refreshed) {
  if (!current) return refreshed;
  const allCurrentTurns = asArray(current.turns);
  // 流只推尾部窗口时 (refreshed.truncated), 窗口之前的历史不在这一帧里 —— 它们
  // 是已有的, 不是被删的。不保留就等于每秒把用户往回翻的历史清一次。
  // 没有该标记时保持原语义: 服务端没给的 turn 就是被删了。
  const windowStart = refreshed?.truncated
    ? allCurrentTurns.findIndex((turn) => turn.id === asArray(refreshed.turns)[0]?.id)
    : -1;
  const retained = windowStart > 0 ? allCurrentTurns.slice(0, windowStart) : [];
  const currentTurns = retained.length ? allCurrentTurns.slice(windowStart) : allCurrentTurns;
  const currentById = new Map(currentTurns.map((turn) => [turn.id, turn]));
  const resolvedDeliveries = resolvedDeliveryIds(current, refreshed);
  const refreshedItemIds = new Set(asArray(refreshed.turns).flatMap((turn) => (
    asArray(turn?.items).map((item) => item?.id).filter(Boolean)
  )));
  const refreshedTurnIds = new Set(asArray(refreshed.turns).map((turn) => turn.id));
  const turns = asArray(refreshed.turns).flatMap((turn) => {
    const existing = currentById.get(turn.id);
    if (!existing) return [turn];
    const merged = mergeTurnUserMessages(existing, turn, resolvedDeliveries);
    if (merged.deliveryOnly && !asArray(merged.items).length) return [];
    return [JSON.stringify(existing) === JSON.stringify(merged) ? existing : merged];
  });
  for (const turn of currentTurns) {
    if (!turn.deliveryOnly || refreshedTurnIds.has(turn.id)) continue;
    const items = asArray(turn.items).filter((item) => (
      !resolvedDeliveries.has(item.id) && !refreshedItemIds.has(item.id)
    ));
    if (!items.length) continue;
    turns.push(items.length === asArray(turn.items).length ? turn : { ...turn, items });
  }
  const sameTurns = turns.length === currentTurns.length
    && turns.every((turn, index) => turn === currentTurns[index]);
  if (sameTurns && renderedThreadMetadata(current) === renderedThreadMetadata(refreshed)) return current;
  return {
    ...refreshed,
    turns: sameTurns ? allCurrentTurns : retained.length ? [...retained, ...turns] : turns,
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
    let thread = currentThread;
    const targetTurn = asArray(thread.turns).find((turn) => turn.id === params.turnId);
    if (item.type === 'userMessage'
      && !asArray(targetTurn?.items).some((candidate) => candidate.id === item.id)) {
      const text = userMessageText(item);
      const delivery = text && threadUserMessages(thread).find((candidate) => (
        candidate.delivery && userMessageText(candidate) === text
      ));
      if (delivery) thread = removeUserMessage(thread, delivery.id);
    }
    return updateTurn(thread, params.turnId, (turn) => {
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
  turnId, text, commandId, baselineVersion, baselineUserMessageId, baselineTurnId,
  baselineMatchingTextCount, inputWasQueued = false,
} = {}) {
  if (!currentThread || !commandId || typeof text !== 'string' || !text.trim()) {
    return currentThread;
  }
  const id = `delivery:${commandId}`;
  const currentUsers = threadUserMessages(currentThread);
  if (currentUsers.some((item) => item.id === id)) return currentThread;
  const fallback = userMessageDeliveryBaseline(currentThread, text);
  const delivery = baselineVersion === 2 ? {
    status: 'accepted',
    baselineVersion,
    baselineUserMessageId: baselineUserMessageId || null,
    baselineTurnId: baselineTurnId || null,
    baselineMatchingTextCount: Number.isSafeInteger(baselineMatchingTextCount)
      && baselineMatchingTextCount >= 0 ? baselineMatchingTextCount : 0,
    ...(inputWasQueued ? { inputWasQueued: true } : {}),
  } : { status: 'accepted', ...fallback };
  const acceptedItem = {
    id,
    type: 'userMessage',
    content: [{ type: 'text', text }],
    delivery,
  };
  if (matchingUserAfterDeliveryBaseline(currentThread, acceptedItem)) return currentThread;
  const queuedTurnId = inputWasQueued && baselineTurnId
    && asArray(currentThread.turns).some((turn) => turn.id === baselineTurnId)
    ? baselineTurnId
    : null;
  const targetTurnId = turnId || queuedTurnId || `delivery-turn:${commandId}`;
  return updateTurn(currentThread, targetTurnId, (turn) => {
    const items = asArray(turn.items);
    const firstOutput = inputWasQueued
      ? items.findIndex((item) => item?.type !== 'userMessage')
      : -1;
    const nextItems = [...items];
    nextItems.splice(firstOutput < 0 ? items.length : firstOutput, 0, acceptedItem);
    return {
      ...turn,
      ...(!turnId && !queuedTurnId ? { status: 'completed', deliveryOnly: true } : {}),
      items: nextItems,
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

// 工作期间正文的补充节奏。完全不刷会让整段运行的正文一动不动, 跑完一次性全出现;
// 而每 tick 都刷又白费往返 —— pane 卡片已经在显示实时输出了。
export const WORKING_THREAD_REFRESH_MS = 1_500;

export function shouldRefreshTmuxThread(thread, {
  force = false, now = Date.now(), refreshUntil = 0, lastRefreshAt = 0,
} = {}) {
  const tmux = thread?.tmux;
  if (!thread?.id || !tmux?.name || tmux.available === false) return false;
  if (force) return true;
  const working = tmux.status === 'working';
  // The pane excerpt now rides the thread's own stream, so read it from the thread first;
  // keying only on tmux.liveOutput would make this always poll once the session list
  // stopped carrying it, trading the bytes we saved for a round trip per tick.
  const liveOutput = thread.liveOutput || tmux.liveOutput;
  if (working && (liveOutput || tmux.activity === '后台任务运行中')) {
    return now - lastRefreshAt >= WORKING_THREAD_REFRESH_MS;
  }
  return working || now < refreshUntil;
}

export function shouldShowTerminalActivity(thread) {
  const tmux = thread?.tmux;
  if (!tmux) return false;
  if (tmux.commandOutput?.text) return true;
  if (thread.provider === 'shell' || tmux.available === false) return true;
  if (latestRunningTurn(thread)) return false;
  if (tmux.status === 'working') return true;
  if (thread.provider !== 'claude' || !thread.liveOutput) return false;

  // 这张卡片只是兜底: Claude 偶尔会渲染出一个从没写进 JSONL 的最终回答 (磁盘写满就会
  // 这样)。判据因此是"这一轮有没有留下回答", 而不是"屏幕上的字和回答对不对得上" ——
  // pane 上除了回答还有工具调用的代码和输出, 它们永远不会出现在 agent 消息里, 所以
  // 那种比对注定不成立, 卡片也就永远不消失。修了两次都在补这个比对, 方向是错的。
  const latest = asArray(thread.turns).at(-1);
  return !asArray(latest?.items).some((item) => item?.type === 'agentMessage' && item.text);
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
