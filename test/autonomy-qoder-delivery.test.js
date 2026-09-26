import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { AutonomyController } from '../src/autonomy.js';
import { AgentHub, AgentRegistry } from '../src/agent-connection.js';
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
  f.options = { file: path.join(root, 'autonomy.json'), now: () => f.now, schedule: () => 1, cancel() {},
    readSession: async () => session, stop: async () => { throw Error('planning must not interrupt'); },
    send: async () => { throw Error('no automatic dispatch'); } };
  f.manager = new AutonomyController(f.options); t.after(() => f.manager.close());
  f.state = () => f.manager.snapshot(target);
  const hub = new AgentHub(agentRegistry, { autonomy: f.manager });
  const socket = new EventEmitter(); socket.readyState = 1; const replies = [];
  socket.send = raw => replies.push(JSON.parse(raw)); hub.handleConnection(socket);
  let id = 0;
  f.request = async (type, params = {}) => {
    const requestId = ++id;
    socket.emit('message', JSON.stringify({ id: requestId, type, ...target, ...params }));
    for (let attempt = 0; attempt < 200; attempt++) {
      const reply = replies.find(message => message.id === requestId);
      if (reply) return reply;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw Error('missing RPC response');
  };
  t.after(() => socket.emit('close'));
  await f.request('bindAutonomySession');
  return f;
}


async function sendPlan(f) {
  const preparation = await f.request('prepareAutonomyPlanning', { commandId: 'qoder-plan-prepare' });
  assert.equal(preparation.ok, true);
  const { text, planningId } = preparation.result;
  const params = { commandId: 'qoder-plan-submit', text, planningId };
  const response = await f.request('sendSessionMessage', params);
  assert.equal(response.ok, true, JSON.stringify(response));
  return { response, params };
}

test('Qoder A uses ordinary delivery and never equates an empty composer with received input', async t => {
  const f = await fixture(t); const { response, params } = await sendPlan(f);
  assert.equal(response.result.submissionStatus, 'attempted');
  assert.equal(f.writes.length, 1); assert.equal(f.state().status, 'planning');
  assert.equal((await f.request('sendSessionMessage', params)).ok, true);
  f.now += 30001; await f.manager.tick();
  assert.equal(f.writes.length, 1, 'neither cached RPC retry nor polling replays the plan');
  assert.equal(f.state().status, 'planning', 'delivery is not a started receipt');
  const receipt = f.backend.readReceipts.get(params.commandId);
  assert.equal(receipt.text, params.text); assert.equal(receipt.submissionStatus, 'unconfirmed');
  assert.ok(receipt.deliveryBaseline.inputLog);
});

test('Qoder observation restart sends no input and keeps the pending plan', async t => {
  const f = await fixture(t); await sendPlan(f); const id = f.state().id;
  f.manager.close(); f.manager = new AutonomyController(f.options);
  await f.manager.tick(); assert.equal(f.state().status, 'planning'); assert.equal(f.state().id, id);
  assert.equal(f.writes.length, 1);
});
