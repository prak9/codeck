import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexAppServer } from '../src/codex-app-server.js';

class FakeProcess extends EventEmitter {
  constructor() {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.messages = [];
    this.stdin = {
      destroyed: false,
      write: (chunk) => {
        for (const line of String(chunk).trim().split('\n')) {
          if (line) this.messages.push(JSON.parse(line));
        }
        return true;
      },
      end: () => { this.stdin.destroyed = true; },
    };
    this.killed = false;
  }

  answer(id, result) {
    this.stdout.write(`${JSON.stringify({ id, result })}\n`);
  }

  kill() {
    this.killed = true;
    this.emit('close', 0, null);
  }
}

async function waitFor(check) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('condition was not reached');
}

async function initialize(appServer, process) {
  const request = appServer.request('thread/list', { limit: 1 });
  await waitFor(() => process.messages.length === 1);
  assert.equal(process.messages[0].method, 'initialize');
  assert.equal(process.messages[0].params.clientInfo.name, 'codeck');
  assert.equal(process.messages[0].params.capabilities.experimentalApi, true);
  process.answer(process.messages[0].id, { serverInfo: { name: 'codex' } });
  await waitFor(() => process.messages.length === 3);
  assert.deepEqual(process.messages[1], { method: 'initialized', params: {} });
  return { request };
}

test('initializes once and exchanges JSON-RPC requests over stdio', async () => {
  const process = new FakeProcess();
  const appServer = new CodexAppServer({ spawnProcess: () => process });
  const { request } = await initialize(appServer, process);

  assert.equal(process.messages[2].method, 'thread/list');
  assert.deepEqual(process.messages[2].params, { limit: 1 });
  process.answer(process.messages[2].id, { data: [{ id: 'thread-1' }] });
  assert.deepEqual(await request, { data: [{ id: 'thread-1' }] });

  const second = appServer.request('thread/read', { threadId: 'thread-1' });
  await waitFor(() => process.messages.length === 4);
  assert.equal(process.messages.filter((message) => message.method === 'initialize').length, 1);
  process.answer(process.messages[3].id, { thread: { id: 'thread-1' } });
  assert.deepEqual(await second, { thread: { id: 'thread-1' } });
  appServer.close();
});

test('emits notifications and lets the host answer server requests', async () => {
  const process = new FakeProcess();
  const appServer = new CodexAppServer({ spawnProcess: () => process });
  const { request: list } = await initialize(appServer, process);
  process.answer(process.messages[2].id, { data: [] });
  await list;

  const notifications = [];
  const requests = [];
  appServer.on('notification', (message) => notifications.push(message));
  appServer.on('serverRequest', (message) => requests.push(message));
  process.stdout.write('{"method":"turn/started","params":{"threadId":"thread-1"}}\n');
  process.stdout.write('{"id":91,"method":"item/commandExecution/requestApproval","params":{"threadId":"thread-1"}}\n');
  await waitFor(() => notifications.length === 1 && requests.length === 1);

  assert.equal(notifications[0].method, 'turn/started');
  assert.equal(requests[0].id, 91);
  await appServer.respond(91, { decision: 'accept' });
  assert.deepEqual(process.messages.at(-1), { id: 91, result: { decision: 'accept' } });
  await appServer.respondError(92, -32601, 'Unsupported server request');
  assert.deepEqual(process.messages.at(-1), {
    id: 92,
    error: { code: -32601, message: 'Unsupported server request' },
  });
  appServer.close();
});

test('rejects pending requests when the app-server exits', async () => {
  const process = new FakeProcess();
  const appServer = new CodexAppServer({ spawnProcess: () => process });
  const { request } = await initialize(appServer, process);
  process.emit('close', 17, null);
  await assert.rejects(request, /exited.*17/i);
});
