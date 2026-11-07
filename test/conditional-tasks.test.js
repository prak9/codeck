import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createConditionalTasks } from '../src/conditional-tasks.js';
test('precheck skips cheaply, event keys deduplicate, busy targets wait, uncertain dispatch never retries after restart', async t => {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'conditional-')); t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 let key=null, busy=false, sent=0, now=1000;
 const options={ directory:dir, now:()=>now, precheck:async()=>key, idle:async()=>!busy, send:async()=>{sent++;throw new Error('lost ACK');} };
 let runner=await createConditionalTasks(options);
 await runner.put('news',{ everyMinutes:1, session:'research', threadId:'t', provider:'codex', prompt:'查看新资料', check:['/bin/true'], cwd:'/tmp' });
 await runner.tick(); assert.equal(sent,0);
 now+=60000; key='event1'; busy=true; await runner.tick(); assert.equal(sent,0);
 now+=60000; busy=false; await Promise.all([runner.tick(),runner.tick()]); assert.equal(sent,1);
 assert.equal((await runner.list())[0].last.status,'unknown');
 runner=await createConditionalTasks(options); now+=60000; await runner.tick(); assert.equal(sent,1);
});

test('two schedules targeting one session cannot overlap before verified turn ending', async t => {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'conditional-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 let completed=false, sends=0, now=0;
 const runner=await createConditionalTasks({ directory:dir, now:()=>now, idle:async()=>true, precheck:async()=> 'one', settled:async()=>completed, send:async()=>{sends++;} });
 const value={ everyMinutes:1, session:'s', threadId:'t', provider:'codex', prompt:'check', check:['/bin/true'], cwd:'/tmp' };
 await runner.put('a',value);await runner.put('b',value);
 await runner.tick();assert.equal(sends,1);
 now+=60000;await runner.tick();assert.equal(sends,1);
 completed=true;await runner.tick();assert.equal(sends,2);
});

test('real precheck accepts stable output, skips nonzero and kills a timed-out process group', async () => {
 const { runPrecheck } = await import('../src/conditional-tasks.js');
 assert.equal(await runPrecheck({ cwd:'/tmp', check:[process.execPath,'-e','process.stdout.write("event-1")'] }),'event-1');
 assert.equal(await runPrecheck({ cwd:'/tmp', check:[process.execPath,'-e','process.exit(1)'] }),null);
 await assert.rejects(runPrecheck({cwd:'/tmp', check:[process.execPath,'-e','setInterval(()=>{},1000)']},{timeout:50}),/超时/);
 await assert.rejects(runPrecheck({cwd:'/tmp',check:[process.execPath,'-e','process.stdout.write("x".repeat(70000))']}),/过大/);
});
