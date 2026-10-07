import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

for (const remote of [true, false]) {
  test(`${remote ? 'remote' : 'normal feed'} replaces a silent socket without replaying requests`, () => {
    const source = fs.readFileSync(new URL(`../public/${remote ? 'remote' : 'app'}.js`, import.meta.url), 'utf8');
    const name = remote ? 'connectSocket' : 'connectSessionFeed';
    const start = source.indexOf(`function ${name}()`);
    const end = source.indexOf('\n}\n', start) + 2;
    const sockets = [], probes = [], received = [];
    class Socket extends EventTarget {
      static OPEN = 1;
      readyState = 1;
      sent = [];
      constructor() { super(); sockets.push(this); }
      send(data) { this.sent.push(data); }
      close() { this.readyState = 3; }
    }
    const state = { token: 'test', canManage: true, socketGeneration: 0, sessionFeedGeneration: 0 };
    const context = vm.createContext({
      state, WebSocket: Socket, location: { protocol: 'https:', host: 'example.test' },
      websocketProtocolToken: value => value, clearTimeout() {},
      rejectPendingRequests() {}, rejectSessionFeedRequests() {}, setConnectionStatus() {},
      syncTerminalProgressButton() {}, terminalAutonomy: { disconnect() {} },
      handleSocketMessage: message => received.push(message),
      bindTerminalHeartbeat(socket, timeout, options) {
        assert.equal(options.textFrames, true);
        const probe = { socket, timeout, cancelled: false };
        probes.push(probe);
        return () => { probe.cancelled = true; };
      },
    });
    vm.runInContext(source.slice(start, end), context);
    vm.runInContext(`${name}()`, context);
    const pong = new Event('message');
    pong.data = JSON.stringify({ type: 'pong', id: 1 });
    sockets[0].dispatchEvent(pong);
    assert.deepEqual(received, []);
    probes[0].timeout();
    assert.equal(sockets.length, 2);
    assert.equal(sockets[0].readyState, 3);
    assert.equal(probes[0].cancelled, true);
    assert.deepEqual(sockets[1].sent, []);
    probes[0].timeout();
    assert.equal(sockets.length, 2, 'stale timeout cannot replace the new connection');
  });
}
