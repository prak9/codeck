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
  ' YOLO Shift+Tab to Auto Mode',
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
  let composer = screen;
  f.setComposer = value => { composer = value; };
  const agentRegistry = new AgentRegistry({ qodercli: backend }, {
    interruptTmuxSession: async params => { session.hasRunningProcess = false; if (params.stopBackground) session.agent.hasBackgroundProcess = false; },
    sendTmuxMessage: params => sendSessionMessage(params, {
      listTmuxSessions: async () => [session], capturePane: async () => composer,
      loadBuffer: async (_name, text) => {
        const reserved = f.stored().exchange;
        assert.ok(reserved.commandId); assert.ok(reserved.deliveryBaseline.inputLog);
        f.writes.push(text);
      }, execTmux: async args => {
        if (args.includes('paste-buffer')) composer = screen.replace(' > \x1b[7m \x1b[0m Type your message or @path/to/file',
          ` > [Pasted Text: ${f.writes.at(-1).split('\n').length} lines]`);
        if (args.includes('Enter')) composer = screen;
      },
      waitForPaste: async () => {}, waitForSubmit: async () => {},
    }),
  });
  f.registry = agentRegistry;
  let options;
  const code = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  vm.runInNewContext(code.slice(code.indexOf('const autonomy = new AutonomyController('), code.indexOf('const sessionFeed =')), {
    AutonomyController: function (value) { options = value; }, path, os,
    extractDefinition: async () => ({ fieldsVersion: 5 }),
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


const answers = { goal: ['修复输入'], strategy: ['复现修复'], acceptance: ['测试通过'], budget: [''], constraints: [''] };
async function startWork(f) {
  await f.manager.start(target);
  await f.manager.respond(target, { requestId: f.state().requestId, answers });
  await f.manager.tick();
  assert.equal(f.state().status, 'running', JSON.stringify(f.state()));
}
async function poll(f) {
  await f.manager.tick();
  await Promise.all([...f.backend.openReads.values()]);
  await f.manager.tick();
}

test('real Qoder adapter requires receipt, not an empty composer; A creates fresh setup after failure', async t => {
  const f = await fixture(t); await startWork(f);
  assert.equal(f.writes.length, 1);
  const saved = f.stored().exchange;
  assert.equal(saved.commandId, saved.nonce); assert.ok(saved.deliveryBaseline.inputLog);
  f.now += 30001; await poll(f);
  assert.equal(f.state().status, 'error'); assert.match(f.state().reason, /未确认送达/);
  await Promise.all([f.manager.start(target), f.manager.start(target)]); await poll(f);
  assert.equal(f.state().status, 'configuring'); assert.equal(f.state().setup, true);
  assert.equal(f.writes.length, 1, 'opening fresh setup never replays old work');
  const requestId = f.state().requestId;
  await f.manager.respond(target, { requestId, answers });
  await assert.rejects(f.manager.respond(target, { requestId, answers }));
  await poll(f); assert.equal(f.writes.length, 2); assert.notEqual(f.stored().exchange.nonce, saved.nonce);
});

test('Qoder input-log receipt acknowledges delivery while foreground work remains busy', async t => {
  const f = await fixture(t); await startWork(f);
  const saved = f.stored().exchange;
  fs.mkdirSync(path.dirname(saved.deliveryBaseline.inputLog.file), { recursive: true });
  fs.writeFileSync(saved.deliveryBaseline.inputLog.file, JSON.stringify([
    { sessionId: threadId, type: 'user', messageId: 1, timestamp: new Date().toISOString(), message: saved.text },
  ]));
  f.session.hasRunningProcess = true; f.now += 30001; await poll(f);
  assert.equal(f.state().status, 'running'); assert.ok(f.stored().exchange.receivedAt);
  assert.equal(f.writes.length, 1);
});

test('Qoder restart discards active exchange and requires a new explicit setup and approval', async t => {
  const f = await fixture(t); await startWork(f); const saved = f.stored().exchange;
  f.manager.close(); f.manager = new AutonomyController(f.options);
  await poll(f); assert.equal(f.state().status, 'off'); assert.equal(f.writes.length, 1);
  assert.equal(f.stored().exchange, null);
  await f.manager.start(target); await poll(f); assert.equal(f.writes.length, 1);
  assert.equal(f.state().setup, true); assert.notEqual(f.state().requestId, saved.nonce);
});
