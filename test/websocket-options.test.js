import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket, { WebSocketServer } from 'ws';
import { AGENT_WEBSOCKET_OPTIONS } from '../src/websocket-options.js';

test('Agent WebSocket negotiates bounded per-message compression for large transcripts', async (t) => {
  assert.equal(AGENT_WEBSOCKET_OPTIONS.perMessageDeflate.threshold, 4 * 1024);
  assert.equal(AGENT_WEBSOCKET_OPTIONS.perMessageDeflate.serverNoContextTakeover, true);
  assert.equal(AGENT_WEBSOCKET_OPTIONS.perMessageDeflate.clientNoContextTakeover, true);

  const server = http.createServer();
  const wss = new WebSocketServer({ server, ...AGENT_WEBSOCKET_OPTIONS });
  let client;
  t.after(async () => {
    client?.terminate();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const peerConnected = once(wss, 'connection');
  client = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
  await once(client, 'open');
  const [peer] = await peerConnected;

  assert.match(client.extensions, /permessage-deflate/);
  assert.match(peer.extensions, /permessage-deflate/);
  const payload = '移动端会话正文\n'.repeat(8_000);
  const received = once(client, 'message');
  peer.send(payload);
  const [message] = await received;
  assert.equal(String(message), payload);
});
