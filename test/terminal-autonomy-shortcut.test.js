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
  f.click = () => f.button.listeners.click();
  f.ready = async () => { f.ui.ready({ autonomySessionBinding: true }); await new Promise(resolve => setImmediate(resolve)); };
  return f;
}

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

test('yellow ended, red and green A reset once instead of sending another planning prompt', async () => {
  for (const status of ['ended', 'error', 'completed']) {
    const f = fixture(); await f.ready();
    f.ui.update({ id: 'run', target: f.target, mode: 'observed', status, round: 0 });
    await f.click();
    assert.equal(f.calls.at(-1).type, 'resetAutonomy');
    assert.equal(f.calls.some(call => call.type === 'sendSessionMessage'), false);
  }
});
