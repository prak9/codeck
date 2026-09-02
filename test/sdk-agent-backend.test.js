import { EventEmitter } from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';
import { SdkAgentBackend } from '../src/sdk-agent-backend.js';

class FakeQuery extends EventEmitter {
  constructor(prompt) {
    super();
    this.prompt = prompt;
    this.messages = [];
    this.waiters = [];
    this.interrupts = 0;
    this.closed = false;
  }

  [Symbol.asyncIterator]() { return this; }
  next() {
    if (this.messages.length) return Promise.resolve({ value: this.messages.shift(), done: false });
    if (this.closed) return Promise.resolve({ done: true });
    return new Promise((resolve) => this.waiters.push(resolve));
  }
  emitMessage(message) {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: message, done: false });
    else this.messages.push(message);
  }
  async interrupt() { this.interrupts += 1; }
  close() {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ done: true });
  }
}

async function waitFor(check) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('condition was not reached');
}

async function nextInput(query) {
  const result = await query.prompt[Symbol.asyncIterator]().next();
  return result.value;
}

function setup(provider = 'claude', backendOptions = {}) {
  const queries = [];
  const query = ({ prompt, options }) => {
    const instance = new FakeQuery(prompt);
    instance.options = options;
    queries.push(instance);
    return instance;
  };
  const backend = new SdkAgentBackend({
    provider,
    label: provider === 'claude' ? 'Claude Code' : 'QoderCLI',
    query,
    queryOptions: () => provider === 'qodercli' ? { auth: { type: 'qodercli' } } : {},
    listSessions: async () => [{
      sessionId: '11111111-1111-4111-8111-111111111111',
      summary: 'Fix the mobile layout',
      cwd: '/srv/project',
      createdAt: 1_700_000_000_000,
      lastModified: 1_700_000_020_000,
    }],
    getSessionInfo: async (sessionId) => ({
      sessionId, summary: 'Fix the mobile layout', cwd: '/srv/project', lastModified: 1_700_000_020_000,
    }),
    getSessionMessages: async () => [
      { type: 'user', uuid: 'user-1', message: { role: 'user', content: 'Check the layout' } },
      { type: 'assistant', uuid: 'assistant-1', message: { role: 'assistant', content: [{ type: 'text', text: 'It is fixed.' }] } },
    ],
    ...backendOptions,
  });
  return { backend, queries };
}

test('lists and reconstructs persisted Claude and Qoder SDK sessions', async () => {
  for (const provider of ['claude', 'qodercli']) {
    const { backend } = setup(provider);
    const listed = await backend.listThreads();
    assert.equal(listed.data[0].id, '11111111-1111-4111-8111-111111111111');
    assert.equal(listed.data[0].preview, 'Fix the mobile layout');

    const opened = await backend.openThread(listed.data[0].id);
    assert.equal(opened.thread.turns.length, 1);
    assert.equal(opened.thread.turns[0].items[0].type, 'userMessage');
    assert.equal(opened.thread.turns[0].items[1].type, 'agentMessage');
    assert.equal(opened.thread.turns[0].items[1].text, 'It is fixed.');
  }
});

test('reuses an unchanged persisted transcript and reloads as soon as its file metadata changes', async () => {
  let fileSize = 128;
  let messageLoads = 0;
  const { backend } = setup('qodercli', {
    getSessionInfo: async (sessionId) => ({
      sessionId,
      summary: 'Fix the mobile layout',
      cwd: '/srv/project',
      lastModified: 1_700_000_020_000,
      fileSize,
    }),
    getSessionMessages: async () => {
      messageLoads += 1;
      return [
        { type: 'user', uuid: 'user-1', message: { role: 'user', content: 'Check the layout' } },
        {
          type: 'assistant', uuid: 'assistant-1',
          message: { role: 'assistant', content: [{ type: 'text', text: fileSize === 128 ? 'First answer.' : 'Final answer.' }] },
        },
      ];
    },
  });

  const first = await backend.openThread('11111111-1111-4111-8111-111111111111');
  const unchanged = await backend.openThread('11111111-1111-4111-8111-111111111111');
  assert.equal(messageLoads, 1);
  assert.equal(unchanged.thread.turns[0].items[1].text, 'First answer.');
  assert.notEqual(unchanged.thread.turns, first.thread.turns);

  fileSize = 160;
  const changed = await backend.openThread('11111111-1111-4111-8111-111111111111');
  assert.equal(messageLoads, 2);
  assert.equal(changed.thread.turns[0].items[1].text, 'Final answer.');
  backend.close();
});

