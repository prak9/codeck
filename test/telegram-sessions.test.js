import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TelegramSessions } from '../src/telegram-sessions.js';

const target = name => ({ provider: 'codex', threadId: `thread-${name}`, tmuxSession: name });
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codeck-session-bot-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sent = [], actions = [], snapshots = new Map(['a', 'b'].map(n => [n, { thread: { id: `thread-${n}`, turns: [] } }]));
  let incoming = [], now = 1000, sequence = 0;
  const options = { directory, ownerId: 42, botId: 7, now: () => now,
    api: async (method, payload) => { if (method === 'getUpdates') { const batch = incoming; incoming = []; return batch; }
      sent.push(payload); return { message_id: sent.length + 100 }; },
    sessions: { list: async () => ['a', 'b'].map(n => ({ name: n, agent: { kind: 'codex', id: `thread-${n}` } })),
      read: async t => snapshots.get(t.tmuxSession),
      act: async (kind, t, args) => { actions.push({ kind, target: t, args }); return { submissionStatus: 'submitted' }; } },
  };
  const bot = new TelegramSessions(options); await bot.load();
  return { bot, options, sent, actions, snapshots, advance: ms => { now += ms; },
    input(text, extra = {}) { incoming.push({ update_id: ++sequence, message: { message_id: sequence, text, from: { id: 42 }, chat: { id: 42, type: 'private' }, ...extra } }); },
  };
}

test('selecting and replying route to exact sessions; duplicate updates and strangers do not execute', async t => {
  const f = await fixture(t);
  f.input('/use a'); await f.bot.tick();
  f.input('first'); await f.bot.tick();
  const replyId = f.sent.length + 100;
  f.input('/use b'); await f.bot.tick();
  f.input('follow up', { reply_to_message: { message_id: replyId } }); await f.bot.tick();
  assert.deepEqual(f.actions.map(a => a.target), [target('a'), target('a')]);
  f.input('stranger', { from: { id: 9 }, chat: { id: 9, type: 'private' } }); await f.bot.tick();
  assert.equal(f.actions.length, 2);
  f.input('unknown reply', { reply_to_message: { message_id: 9999 } }); await f.bot.tick();
  assert.equal(f.actions.length, 2);
});

test('session replacement does not redirect an old selection into a new thread', async t => {
  const f = await fixture(t); f.input('/use a'); await f.bot.tick();
  f.options.sessions.list = async () => [{ name: 'a', agent: { kind: 'codex', id: 'replacement' } }];
  f.input('work'); await f.bot.tick(); assert.equal(f.actions.length, 0);
  assert.match(f.sent.at(-1).text, /变化|重新选择/);
});

test('watch baselines old output and notifies a new round once, without claiming goal completion', async t => {
  const f = await fixture(t);
  f.snapshots.set('a', { thread: { turns: [{ id: 'old', status: 'completed', items: [{ type: 'agentMessage', text: 'old' }] }] } });
  f.input('/watch a'); await f.bot.tick();
  assert.ok(!f.sent.some(m => m.text.includes('本轮结束')));
  f.snapshots.set('a', { thread: { turns: [{ id: 'new', status: 'inProgress', items: [] }] } });
  f.advance(12000); await f.bot.tick();
  f.snapshots.set('a', { thread: { turns: [{ id: 'new', status: 'completed', items: [{ type: 'agentMessage', text: 'result' }] }] } });
  f.advance(12000); await f.bot.tick();
  const resumed = new TelegramSessions(f.options); await resumed.load(); f.advance(12000); await resumed.tick();
  assert.equal(f.sent.filter(m => m.text.includes('本轮结束')).length, 1);
  assert.ok(!f.sent.some(m => m.text.includes('目标完成')));
});

test('a lost send reply is never replayed after restart; notification retry does not rerun work', async t => {
  const f = await fixture(t); f.input('/use a'); await f.bot.tick();
  f.options.sessions.act = async (...args) => { f.actions.push(args); throw new Error('lost ACK'); };
  f.input('work'); await f.bot.tick();
  const resumed = new TelegramSessions(f.options); await resumed.load(); await resumed.tick();
  assert.equal(f.actions.length, 1);
  assert.ok(f.sent.some(m => m.text.includes('未确认')));
});

test('legacy control inbox is retained as evidence but never dispatched into a session', async t => {
  const f = await fixture(t);
  await fs.rm(path.join(f.options.directory, 'sessions.json'));
  await fs.writeFile(path.join(f.options.directory, 'state.json'), JSON.stringify({ ownerId: 42, botId: 7, offset: 77,
    inbox: [{ id: 76, status: 'received', text: 'old task' }], outbox: [{ text: 'old result' }] }));
  const resumed = new TelegramSessions(f.options); await resumed.load(); await resumed.tick();
  assert.equal(resumed.state.offset, 77); assert.equal(f.actions.length, 0);
  assert.equal((await fs.readFile(path.join(f.options.directory, 'state.json'), 'utf8')).includes('old task'), true);
});

test('an approval must be an explicit reply, never a generic confirmation to the selected session', async t => {
  const f = await fixture(t); f.input('/use a'); await f.bot.tick();
  f.snapshots.set('a', { thread: { turns: [] }, interactions: [{ kind: 'approval', id: 1, text: '批准？' }] });
  f.advance(12000); await f.bot.tick(); const replyId = f.sent.length + 100;
  f.input('/use b'); await f.bot.tick();
  f.input('/approve'); await f.bot.tick();
  assert.equal(f.actions.length, 0);
  f.input('确认', { reply_to_message: { message_id: replyId } }); await f.bot.tick();
  assert.equal(f.actions[0].kind, 'approve'); assert.deepEqual(f.actions[0].target, target('a'));
});

