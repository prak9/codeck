import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { WebSocketServer } from 'ws';
import { loadTlsOptions } from '../src/tls.js';
import { AgentRegistry, AgentHub } from '../src/agent-connection.js';
import { sessionRpc } from '../src/session-rpc.js';

test('Telegram transport uses authenticated TLS AgentHub commands and subscribes before native answers', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codeck-session-rpc-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const tls = loadTlsOptions({ CODECK_DATA_DIR: directory });
  const calls = [];
  const backend = new EventEmitter(); backend.openThread = async () => ({ thread: { id: 'thread', turns: [] } });
  const registry = new AgentRegistry({ qodercli: backend }, {
    sendTmuxMessage: async payload => { calls.push(['send', payload]); return { submissionStatus: 'submitted' }; },
    answerTmuxQuestion: async payload => { calls.push(['answer', payload]); return { answered: true }; },
  });
  const hub = new AgentHub(registry);
  const server = https.createServer(tls);
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    assert.equal(req.headers['sec-websocket-protocol'], `codeck.${Buffer.from('test-owner').toString('base64url')}`);
    wss.handleUpgrade(req, socket, head, ws => hub.handleConnection(ws));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const client of wss.clients) client.terminate(); wss.close(); await new Promise(resolve => server.close(resolve)); });
  const connection = { url: `https://127.0.0.1:${server.address().port}`, ca: String(tls.cert), token: 'test-owner' };
  const target = { provider: 'qodercli', threadId: 'thread', tmuxSession: 'fixture' };
  await sessionRpc(connection, { type: 'sendSessionMessage', ...target, text: 'work', commandId: 'telegram-test-1' });
  await sessionRpc(connection, { type: 'sendSessionMessage', ...target, text: 'work', commandId: 'telegram-test-1' });
  assert.equal(calls.filter(c => c[0] === 'send').length, 1);
  await sessionRpc(connection, { type: 'answerSessionQuestion', ...target, questionId: 'question', answer: '继续' }, { subscribe: true });
  assert.equal(calls.at(-1)[1].questionId, 'question');
  assert.equal(calls.at(-1)[1].sessionName, 'fixture');
});