test('reloads persisted transcripts when the SDK does not expose reliable file metadata', async () => {
  let messageLoads = 0;
  const { backend } = setup('claude', {
    getSessionInfo: async (sessionId) => ({
      sessionId,
      summary: 'Fix the mobile layout',
      cwd: '/srv/project',
      lastModified: 1_700_000_020_000,
      fileSize: null,
    }),
    getSessionMessages: async () => {
      messageLoads += 1;
      return [{
        type: 'assistant',
        uuid: `assistant-${messageLoads}`,
        message: { role: 'assistant', content: [{ type: 'text', text: `Answer ${messageLoads}` }] },
      }];
    },
  });

  const first = await backend.openThread('11111111-1111-4111-8111-111111111111');
  const second = await backend.openThread('11111111-1111-4111-8111-111111111111');
  assert.equal(messageLoads, 2);
  assert.equal(first.thread.turns[0].items[0].text, 'Answer 1');
  assert.equal(second.thread.turns[0].items[0].text, 'Answer 2');
  backend.close();
});

test('coalesces concurrent transcript loads for the same file revision', async () => {
  let messageLoads = 0;
  let finishLoad;
  const messages = new Promise((resolve) => { finishLoad = resolve; });
  const { backend } = setup('qodercli', {
    getSessionInfo: async (sessionId) => ({
      sessionId,
      summary: 'Fix the mobile layout',
      cwd: '/srv/project',
      lastModified: 1_700_000_020_000,
      fileSize: 128,
    }),
    getSessionMessages: async () => {
      messageLoads += 1;
      return messages;
    },
  });

  const first = backend.openThread('11111111-1111-4111-8111-111111111111');
  const second = backend.openThread('11111111-1111-4111-8111-111111111111');
  await waitFor(() => messageLoads === 1);
  finishLoad([{ type: 'assistant', uuid: 'assistant-1', message: { role: 'assistant', content: 'Done' } }]);
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(messageLoads, 1);
  assert.equal(firstResult.thread.turns[0].items[0].text, 'Done');
  assert.equal(secondResult.thread.turns[0].items[0].text, 'Done');
  backend.close();
});

test('starts a persistent interactive session and streams Codex-shaped events', async () => {
  const { backend, queries } = setup('claude');
  const notifications = [];
  backend.on('notification', (message) => notifications.push(message));

  const started = await backend.newThread({ cwd: '/srv/project', text: 'Review this repo' });
  assert.match(started.thread.id, /^[0-9a-f-]{36}$/);
  assert.equal(queries.length, 1);
  assert.equal(queries[0].options.cwd, '/srv/project');
  assert.equal(queries[0].options.sessionId, started.thread.id);
  assert.equal(queries[0].options.includePartialMessages, true);

  const input = await nextInput(queries[0]);
  assert.equal(input.message.content[0].text, 'Review this repo');
  assert.equal(input.priority, 'next');
  const listedWhileRunning = await backend.listThreads();
  const active = listedWhileRunning.data.find((thread) => thread.id === started.thread.id);
  assert.equal(active.status.type, 'active');
  assert.equal(active.preview, 'Review this repo');

  queries[0].emitMessage({
    type: 'stream_event', session_id: started.thread.id,
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done' } },
  });
  queries[0].emitMessage({
    type: 'result', subtype: 'success', session_id: started.thread.id,
    duration_ms: 25, is_error: false, result: 'Done',
  });
  await waitFor(() => notifications.some((message) => message.method === 'turn/completed'));
  assert.equal(notifications.find((message) => message.method === 'item/agentMessage/delta').params.delta, 'Done');
  assert.equal(notifications.find((message) => message.method === 'turn/completed').params.turn.status, 'completed');
  backend.close();
});

