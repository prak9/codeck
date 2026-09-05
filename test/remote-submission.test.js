import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as model from '../public/agent-model.js';
import * as composer from '../public/remote-composer.js';
import * as delivery from '../public/remote-delivery.js';

const source = fs.readFileSync(new URL('../public/remote.js', import.meta.url), 'utf8');
const draft = '分析下 BABA 当前投资价值';
const user = (id, text = draft) => ({ id, type: 'userMessage', content: [{ type: 'text', text }] });
const thread = () => ({
  id: 'thread-a', provider: 'codex', readOnly: true,
  tmux: { name: 'skills', available: true, status: 'done' },
  turns: [{ id: 'turn-old', status: 'completed', items: [user('user-old', 'Earlier question')] }],
});

function fixture(result = { submissionStatus: 'unconfirmed' }) {
  const input = { value: draft };
  const state = {
    provider: 'codex', thread: thread(), threads: [], attachments: [],
    pendingDeliveries: new Map(), protocolEpoch: 'epoch', commandReceiptTtlMs: 600_000,
  };
  const sent = [];
  let liveMessage = '';
  const context = vm.createContext({
    ...model, ...composer, ...delivery,
    state, crypto: { randomUUID: () => `command-${sent.length + 1}` },
    Date, setTimeout, clearTimeout,
    $: () => input,
    composerRequestGate: composer.createComposerRequestGate(),
    abortSpeechInput() {}, commandPendingMessage: () => '正在发送…',
    setLiveMessage(message) { liveMessage = message; state.liveMessage = message; },
    uploadAttachments: async () => [], attachmentMessage: ({ text }) => text,
    clearAttachments(attachments) {
      const sentIds = new Set(attachments.map((attachment) => attachment.id));
      state.attachments = state.attachments.filter((attachment) => !sentIds.has(attachment.id));
    },
    resizeComposer() {}, renderThreadList() {}, renderComposerState() {},
    scheduleThreadRender() {}, loadThreads: async () => {}, refreshActiveThread: async () => {},
    agentRequest: async (type, payload) => {
      sent.push({ type, ...payload });
      return typeof result === 'function' ? await result() : await result;
    },
    element(tag, className, text) {
      return { tag, className, textContent: text, children: [], append(...nodes) { this.children.push(...nodes); } };
    },
  });
  const constant = source.match(/^const SUBMISSION_UNCONFIRMED_MESSAGE = .*;$/m)?.[0] || '';
  vm.runInContext(constant + '\n'
    + source.slice(source.indexOf('function settleConfirmedDeliveries('), source.indexOf('\nfunction releaseThreadStream('))
    + '\n'
    + source.slice(source.indexOf('async function submitComposer('), source.indexOf('\nfunction toggleSpeechInput('))
    + '\n' + source.slice(source.indexOf('function itemNode('), source.indexOf('\nfunction agentOutputActions(')), context);
  return { context, state, input, sent, get message() { return liveMessage; } };
}

test('unconfirmed submission preserves the draft and original command without claiming work or retrying', async () => {
  const f = fixture();
  await f.context.submitComposer();
  assert.equal(f.input.value, draft);
  assert.equal(f.state.thread.tmux.status, 'done');
  assert.match(f.message, /提交未确认.*勿重复发送/);
  const attempt = [...f.state.pendingDeliveries.values()][0];
  assert.equal(attempt.commandId, f.sent[0].commandId);
  assert.equal(attempt.blockReason, 'submissionUnconfirmed');
  assert.equal(f.state.thread.turns.at(-1).items[0].delivery.submissionStatus, 'unconfirmed');
  await f.context.submitComposer();
  assert.equal(f.sent.length, 1);
  assert.equal(f.input.value, draft);
  assert.match(f.message, /提交未确认.*勿重复发送/);
});

for (const message of [
  'Codex 终端中已有草稿，消息未发送。请先在终端处理草稿后重试。',
  '无法安全确认 Codex 输入框为空，消息未发送。请先在终端检查后重试。',
]) {
  test(`pre-paste rejection preserves the draft and attachments without successful feedback: ${message}`, async () => {
    const f = fixture(() => { throw new Error(message); });
    const originalDraft = `  ${draft}\n保留后续说明  `;
    const attachment = { id: 'attachment-1', path: '/uploads/report.txt', status: 'uploaded' };
    f.input.value = originalDraft;
    f.state.attachments = [attachment];
    f.state.threads = [structuredClone(f.state.thread)];
    const originalThread = structuredClone(f.state.thread);
    const originalListedThreads = structuredClone(f.state.threads);
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await f.context.submitComposer();
      assert.equal(f.sent.length, attempt, 'a definitely unsent request may be attempted again');
      assert.equal(f.input.value, originalDraft);
      assert.deepEqual(f.state.attachments, [attachment]);
      assert.equal(f.state.attachments[0], attachment);
      assert.equal(f.state.pendingDeliveries.size, 0);
      assert.equal(f.context.composerRequestGate.pending, false);
      assert.equal(f.message, message);
      assert.deepEqual(f.state.thread, originalThread, 'no accepted message, checkpoint, or working state');
      assert.deepEqual(f.state.threads, originalListedThreads);
      assert.equal(f.state.thread.turns.flatMap((turn) => turn.items).filter((item) => item.delivery).length, 0);
    }
  });
}

for (const result of [{ submissionStatus: 'submitted' }, {}]) {
  test(`confirmed and legacy responses clear only the submitted draft: ${JSON.stringify(result)}`, async () => {
    const f = fixture(result);
    await f.context.submitComposer();
    assert.equal(f.input.value, '');
    assert.equal(f.state.pendingDeliveries.size, 0);
    const item = f.state.thread.turns.at(-1).items[0];
    assert.equal(item.delivery.status, 'accepted');
    const node = f.context.itemNode(item, f.state.thread.turns.at(-1));
    assert.equal(node.children.at(-1)?.textContent, '等待 Agent 确认');
  });
}

