import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HistoryIndex } from '../src/history-index.js';
const line = (role,text) => JSON.stringify({type:'response_item',payload:{type:'message',role,content:[{type:role==='user'?'input_text':'output_text',text}]}})+'\n';
test('indexes literal conversation text, resumes partial appends, replaces rewritten/deleted files, excludes tools', async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'history-index-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const root=path.join(dir,'sessions');await fs.mkdir(root);
 const file=path.join(root,'one.jsonl');
 await fs.writeFile(file,JSON.stringify({type:'session_meta',payload:{id:'thread-1',cwd:'/project'}})+'\n'+line('user','为什么性能下降？')+line('assistant','根因是反复解析历史 abc1234')+JSON.stringify({type:'response_item',payload:{type:'function_call_output',output:'PRIVATE_TOOL'}})+'\n');
 const index=new HistoryIndex(path.join(dir,'index.sqlite'));t.after(()=>index.close());
 const roots=[{provider:'codex',directory:root}];await index.refresh(roots);
 assert.equal(index.search('性能').results.length,1);
 assert.equal(index.search('PRIVATE_TOOL').results.length,0);
 const hit=index.search('反复解析').results[0];assert.equal(hit.threadId,'thread-1');assert.match(index.context(hit.id).messages.at(-1).text,/反复解析/);
 const extra=line('assistant','追加验证结果');await fs.appendFile(file,extra.slice(0,-2));await index.refresh(roots);assert.equal(index.search('追加验证').results.length,0);
 await fs.appendFile(file,extra.slice(-2));await index.refresh(roots);assert.equal(index.search('追加验证').results.length,1);
 await index.refresh(roots);assert.equal(index.search('追加验证').results.length,1);
 await fs.writeFile(file,JSON.stringify({type:'session_meta',payload:{id:'thread-2'}})+'\n'+line('assistant','重新开始'));
 await index.refresh(roots);assert.equal(index.search('追加验证').results.length,0);assert.equal(index.search('重新开始').results[0].threadId,'thread-2');
 await fs.unlink(file);await index.refresh(roots);assert.equal(index.search('重新开始').results.length,0);
});
test('Qoder and Claude plain text blocks are searchable without tool/thinking/image payloads',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'history-index-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const index=new HistoryIndex(path.join(dir,'index.sqlite'));t.after(()=>index.close());
 await fs.writeFile(path.join(dir,'q.jsonl'),JSON.stringify({type:'assistant',uuid:'m1',sessionId:'q1',cwd:'/p',message:{role:'assistant',content:[{type:'text',text:'三种方案比较'},{type:'thinking',thinking:'hidden reasoning'}]}})+'\n');
 await index.refresh([{provider:'qodercli',directory:dir}]);assert.equal(index.search('方案比较').results.length,1);assert.equal(index.search('hidden').results.length,0);
});

test('stale result IDs cannot resolve to replacement content; malformed and oversized records are reported',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'history-index-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const index=new HistoryIndex(path.join(dir,'index.sqlite'));t.after(()=>index.close());const file=path.join(dir,'t.jsonl'),roots=[{provider:'codex',directory:dir}];
 await fs.writeFile(file,line('assistant','old unique text'));await index.refresh(roots);const id=index.search('unique').results[0].id;
 await fs.writeFile(file,'null\n{broken}\n'+line('assistant','new unique text')+line('assistant','x'.repeat(17*1024*1024)));await index.refresh(roots);
 assert.throws(()=>index.context(id),/不存在/);assert.equal(index.search('unique').results.length,1);assert.equal(index.search('unique').status.skipped,3);
});
