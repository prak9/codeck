import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { AutonomyController } from '../src/autonomy.js';
import { AgentRegistry } from '../src/agent-connection.js';
import { QoderAgentBackend } from '../src/qoder-agent-backend.js';
import { sendSessionMessage } from '../src/tmux.js';

const threadId = '11111111-1111-4111-8111-111111111111';
const target = { provider: 'qodercli', threadId, tmuxSession: 'qoder' };
const screen = ['────────────────────────────────────────',
  ' YOLO Shift+Tab to Auto Mode · 2 Background tasks',
  '────────────────────────────────────────', ' > \x1b[7m \x1b[0m Type your message or @path/to/file',
  '────────────────────────────────────────', ' Ultimate Model · /fixture'].join('\n');

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeck-autonomy-qoder-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'projects', '-fixture', `${threadId}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ type: 'user', uuid: 'old', sessionId: threadId, cwd: '/fixture',
    message: { role: 'user', content: 'Previous work' } }) + '\n');
  const backend = new QoderAgentBackend({ configDir: root });
  t.after(() => backend.close());
  const session = { name: 'qoder', hasRunningProcess: true,
    agent: { kind: 'qodercli', id: threadId, paneId: '%7', hasBackgroundProcess: true } };
  const f = { root, file, backend, session, now: 100000, writes: [] };
  const agentRegistry = new AgentRegistry({ qodercli: backend }, {
    sendTmuxMessage: params => sendSessionMessage(params, {
      listTmuxSessions: async () => [session], capturePane: async () => screen,
      loadBuffer: async (_name, text) => {
        const reserved = f.stored().exchange;
        assert.ok(reserved.commandId); assert.ok(reserved.deliveryBaseline.inputLog);
        f.writes.push(text);
      }, execTmux: async () => {},
      waitForPaste: async () => {}, waitForSubmit: async () => {},
    }),
  });
  f.registry = agentRegistry;
  let options;
  const code = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  vm.runInNewContext(code.slice(code.indexOf('const autonomy = new AutonomyController('), code.indexOf('const sessionFeed =')), {
    AutonomyController: function (value) { options = value; }, path, os,
    process: { env: { CODECK_DATA_DIR: root } }, agentRegistry,
    listSessions: async () => [session], invalidateSessionSnapshots: async () => {},
  });
  f.options = { ...options, now: () => f.now, schedule: () => 1, cancel() {} };
  f.manager = new AutonomyController(f.options);
  t.after(() => f.manager.close());
  f.state = () => f.manager.snapshot(target);
  f.stored = () => JSON.parse(fs.readFileSync(path.join(root, 'autonomy.json'))).runs[0];
  return f;
}

test('real Qoder adapter: composer clears but no input or transcript receipt means timeout, not success', async t => {
  const f = await fixture(t);
  await f.manager.start(target); await f.manager.tick();
  assert.equal(f.writes.length, 1); assert.match(f.writes[0], /\n.*codeck-autonomy-context/);
  const saved = f.stored().exchange;
  assert.equal(saved.commandId, saved.nonce); assert.ok(saved.deliveryBaseline.inputLog);
  await f.manager.tick(); f.now += 30001; await f.manager.tick();
  assert.equal(f.state().status, 'paused'); assert.match(f.state().reason, /未确认送达/);
  await f.manager.start(target); await f.manager.tick();
  assert.equal(f.state().status, 'paused'); assert.equal(f.writes.length, 1, 'resume never replays a possibly delivered message');
});

test('restart rehydrates Qoder input receipt without replay and still bounds missing configuration replies', async t => {
  const f = await fixture(t); await f.manager.start(target); await f.manager.tick();
  const saved = f.stored().exchange;
  f.manager.close();
  // Simulate loss of in-memory backend receipts during a service restart.
  f.backend.close();
  f.backend = new QoderAgentBackend({ configDir: f.root });
  f.registry.backends.set('qodercli', f.backend);
  t.after(() => f.backend.close());
  fs.mkdirSync(path.dirname(saved.deliveryBaseline.inputLog.file), { recursive: true });
  fs.writeFileSync(saved.deliveryBaseline.inputLog.file, JSON.stringify([
    { sessionId: threadId, type: 'user', messageId: 1, timestamp: new Date().toISOString(), message: saved.text },
  ]));
  f.manager = new AutonomyController(f.options);
  assert.equal(f.state().status, 'paused');
  await f.manager.start(target); await f.manager.tick();
  // Cold worker reads may publish one historyLoading frame before their result.
  if (!f.stored().exchange.receivedAt) {
    await Promise.all([...f.backend.openReads.values()]); await f.manager.tick();
  }
  assert.equal(f.stored().exchange.receivedAt, f.now);
  assert.equal(f.writes.length, 1);
  f.now += 120001; await f.manager.tick();
  assert.equal(f.state().status, 'paused'); assert.match(f.state().reason, /配置回复/);
  assert.equal(f.writes.length, 1);
});

test('real Qoder transcript restores late configuration choices while old work stays busy, without new sends', async t => {
  const f = await fixture(t); await f.manager.start(target); await f.manager.tick();
  const saved = f.stored().exchange;
  f.now += 30001; await f.manager.tick(); assert.equal(f.state().status, 'paused');
  const records = [
    { type: 'user', uuid: 'config-user', parentUuid: 'old', sessionId: threadId, cwd: '/fixture',
      message: { role: 'user', content: saved.text } },
    { type: 'assistant', uuid: 'config-answer', parentUuid: 'config-user', sessionId: threadId,
      message: { id: 'answer', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text',
        text: '请选择\n\n```codeck-autonomy\n' + JSON.stringify({ nonce: saved.nonce, status: 'ask', questions: [
          { id: 'goal', header: '目标', question: '推进哪项？', options: ['修复', '研究'] },
        ] }) + '\n```' }] } },
  ];
  fs.appendFileSync(f.file, records.map(record => JSON.stringify(record)).join('\n') + '\n');
  // The session's refreshed thread stream recovers a late reply after timeout.
  const fresh = await f.backend.read('open', { threadId });
  f.manager.restoreProposal(target, fresh.thread);
  assert.equal(f.state().status, 'configuring');
  assert.equal(f.state().questions[0].id, 'goal'); assert.ok(f.state().requestId);
  assert.equal(f.state().round, 0); assert.equal(f.writes.length, 1);
});
