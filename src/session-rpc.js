import WebSocket from 'ws';

// Use the same owner-authenticated AgentHub path as Remote, including its
// identity checks, pane queues, command receipts, and stale-question guards.
export function sessionRpc(config, request, { subscribe = false, timeout = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL('/agent', config.url); url.protocol = 'wss:';
    const socket = new WebSocket(url, [`codeck.${Buffer.from(config.token).toString('base64url')}`], { ca: config.ca });
    let settled = false, sent = false;
    const timer = setTimeout(() => finish(new Error('请求超时；请核实结果，勿重复发送')), timeout);
    function finish(error, result) {
      if (settled) return;
      settled = true; clearTimeout(timer); socket.close();
      if (error) reject(error); else resolve(result);
    }
    socket.on('error', error => finish(error));
    socket.on('close', () => finish(new Error('连接断开，操作结果待核实')));
    socket.on('message', bytes => {
      let m; try { m = JSON.parse(String(bytes)); } catch { return; }
      if (m.type === 'ready' && !sent) {
        sent = true;
        socket.send(JSON.stringify(subscribe ? { type: 'openThread', provider: request.provider, threadId: request.threadId,
          tmuxSession: request.tmuxSession, readOnly: true, id: 1 } : { ...request, id: 2 }));
      } else if (m.id === 1) {
        if (!m.ok) finish(new Error(m.error || '会话读取失败'));
        else socket.send(JSON.stringify({ ...request, id: 2 }));
      } else if (m.id === 2) finish(m.ok ? null : new Error(m.error || '操作失败'), m.result);
    });
  });
}
