import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRemoteSessionPayload,
  findCreatedRemoteSession,
  nextThreadAfterClose,
  suggestedRemoteSessionName,
} from '../public/remote-session.js';

test('remote session creation preserves the chosen tmux name and Agent', () => {
  assert.deepEqual(createRemoteSessionPayload({
    name: 'research-ui',
    provider: 'qodercli',
    cwd: '  /srv/research  ',
  }), {
    name: 'research-ui',
    client: 'qodercli',
    cwd: '/srv/research',
  });
});

test('remote session creation rejects names tmux cannot safely address', () => {
  for (const name of ['', '-bad', 'two words', 'x;whoami', 'a'.repeat(65)]) {
    assert.throws(
      () => createRemoteSessionPayload({ name, provider: 'codex', cwd: '/srv/codeck' }),
      /会话名/,
    );
  }
  assert.throws(
    () => createRemoteSessionPayload({ name: 'work', provider: 'codex', cwd: 'relative/path' }),
    /绝对路径/,
  );
});

test('remote session creation supports native resume and plain Shell without a resume mode', () => {
  for (const provider of ['codex', 'claude', 'qodercli']) {
    assert.deepEqual(createRemoteSessionPayload({ name: 'work', provider, mode: 'resume' }), {
      name: 'work', client: provider, mode: 'resume',
    });
  }
  assert.deepEqual(createRemoteSessionPayload({ name: 'console', provider: 'shell', mode: 'new' }), {
    name: 'console', client: 'shell',
  });
  assert.throws(() => createRemoteSessionPayload({ name: 'work', provider: 'shell', mode: 'resume' }), /Shell/);
  for (const mode of ['other', '', null, true]) {
    assert.throws(() => createRemoteSessionPayload({ name: 'work', provider: 'codex', mode }), /启动模式/);
  }
});

test('remote session suggestions avoid existing tmux names', () => {
  const now = { getHours: () => 15, getMinutes: () => 7 };
  assert.equal(suggestedRemoteSessionName('claude', [], now), 'claude-1507');
  assert.equal(
    suggestedRemoteSessionName('claude', ['claude-1507', 'claude-1507-2'], now),
    'claude-1507-3',
  );
});

test('a newly created session waits for the requested Agent identity', () => {
  const threads = [
    { provider: 'shell', tmux: { name: 'research-ui' } },
    { provider: 'qodercli', tmux: { name: 'research-ui', available: false } },
  ];
  assert.equal(findCreatedRemoteSession(threads, 'research-ui', 'qodercli'), threads[1]);
  assert.equal(findCreatedRemoteSession(threads, 'research-ui', 'claude'), null);
});

test('closing a remote session selects its nearest remaining neighbor', () => {
  const threads = [
    { id: 'one', tmux: { name: 'one' } },
    { id: 'two', tmux: { name: 'two' } },
    { id: 'three', tmux: { name: 'three' } },
  ];

  assert.equal(nextThreadAfterClose(threads, 'two'), threads[2]);
  assert.equal(nextThreadAfterClose(threads, 'three'), threads[1]);
  assert.equal(nextThreadAfterClose(threads, 'one'), threads[1]);
  assert.equal(nextThreadAfterClose(threads, 'missing'), null);
  assert.equal(nextThreadAfterClose([], 'one'), null);
});
