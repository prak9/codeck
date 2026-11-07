import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRoute } from '../src/telegram-routing.js';
const sessions = [{ name: 'research', cwd: '/work/research', agent: { kind: 'codex', id: 'one' } },
  { name: 'report', cwd: '/work/report', agent: { kind: 'qodercli', id: 'two' } }];
const context = { text: '让 research 继续，看看 report 进展', sessions, selected: null };
const action = (kind, session = null, text = null, cwd = null, provider = null) => ({ kind, session, text, cwd, provider });
test('model plans resolve exact existing identities and preserve independent actions', () => {
  const route = validateRoute({ clarification: null, actions: [action('send', 'research', '继续当前任务'), action('status', 'report')] }, context);
  assert.equal(route.actions[0].target.threadId, 'one'); assert.equal(route.actions[1].target.threadId, 'two');
  assert.throws(() => validateRoute({ clarification: null, actions: [action('send', 'missing', 'go')] }, context));
});
test('clarification performs no actions and new tasks cannot invent directories or CLI providers', () => {
  assert.equal(validateRoute({ clarification: '你指哪个项目？', actions: [] }, context).actions.length, 0);
  assert.throws(() => validateRoute({ clarification: '哪个？', actions: [action('stop', 'research')] }, context));
  assert.throws(() => validateRoute({ clarification: null, actions: [action('create', null, 'work', '/invented')] }, context));
  assert.throws(() => validateRoute({ clarification: null, actions: [action('create', null, 'work', null, 'shell')] }, context));
  const route = validateRoute({ clarification: null, actions: [action('create', null, '研究 XX', '/work/research')] }, context);
  assert.equal(route.actions[0].provider, 'codex');
});
