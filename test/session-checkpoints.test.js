import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCheckpoints } from '../src/session-checkpoints.js';
test('progress and attention survive restart, cannot leak into a replacement session, and reads do not send inputs', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'checkpoints-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'state.json');
  let store = await createCheckpoints(file);
  const session = { name: 'research', createdAt: 1, agent: { id: 'thread', kind: 'codex' }, status: 'working' };
  await store.observe([session]);
  await store.set(session, { text: '复现完成，正在验证', attention: false });
  await store.observe([{ ...session, status: 'done' }]);
  assert.equal(store.get(session).attention.kind, 'ended');
  const id = store.get(session).attention.id;
  store = await createCheckpoints(file);
  assert.equal(store.get(session).text, '复现完成，正在验证');
  await store.ack(session, 'stale');
  assert.equal(store.get(session).attention.id, id);
  await store.ack(session, id);
  assert.equal(store.get(session).attention, null);
  assert.equal(store.get({ ...session, createdAt: 2 }), null);
});
test('cold idle is not a result; questions persist until resolved even when acknowledged', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'checkpoints-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = await createCheckpoints(path.join(dir, 'state.json'));
  const session = { name: 'x', createdAt: 1, agent: { id: 't', kind: 'qodercli' }, status: 'done' };
  await store.observe([session]); assert.equal(store.get(session)?.attention, null);
  const waiting = { ...session, agent: { ...session.agent, question: { id: 'q' } } };
  await store.observe([waiting]);
  const id = store.get(waiting).attention.id;
  await store.ack(waiting, id); assert.equal(store.get(waiting).attention.kind, 'question');
  await store.observe([session]); assert.equal(store.get(session).attention, null);
});

test('failed turns notify once; reading does not fabricate completion or replay old failures', async t => {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'checkpoints-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const store=await createCheckpoints(path.join(dir,'state.json'));
 const session={name:'failed',createdAt:1,agent:{id:'t',kind:'codex'},status:'done'};
 await store.observe([session]);
 const turn={id:'turn1',status:'failed'};await store.observeTurn(session,turn);
 assert.equal(store.get(session).attention.kind,'failed');
 await store.ack(session,store.get(session).attention.id);await store.observeTurn(session,turn);
 assert.equal(store.get(session).attention,null);
});