test('uses now priority for steering and interrupts the live query', async () => {
  const { backend, queries } = setup('qodercli');
  const started = await backend.newThread({ cwd: '/srv/project', text: 'First prompt' });
  await nextInput(queries[0]);

  const followUp = await backend.sendMessage({
    threadId: started.thread.id,
    turnId: started.turn.id,
    mode: 'steer',
    text: 'Change direction',
  });
  const steeredInput = await nextInput(queries[0]);
  assert.equal(steeredInput.priority, 'now');
  assert.equal(steeredInput.message.content[0].text, 'Change direction');
  assert.equal(followUp.queued, true);

  await backend.interruptTurn({ threadId: started.thread.id, turnId: started.turn.id });
  assert.equal(queries[0].interrupts, 1);
  backend.close();
});

test('bridges SDK tool permissions to the remote approval surface', async () => {
  const { backend, queries } = setup('claude');
  const requests = [];
  backend.on('serverRequest', (request) => requests.push(request));
  const started = await backend.newThread({ cwd: '/srv/project', text: 'Run tests' });
  await nextInput(queries[0]);

  const permission = queries[0].options.canUseTool('Bash', { command: 'npm test' }, {
    title: 'Claude wants to run npm test',
    suggestions: [{ type: 'addRules', rules: [], behavior: 'allow', destination: 'session' }],
    toolUseID: 'tool-bash',
    signal: new AbortController().signal,
  });
  await waitFor(() => requests.length === 1);
  assert.equal(requests[0].params.threadId, started.thread.id);
  assert.equal(requests[0].params.toolName, 'Bash');
  assert.equal(requests[0].params.canAcceptForSession, true);
  await backend.respond(requests[0].id, { decision: 'acceptForSession' });
  assert.deepEqual(await permission, {
    behavior: 'allow',
    updatedInput: { command: 'npm test' },
    updatedPermissions: [{ type: 'addRules', rules: [], behavior: 'allow', destination: 'session' }],
    toolUseID: 'tool-bash',
  });
  await assert.rejects(backend.respond(requests[0].id, { decision: 'accept' }), /already resolved/i);
  backend.close();
});

test('bridges SDK AskUserQuestion calls to structured mobile answers', async () => {
  const { backend, queries } = setup('qodercli');
  const requests = [];
  backend.on('serverRequest', (request) => requests.push(request));
  await backend.newThread({ cwd: '/srv/project', text: 'Plan the UI' });
  await nextInput(queries[0]);
  const questions = [{
    header: 'Layout',
    question: 'Which layout should be used?',
    options: [
      { label: 'Mobile', description: 'Phone-first layout' },
      { label: 'Desktop', description: 'Wide layout' },
    ],
    multiSelect: false,
  }];

  const answer = queries[0].options.canUseTool('AskUserQuestion', { questions }, {
    toolUseID: 'tool-question',
    signal: new AbortController().signal,
  });
  await waitFor(() => requests.length === 1);
  assert.equal(requests[0].method, 'item/tool/requestUserInput');
  assert.equal(requests[0].params.questions[0].id, 'question-1');
  await backend.respond(requests[0].id, { answers: { 'question-1': ['Mobile'] } });
  assert.deepEqual(await answer, {
    behavior: 'allow',
    updatedInput: {
      questions,
      answers: { 'Which layout should be used?': 'Mobile' },
    },
    toolUseID: 'tool-question',
  });
  backend.close();
});

test('releases an interactive CLI process after the completed session is idle', async () => {
  const { backend, queries } = setup('claude', { idleTimeoutMs: 1 });
  const started = await backend.newThread({ cwd: '/srv/project', text: 'One turn' });
  await nextInput(queries[0]);
  queries[0].emitMessage({
    type: 'result', subtype: 'success', session_id: started.thread.id,
    duration_ms: 1, is_error: false, result: 'Done',
  });
  await waitFor(() => queries[0].closed);
  assert.equal(queries[0].closed, true);
  backend.close();
});

