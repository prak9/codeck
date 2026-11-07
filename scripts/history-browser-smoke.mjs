import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import express from 'express';
import { createHistorySearch } from '../src/history-search.js';
import { mountHistoryRoutes } from '../src/history-routes.js';
const { chromium } = await import(process.env.CODECK_PLAYWRIGHT_MODULE || 'playwright');
const exec=promisify(execFile), dir=await fs.mkdtemp(path.join(os.tmpdir(),'codeck-history-browser-'));
const root=path.join(dir,'repo');await fs.mkdir(root);
await exec('git',['init',root]);await fs.writeFile(path.join(root,'README.md'),'fixture');await exec('git',['-C',root,'add','.']);await exec('git',['-C',root,'-c','user.name=test','-c','user.email=test@example.invalid','commit','-m','历史读取优化']);
const sha=(await exec('git',['-C',root,'rev-parse','HEAD'])).stdout.trim();
await fs.writeFile(path.join(root,'closed.jsonl'),[
 {type:'session_meta',payload:{id:'closed-thread',cwd:root}},
 {type:'response_item',timestamp:'2026-11-07T10:00:00Z',payload:{type:'message',role:'user',content:[{type:'input_text',text:'为什么历史读取很慢？'}]}},
 {type:'response_item',timestamp:'2026-11-07T10:02:00Z',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:`历史读取重复构造整个消息图。改为增量索引；候选提交 ${sha.slice(0,8)}。<script>window.leaked=true</script>`}]}},
].map(JSON.stringify).join('\n')+'\n');
const history=createHistorySearch({directory:path.join(dir,'index'),roots:[{provider:'codex',directory:root}]});
const app=express();app.use(express.json());mountHistoryRoutes(app,{history,ownerOnly:(req,res,next)=>req.get('Authorization')==='Bearer fixture'?next():res.sendStatus(403)});
app.get('/',(_req,res)=>res.send('<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/history-search.css"><body style="background:#19191b"><button id="historySearchButton">搜索历史内容</button><script type="module">import {bindHistorySearch} from "/history-search.js";bindHistorySearch({token:()=>"fixture"});</script>'));
app.use(express.static('public'));
const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
const base=`http://127.0.0.1:${server.address().port}`, browser=await chromium.launch({headless:true});
try{
 for(const width of [390,1365]){
  const context=await browser.newContext({viewport:{width,height:900}}), page=await context.newPage(), errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base);await page.getByRole('button',{name:'搜索历史内容',exact:true}).click();await page.locator('#history-query').fill('历史读取');await page.getByRole('button',{name:'搜索',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.history-result').length===2);
  await page.locator('.history-result').filter({hasText:'增量索引'}).click();
  await page.locator('.history-context input[name=commit]').fill(sha.slice(0,8));await page.getByRole('button',{name:'核验并关联',exact:true}).click();
  await page.waitForFunction(sha=>document.querySelector('.history-context').textContent.includes(sha.slice(0,12)),sha);
  assert.equal(await page.evaluate(()=>window.leaked),undefined);
  assert.ok(await page.locator('dialog').evaluate(el=>el.scrollWidth<=el.clientWidth));
  await page.screenshot({path:path.join(dir,`${width}-search.png`)});
  await page.getByRole('button',{name:'关闭历史搜索'}).click();assert.equal(await page.locator('dialog').evaluate(el=>el.open),false);
  assert.deepEqual(errors,[]);await context.close();console.log(`PASS ${width}: archived search/context/verified commit, escaped text, no overflow`);
 }
 console.log('Artifacts:',dir);
}finally{await browser.close();await history.close();await new Promise(r=>server.close(r));await fs.rm(root,{recursive:true,force:true});await fs.rm(path.join(dir,'index'),{recursive:true,force:true});}
