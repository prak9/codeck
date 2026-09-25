import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { codexDefinition, sdkDefinition } from '../src/definition-model.js';

test('Codex extraction uses an ephemeral independent thread and closes its server', async () => {
  const server = new EventEmitter(), requests = []; let closed = false;
  server.close = () => { closed = true; };
  server.request = async (method, params) => {
    requests.push({ method, params });
    if (method === 'thread/start') return { thread: { id: 'extract-only' } };
    server.emit('notification', { method: 'item/completed', params: { threadId: 'unrelated', item: { type: 'agentMessage', text: 'wrong' } } });
    server.emit('notification', { method: 'item/completed', params: { threadId: 'extract-only', item: { type: 'agentMessage', text: 'model result' } } });
    server.emit('notification', { method: 'turn/completed', params: { threadId: 'extract-only', turn: { status: 'completed' } } });
    return {};
  };
  assert.equal(await codexDefinition({ prompt: 'input', cwd: '/tmp', signal: new AbortController().signal }, server), 'model result');
  assert.equal(requests[0].params.ephemeral, true); assert.equal(requests[0].params.sandbox, 'read-only');
  assert.deepEqual(requests[0].params.environments, []); assert.equal(requests[0].params.config['features.shell_tool'], false);
  assert.equal(requests[1].params.threadId, 'extract-only'); assert.equal(closed, true);
});

test('Codex cancellation kills only the independent server even before its first response', async () => {
  const server = new EventEmitter(), abort = new AbortController(); let closed = false;
  server.close = () => { closed = true; };
  server.request = (_method, _params, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  const work = codexDefinition({ prompt: 'input', cwd: '/tmp', signal: abort.signal }, server);
  abort.abort(); await assert.rejects(work); assert.equal(closed, true);
});

for (const provider of ['claude', 'qodercli']) test(`${provider} extraction disables tools, session persistence and project settings`, async () => {
  let options;
  async function* query(input) {
    options = input.options;
    yield { type: 'result', subtype: 'success', result: 'model result' };
  }
  const resolveSettings = async input => {
    assert.deepEqual(input.settingSources, ['user']);
    return { effective: { model: 'configured-model', env: { MODEL_ENDPOINT: 'fixture' }, hooks: { SessionStart: ['must not execute'] }, permissions: { allow: ['Bash'] } } };
  };
  assert.equal(await sdkDefinition({ provider, prompt: 'input', cwd: '/tmp', signal: new AbortController().signal }, query, resolveSettings), 'model result');
  assert.deepEqual(options.settings, { model: 'configured-model', env: { MODEL_ENDPOINT: 'fixture' } });
  assert.equal(options.persistSession, false); assert.equal(options.resume, undefined); assert.equal(options.maxTurns, 1);
  assert.deepEqual(options.tools, []); assert.deepEqual(options.settingSources, []);
  assert.equal((await options.canUseTool('Bash', {})).behavior, 'deny'); assert.equal(options.abortController.signal.aborted, true);
});

test('expired login remains an actionable failure, never a generated definition', async () => {
  async function* query() { yield { type: 'result', subtype: 'success', is_error: true, result: 'Failed to authenticate: OAuth session expired' }; }
  await assert.rejects(sdkDefinition({ provider: 'claude', prompt: 'input', cwd: '/tmp', signal: new AbortController().signal }, query), { code: 'MODEL_AUTH_REQUIRED' });
});