test('notification failures only retry outbox; confirmed task is not repeated', async t => {
  const f = await fixture(t); f.input('/use a'); await f.bot.tick();
  const original = f.options.api; let offline = true;
  f.bot.api = async (method, args) => { if (method === 'sendMessage' && offline) throw new Error('offline'); return original(method, args); };
  f.input('work'); await assert.rejects(f.bot.tick(), /offline/);
  assert.equal(f.actions.length, 1); offline = false;
  const resumed = new TelegramSessions(f.options); await resumed.load(); await resumed.tick();
  assert.equal(f.actions.length, 1); assert.equal(resumed.state.outbox.length, 0);
});

test('historyLoading never creates a completion and malformed Unicode cannot hang long replies', async t => {
  const f = await fixture(t); f.input('/watch a'); await f.bot.tick();
  f.snapshots.set('a', { thread: { historyLoading: true, turns: [{ id: 'false', status: 'completed', items: [] }] } });
  f.advance(12000); await f.bot.tick();
  assert.ok(!f.sent.some(m => m.text.includes('本轮结束')));
});

test('natural multi-session actions are durable, query does not send, and replay never duplicates a task', async t => {
  const f = await fixture(t); let classifications = 0;
  f.bot.understand = async () => { classifications++; return { actions: [
    { kind: 'send', target: target('a'), text: '继续当前目标' }, { kind: 'status', target: target('b') },
  ] }; };
  f.input('让 a 继续，看看 b'); await f.bot.tick();
  assert.equal(f.actions.length, 1); assert.equal(f.actions[0].target.tmuxSession, 'a');
  assert.ok(f.sent.some(m => m.text.startsWith('[b]')));
  const resumed = new TelegramSessions({ ...f.options, understand: f.bot.understand }); await resumed.load(); await resumed.tick();
  assert.equal(f.actions.length, 1); assert.equal(classifications, 1);
});

test('clarification retains original task and does not execute until its answer resolves the ambiguity', async t => {
  const f = await fixture(t); const contexts = [];
  f.bot.understand = async c => { contexts.push(c); return contexts.length === 1 ? { clarification: 'a 还是 b？', actions: [] }
    : { actions: [{ kind: 'send', target: target('b'), text: '修复之前的问题' }] }; };
  f.input('修复之前的问题'); await f.bot.tick(); assert.equal(f.actions.length, 0);
  f.input('b', { reply_to_message: { message_id: f.sent.length + 100 } }); await f.bot.tick();
  assert.equal(contexts[1].clarification.original, '修复之前的问题'); assert.equal(f.actions[0].target.tmuxSession, 'b');
  assert.equal(f.bot.state.clarification, null);
});

test('a new task uses one creation with prompt and adopts only its own pane when the Agent appears', async t => {
  const f = await fixture(t); const created = []; let ready = false;
  f.options.sessions.create = async a => { created.push(a); return { provider: 'codex', threadId: null, tmuxSession: a.name, paneId: '%99' }; };
  const list = f.options.sessions.list;
  f.options.sessions.list = async () => [...await list(), ...(created.length ? [{ name: created[0].name, paneId: '%99', agent: ready ? { kind: 'codex', id: 'fresh' } : null }] : [])];
  f.bot.understand = async () => ({ actions: [{ kind: 'create', provider: 'codex', cwd: '/work', text: '研究 XX，预算30分钟' }] });
  f.input('新开任务研究 XX'); await f.bot.tick(); assert.equal(created.length, 1);
  assert.equal(f.actions.length, 0); // initial task is a CLI argument, never pasted twice
  const replyId = f.sent.length + 100;
  ready = true;
  f.snapshots.set(created[0].name, { thread: { turns: [{ id: 'new', status: 'completed', items: [{ type: 'agentMessage', text: '已建立起点' }] }] } });
  f.advance(12000); await f.bot.tick();
  assert.equal(f.bot.state.bindings[replyId].target.threadId, 'fresh');
  assert.ok(f.sent.some(m => m.text.includes('已建立起点')));
  const resumed = new TelegramSessions(f.options); await resumed.load(); await resumed.tick(); assert.equal(created.length, 1);
});

test('a lost create reply remains uncertain and is never converted into another creation', async t => {
  const f = await fixture(t); let creates = 0;
  f.options.sessions.create = async () => { creates++; throw new Error('lost creation ACK'); };
  f.bot.understand = async () => ({ actions: [{ kind: 'create', provider: 'codex', cwd: '/work', text: 'work' }] });
  f.input('新建'); await f.bot.tick();
  const resumed = new TelegramSessions(f.options); await resumed.load(); await resumed.tick();
  assert.equal(creates, 1); assert.ok(f.sent.some(m => m.text.includes('tg-1-0') && m.text.includes('不会重复创建')));
});

test('a slow new Agent gets one readiness notice without a second creation', async t => {
  const f = await fixture(t); let creates = 0;
  f.options.sessions.create = async a => { creates++; return { provider: 'codex', threadId: null, tmuxSession: a.name, paneId: '%7' }; };
  f.bot.understand = async () => ({ actions: [{ kind: 'create', provider: 'codex', cwd: '/work', text: 'work' }] });
  f.input('新任务'); await f.bot.tick();
  f.advance(61000); await f.bot.tick(); f.advance(12000); await f.bot.tick();
  assert.equal(creates, 1); assert.equal(f.sent.filter(m => m.text.includes('Agent 尚未就绪')).length, 1);
});
