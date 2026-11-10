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
  await store.set(session, { text: '复现完成，正在验证', attention: true });
  await store.observe([{ ...session, status: 'done' }]);
  assert.equal(store.get(session).attention.kind, 'review');
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

test('progress survives temporary identity loss and is archived explicitly for a new task', async t => {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'progress-record-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'state.json'),store=await createCheckpoints(file);
 const s={name:'research',createdAt:1,agent:{kind:'codex',id:'thread'},status:'working'};
 await store.set(s,{text:'正在验证',progress:{goal:'修复消息',verified:'复现完成',current:'回归中',next:'部署',needsUser:'',evidence:[{label:'验证页面',url:'/pages/example'}]}});
 const unknown={...s,agent:{kind:'codex',id:null}};await store.observe([unknown]);
 assert.equal(store.get(unknown).text,'正在验证');assert.equal(store.get(unknown).stale,true);
 assert.equal(store.get(s).progress.goal,'修复消息');
 const other={...s,agent:{kind:'codex',id:'new-thread'}};await store.observe([other]);assert.equal(store.get(other).stale,true);
 await store.observeTurn(s,{id:'failed-old',status:'failed'});
 await store.set(s,{text:'新目标',newTask:true,progress:{goal:'新任务'}});
 await store.observeTurn(s,{id:'failed-old',status:'failed'});assert.equal(store.get(s).attention,null,'new tasks do not replay an old failure notification');
 assert.equal(store.get(s).progress.verified,undefined);
 const saved=JSON.parse(await fs.readFile(file,'utf8'));assert.equal(saved.research.archives.at(-1).progress.goal,'修复消息');
 assert.equal((await createCheckpoints(file)).get(s).progress.goal,'新任务');
 assert.equal(store.get({...s,createdAt:2}),null);
});

test('progress links reject unsafe schemes and needs-user survives ordinary running updates', async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'progress-links-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const store=await createCheckpoints(path.join(dir,'state.json'));const s={name:'work',createdAt:1,agent:{kind:'codex',id:'t'},status:'working'};
 assert.throws(()=>store.set(s,{text:'x',progress:{evidence:[{label:'bad',url:'javascript:alert(1)'}]}}));
 await store.set(s,{text:'需要判断',progress:{needsUser:'选择验收口径'}});await store.observe([s]);assert.equal(store.get(s).attention.kind,'review');
 await store.ack(s,store.get(s).attention.id);assert.equal(store.get(s).progress.needsUser,'选择验收口径');
});
