import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSessions, supportsLargestSize, validateClient, validateSessionName } from '../src/tmux.js';

test('parses tmux list output into typed session records', () => {
  assert.deepEqual(parseSessions('agent-one\t2\t1\t100\t200\t180\t48\n'), [{
    name: 'agent-one', windows: 2, attached: 1, createdAt: 100000, activityAt: 200000, width: 180, height: 48,
  }]);
});

test('empty tmux output produces an empty list', () => assert.deepEqual(parseSessions(''), []));

test('uses largest-client sizing only when supported by tmux', () => {
  assert.equal(supportsLargestSize('tmux 2.7'), false);
  assert.equal(supportsLargestSize('tmux 2.8'), false);
  assert.equal(supportsLargestSize('tmux 2.9'), true);
  assert.equal(supportsLargestSize('tmux 3.4'), true);
});

test('accepts safe session names and known clients', () => {
  assert.equal(validateSessionName('feature_auth-2.0'), true);
  assert.equal(validateClient('codex'), true);
  assert.equal(validateClient('qodercli'), true);
});

test('rejects names that could become tmux or shell arguments', () => {
  for (const name of ['', '-bad', 'two words', 'x;whoami', 'a'.repeat(65)]) assert.equal(validateSessionName(name), false);
  assert.equal(validateClient('bash -c whoami'), false);
});