function transcriptBackend({ file, chunks, infoFor }) {
  // 每次 openThread 都整份重读 transcript 是活跃会话每秒 ~37ms 的来源
  // (3.9MB 文件的读取+解码占了 openThread 54ms 里的大头)。这里用可注入的
  // reader 记录到底读了哪些字节区间。
  const reads = [];
  let fullLoads = 0;
  const backend = new SdkAgentBackend({
    provider: 'claude',
    label: 'Claude Code',
    query: () => new FakeQuery(''),
    listSessions: async () => [],
    getSessionInfo: async () => infoFor(),
    getSessionMessages: async () => {
      fullLoads += 1;
      return chunks.join('').split('\n').filter(Boolean).flatMap((entry) => {
        try { return [JSON.parse(entry)]; } catch { return []; }
      });
    },
    transcriptFile: () => file,
    readTranscriptRange: async (path, start, end) => {
      reads.push({ path, start, end });
      return chunks.join('').slice(start, end);
    },
  });
  return { backend, reads, fullLoads: () => fullLoads };
}

const line = (id, text) => `${JSON.stringify({ type: 'user', uuid: id, message: { role: 'user', content: text } })}\n`;

test('a grown transcript is read from the previous offset instead of in full', async () => {
  const chunks = [line('a', 'one') + line('b', 'two')];
  let size = chunks.join('').length;
  const { backend, reads, fullLoads } = transcriptBackend({
    file: '/transcripts/thread.jsonl',
    chunks,
    infoFor: () => ({ sessionId: 't1', cwd: '/srv', lastModified: size, fileSize: size }),
  });

  await backend.openThread('t1');
  assert.equal(fullLoads(), 1, 'the first load has nothing to append to');

  const before = chunks.join('').length;
  chunks.push(line('c', 'three'));
  size = chunks.join('').length;
  await backend.openThread('t1');

  assert.equal(fullLoads(), 1, 'the grown transcript must not be re-read in full');
  assert.equal(reads.at(-1).path, '/transcripts/thread.jsonl');
  assert.equal(reads.at(-1).end, size);
  assert.ok(reads.at(-1).start >= before - 1 && reads.at(-1).start <= before,
    'only the appended range is read, plus the byte that proves the boundary');
});

test('an incremental transcript read still yields the whole conversation', async () => {
  const chunks = [line('a', 'one')];
  let size = chunks.join('').length;
  const { backend } = transcriptBackend({
    file: '/transcripts/thread.jsonl',
    chunks,
    infoFor: () => ({ sessionId: 't1', cwd: '/srv', lastModified: size, fileSize: size }),
  });

  await backend.openThread('t1');
  chunks.push(line('b', 'two'));
  size = chunks.join('').length;
  const { thread } = await backend.openThread('t1');

  const texts = thread.turns.flatMap((turn) => turn.items.map((item) => item.text ?? item.content?.[0]?.text));
  assert.ok(texts.includes('one'), 'history before the appended range survives');
  assert.ok(texts.includes('two'), 'the appended range is applied');
});

test('a half-written trailing line never resumes from its middle', async () => {
  const chunks = [line('a', 'one')];
  let size = chunks.join('').length;
  const { backend, fullLoads } = transcriptBackend({
    file: '/transcripts/thread.jsonl',
    chunks,
    infoFor: () => ({ sessionId: 't1', cwd: '/srv', lastModified: size, fileSize: size }),
  });
  await backend.openThread('t1');

  chunks.push('{"type":"user","uuid":"partial"');   // 写了一半, 没有换行
  size = chunks.join('').length;
  await backend.openThread('t1');

  chunks[chunks.length - 1] += ',"message":{"role":"user","content":"two"}}\n';
  size = chunks.join('').length;
  const { thread } = await backend.openThread('t1');

  // 关键是不出错: 半行既不能被当成完整消息, 也不能在补全后从中间接续。
  // 代价是这两轮各回落一次整份读取, 之后自动恢复增量。
  const texts = thread.turns.flatMap((turn) => turn.items.map((item) => item.text ?? item.content?.[0]?.text));
  assert.equal(texts.filter((value) => value === 'two').length, 1, 'the completed line lands exactly once');
  assert.ok(texts.includes('one'), 'earlier history survives the fallback');

  const loadsAfterRecovery = fullLoads();
  chunks.push(line('c', 'three'));
  size = chunks.join('').length;
  await backend.openThread('t1');
  assert.equal(fullLoads(), loadsAfterRecovery, 'incremental reading resumes after the partial line settles');
});

