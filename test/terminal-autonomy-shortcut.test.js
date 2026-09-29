import test from 'node:test';
import assert from 'node:assert/strict';
import { createTerminalAutonomy } from '../public/terminal-autonomy.js';
import { AUTONOMY_PLANNING_PROMPT } from '../public/remote-autonomy.js';

function fixture() {
  const nodes = new Map();
  const document = { getElementById(id) {
    if (!nodes.has(id)) nodes.set(id, { hidden: false, disabled: false, dataset: {},
      attributes: {}, listeners: {}, setAttribute(k, v) { this.attributes[k] = v; },
      addEventListener(k, fn) { this.listeners[k] = fn; } });
    return nodes.get(id);
  } };
  const f = { calls: [], focused: false, target: { provider: 'qodercli', threadId: 'thread', tmuxSession: 'work' } };
  f.ui = createTerminalAutonomy({ document, getTarget: () => f.target, focusTerminal: () => { f.focused = true; },
    request: async (type, args) => { f.calls.push({ type, args });
      if (type === 'prepareAutonomyPlanning') return { text: AUTONOMY_PLANNING_PROMPT, planningId: 'planning-id' };
      if (type === 'sendSessionMessage') return f.send?.() || { submissionStatus: 'submitted' };
      return {};
    } });
  f.button = document.getElementById('terminalAutonomyButton');
  f.notice = document.getElementById('terminalAutonomyNotice');
  f.summary = document.getElementById('terminalAutonomySummary');
  f.confirm = document.getElementById('terminalConfirmButton');
  f.cancel = document.getElementById('terminalCancelButton');
  f.click = () => f.button.listeners.click();
  f.ready = async () => { f.ui.ready({ autonomySessionBinding: true }); await new Promise(resolve => setImmediate(resolve)); };
  return f;
}

test('terminal never shows old blocked, stopped or error results as a completed summary', async () => {
  const f = fixture(); await f.ready();
  for (const status of ['ended', 'error', 'off', 'planning', 'running', 'exiting']) {
    f.ui.update({ id: 'old-run', target: f.target, status, reason: '任务受阻',
      plan: { goal: '尚未完成的实验' }, summary: '后台任务继续运行', next: '等待结果' });
    assert.equal(f.summary.hidden, true, status);
  }
});

test('terminal A sends the approved prompt once while pending, without configuration or extraction', async () => {
  const f = fixture(); await f.ready(); let release;
  f.send = () => new Promise(resolve => { release = resolve; });
  const first = f.click(); await f.click();
  await new Promise(resolve => setImmediate(resolve));
  const sends = f.calls.filter(call => call.type === 'sendSessionMessage');
  assert.equal(sends.length, 1); assert.equal(sends[0].args.text, AUTONOMY_PLANNING_PROMPT);
  assert.match(sends[0].args.text, /^请基于最近的讨论，使用 iterate skill，为我规划一个自主迭代任务。/);
  assert.equal(f.calls.some(call => ['startAutonomy', 'answerAutonomy'].includes(call.type)), false);
  assert.equal(sends[0].args.planningId, 'planning-id');
  release({ submissionStatus: 'submitted' }); await first;
  assert.equal(f.button.disabled, false);
  assert.equal(f.button.attributes['aria-pressed'], 'false');
});

test('terminal A does not send into a native selector or a disconnected session', async () => {
  const f = fixture(); await f.ready(); f.target.question = { id: 'pending' };
  await f.click(); assert.equal(f.focused, true);
  delete f.target.question; f.ui.disconnect(); await f.click();
  assert.equal(f.calls.filter(call => call.type === 'sendSessionMessage').length, 0);
});

test('uncertain planning delivery warns without resending; stale errors cannot affect another session', async () => {
  const f = fixture(); await f.ready(); f.send = async () => ({ submissionStatus: 'unconfirmed' });
  await f.click(); assert.match(f.notice.textContent, /未确认/);
  let reject; f.send = () => new Promise((_resolve, fail) => { reject = fail; });
  const pending = f.click(); await new Promise(resolve => setImmediate(resolve));
  f.target = { ...f.target, threadId: 'another' }; f.ui.sync();
  reject(Error('old failure')); await pending;
  assert.notEqual(f.notice.textContent, 'old failure');
});

test('finished runs start a new plan on the first click', async () => {
  for (const status of ['ended', 'error']) {
    const f = fixture(); await f.ready();
    f.ui.update({ id: 'run', target: f.target, mode: 'observed', status, round: 0 });
    await f.click();
    assert.equal(f.calls.at(-1).type, 'sendSessionMessage');
    assert.equal(f.calls.some(call => call.type === 'resetAutonomy'), false);
  }
});

test('completed A exits without sending a new planning message', async () => {
  const f = fixture(); await f.ready();
  f.ui.update({ id: 'done', target: f.target, status: 'completed' });
  await f.click();
  assert.equal(f.calls.at(-1).type, 'resetAutonomy');
  assert.equal(f.calls.some(call => call.type === 'prepareAutonomyPlanning' || call.type === 'sendSessionMessage'), false);
});

test('planning offers confirm and cancel; running offers only yellow A', async () => {
  const f = fixture(); await f.ready();
  f.ui.update({ id: 'plan', target: f.target, status: 'planning', planReady: true });
  assert.equal(f.button.hidden, true);
  assert.equal(f.confirm.hidden, false); assert.equal(f.cancel.hidden, false);
  await f.confirm.listeners.click();
  assert.equal(f.calls.at(-1).type, 'confirmAutonomy');
  assert.equal(f.calls.at(-1).args.planningId, 'plan');
  await f.cancel.listeners.click(); assert.equal(f.calls.at(-1).type, 'resetAutonomy');
  f.ui.update({ id: 'plan', target: f.target, status: 'running' });
  assert.equal(f.button.hidden, false); assert.equal(f.button.dataset.tone, 'running');
  assert.equal(f.confirm.hidden, true); assert.equal(f.cancel.hidden, true);
  await f.click(); assert.equal(f.calls.at(-1).type, 'resetAutonomy');
});
