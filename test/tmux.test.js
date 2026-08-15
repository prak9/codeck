import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSessions, validateClient, validateSessionName } from '../src/tmux.js';

test('parses tmux list output into typed session records', () => {
  assert.deepEqual(parseSessions('agent-one\t2\t1\t100\t200\n'), [{
    name: 'agent-one', windows: 2, attached: 1, createdAt: 100000, activityAt: 200000,
  }]);
});

test('empty tmux output produces an empty list', () => assert.deepEqual(parseSessions(''), []));

test('accepts safe session names and known clients', () => {
  assert.equal(validateSessionName('feature_auth-2.0'), true);
  assert.equal(validateClient('codex'), true);
  assert.equal(validateClient('qodercli'), true);
});

test('rejects names that could become tmux or shell arguments', () => {
  for (const name of ['', '-bad', 'two words', 'x;whoami', 'a'.repeat(65)]) assert.equal(validateSessionName(name), false);
  assert.equal(validateClient('bash -c whoami'), false);
});