test('a late unconfirmed response cannot alter another session or its draft', async () => {
  let resolve;
  const f = fixture(new Promise((done) => { resolve = done; }));
  const sending = f.context.submitComposer();
  await new Promise(setImmediate);
  assert.equal(f.sent.length, 1);
  f.state.thread = { ...thread(), id: 'thread-b', tmux: { name: 'other', status: 'done' } };
  f.input.value = 'New session draft';
  f.context.setLiveMessage('Other session');
  resolve({ submissionStatus: 'unconfirmed' });
  await sending;
  assert.equal(f.input.value, 'New session draft');
  assert.equal(f.message, 'Other session');
  assert.equal(f.state.thread.turns.length, 1);
  assert.equal([...f.state.pendingDeliveries.values()][0].blockReason, 'submissionUnconfirmed');
});

test('a late confirmed response cannot clear an identical draft in another session', async () => {
  let resolve;
  const f = fixture(new Promise((done) => { resolve = done; }));
  const sending = f.context.submitComposer();
  await new Promise(setImmediate);
  assert.equal(f.sent.length, 1);
  f.state.thread = { ...thread(), id: 'thread-b', tmux: { name: 'other', status: 'done' } };
  f.context.setLiveMessage('Other session');
  resolve({ submissionStatus: 'submitted' });
  await sending;
  assert.equal(f.input.value, draft);
  assert.equal(f.message, 'Other session');
});

test('restored unconfirmed transcript receipts also block same-text submission', async () => {
  const f = fixture();
  f.state.thread.turns.push({ id: 'receipt-turn', status: 'completed', deliveryOnly: true,
    items: [{ ...user('delivery:original-command'), delivery: { status: 'accepted', submissionStatus: 'unconfirmed' } }] });
  await f.context.submitComposer();
  assert.equal(f.sent.length, 0);
  assert.equal(f.input.value, draft);
  assert.match(f.message, /提交未确认.*勿重复发送/);
  assert.equal([...f.state.pendingDeliveries.values()][0].commandId, 'original-command');
});

test('a real transcript removes the marker and releases the unconfirmed retry block', async () => {
  const f = fixture();
  await f.context.submitComposer();
  const original = thread();
  f.state.thread = model.reconcileAgentThreadRefresh(f.state.thread, {
    ...original, turns: [...original.turns, { id: 'turn-new', status: 'completed', items: [user('actual')] }],
  });
  f.context.settleConfirmedDeliveries();
  assert.equal(f.state.pendingDeliveries.size, 0);
  assert.equal(f.message, '');
  assert.equal(f.context.itemNode(f.state.thread.turns.at(-1).items[0], {}).children.length, 0);
});

test('unconfirmed receipts cannot block later intentional repetition after a real transcript confirms them', async () => {
  const f = fixture({ submissionStatus: 'submitted' });
  const original = thread();
  const baseline = model.userMessageDeliveryBaseline(original, draft);
  f.state.thread.turns.push({ id: 'receipt-turn', status: 'completed', deliveryOnly: true,
    items: [{ ...user('delivery:original-command'), delivery: { status: 'accepted', submissionStatus: 'unconfirmed', ...baseline } }] });
  f.state.thread.turns.push({ id: 'turn-real', status: 'completed', items: [user('actual')] });
  await f.context.submitComposer();
  assert.equal(f.sent.length, 1);
  assert.equal(f.input.value, '');
});

test('unconfirmed status remains metadata until a real transcript replaces the message', () => {
  const before = thread();
  const accepted = model.applyAcceptedUserMessage(before, {
    text: draft, commandId: 'test-command', submissionStatus: 'unconfirmed',
    ...model.userMessageDeliveryBaseline(before, draft),
  });
  assert.equal(accepted.turns.at(-1).items[0].delivery.submissionStatus, 'unconfirmed');
  const refreshed = model.reconcileAgentThreadRefresh(accepted, {
    ...before, turns: [...before.turns, { id: 'turn-new', status: 'inProgress', items: [user('actual')] }],
  });
  assert.equal(refreshed.turns.flatMap(t => t.items).filter(i => model.userMessageText(i) === draft).length, 1);
  assert.equal(refreshed.turns.flatMap(t => t.items).some(i => i.delivery), false);
});

test('a real same-id item event must remove stale optimistic delivery metadata', () => {
  const before = thread();
  before.turns[0].items.push({ ...user('actual'), delivery: { status: 'accepted', submissionStatus: 'unconfirmed' } });
  const refreshed = model.applyAgentEvent(before, 'item/completed', {
    threadId: before.id, turnId: 'turn-old', item: user('actual'),
  });
  assert.equal(refreshed.turns[0].items.at(-1).delivery, undefined);
});

test('a real turn event replaces the optimistic receipt without duplicate messages', () => {
  const before = thread();
  const accepted = model.applyAcceptedUserMessage(before, {
    text: draft, commandId: 'test-command', ...model.userMessageDeliveryBaseline(before, draft),
  });
  const refreshed = model.applyAgentEvent(accepted, 'turn/started', {
    threadId: before.id, turn: { id: 'turn-new', status: 'inProgress', items: [user('actual')] },
  });
  assert.equal(refreshed.turns.flatMap(t => t.items).filter(i => model.userMessageText(i) === draft).length, 1);
  assert.equal(refreshed.turns.flatMap(t => t.items).some(i => i.delivery), false);
});