test('a shrunken or unreadable transcript falls back to a full load', async () => {
  const chunks = [line('a', 'one') + line('b', 'two')];
  let size = chunks.join('').length;
  const { backend, fullLoads } = transcriptBackend({
    file: '/transcripts/thread.jsonl',
    chunks,
    infoFor: () => ({ sessionId: 't1', cwd: '/srv', lastModified: size, fileSize: size }),
  });
  await backend.openThread('t1');
  assert.equal(fullLoads(), 1);

  chunks.length = 0;
  chunks.push(line('z', 'compacted'));
  size = chunks.join('').length;
  await backend.openThread('t1');

  assert.equal(fullLoads(), 2, 'a transcript that shrank cannot be appended to');
});

test('only the newest transcripts keep their raw messages in memory', async () => {
  // 增量读取要留着已解析的 messages 才能把新增部分接上去, 但那让单个会话的缓存
  // 从 1.3MB 涨到 5.0MB (实测), 16 个槽最坏 80MB。而稳定的 transcript 走
  // revision 命中直接返回 turns, 根本不碰 messages —— 只有还在增长的才需要。
  const chunks = {};
  const sizes = {};
  const backend = new SdkAgentBackend({
    provider: 'claude',
    label: 'Claude Code',
    query: () => new FakeQuery(''),
    listSessions: async () => [],
    getSessionInfo: async (id) => ({ sessionId: id, cwd: '/srv', lastModified: sizes[id], fileSize: sizes[id] }),
    getSessionMessages: async (id) => chunks[id].join('').split('\n').filter(Boolean).flatMap((entry) => {
      try { return [JSON.parse(entry)]; } catch { return []; }
    }),
    transcriptFile: (id) => `/transcripts/${id}.jsonl`,
    readTranscriptRange: async (file, start, end) => {
      const id = file.split('/').pop().replace('.jsonl', '');
      return chunks[id].join('').slice(start, end);
    },
    rawMessageCacheEntries: 2,
  });

  for (const id of ['a', 'b', 'c']) {
    chunks[id] = [line(`${id}1`, 'one')];
    sizes[id] = chunks[id].join('').length;
    await backend.openThread(id);
  }

  const retained = [...backend.transcriptCache.entries()].filter(([, entry]) => entry.messages);
  assert.equal(retained.length, 2, '只有最近两个保留原始消息');
  assert.deepEqual(retained.map(([id]) => id), ['b', 'c'], '保留的是最近使用的');
  // 被裁掉 messages 的那个仍然可用: 只是下次增长时回落一次整份读取。
  assert.ok(backend.transcriptCache.get('a').turns, 'turns 必须保留, 否则缓存就白做了');
});

test('one malformed transcript line loses only itself, not the history before it', async () => {
  // 实测: 一份 5246 行的 transcript 里第 5095 行 JSON 残缺(写入被截断), SDK 的读取器
  // 只返回 95 条消息 —— 之前 97% 的对话在界面上直接消失。写入方偶尔确实会留下半行,
  // 所以整份读取必须能跨过它。
  const good = (id, text) => JSON.stringify({ type: 'user', uuid: id, message: { role: 'user', content: text } });
  const text = [good('a', '第一句'), '{"type":"user","uuid":"broken"', good('c', '第三句')].join('\n');
  let sdkCalls = 0;
  const backend = new SdkAgentBackend({
    provider: 'claude',
    label: 'Claude Code',
    query: () => new FakeQuery(''),
    listSessions: async () => [],
    getSessionInfo: async () => ({ sessionId: 'thread', cwd: '/srv', lastModified: 1, fileSize: text.length }),
    getSessionMessages: async () => { sdkCalls += 1; return []; },
    transcriptFile: () => '/transcripts/thread.jsonl',
    readTranscriptFile: async () => text,
  });
  const thread = await backend.openThread('thread');
  const rendered = JSON.stringify(thread.thread.turns);
  assert.match(rendered, /第一句/, '坏行之前的内容必须保留');
  assert.match(rendered, /第三句/);
  assert.equal(sdkCalls, 0, '自己解析成功就不该再回落到会截断的 SDK 读取器');
});
