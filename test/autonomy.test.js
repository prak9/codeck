import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fixture } from '../test-support/autonomy-fixture.js';
import { AUTONOMY_PROGRESS_PROMPT, autonomyDisplayText } from '../public/remote-autonomy.js';

for (const provider of ['codex', 'claude', 'qodercli']) {
  test(`${provider}: no send before approval, one send per receipt, completion is terminal`, async () => {
    const f = fixture(provider); await f.manager.start(f.target); await f.manager.tick(); assert.equal(f.sent.length, 0);
    await f.approve(); await Promise.all([f.manager.tick(), f.manager.tick()]); assert.equal(f.sent.length, 1);
    f.reply(); await f.manager.tick(); await Promise.all([f.manager.tick(), f.manager.tick()]); assert.equal(f.sent.length, 2);
    f.reply('complete'); await f.manager.tick(); assert.equal(f.state().status, 'completed');
    await f.manager.tick(); assert.equal(f.sent.length, 2); assert.ok(f.state().handoff.next); f.manager.close();
  });
  for (const status of ['inProgress', 'interrupted']) test(`${provider}: quiet ${status} turn is not mistaken for a finished result`, async () => {
    const f = fixture(provider); await f.start(); f.turns[0].status = status;
    await f.manager.tick(); f.now += 60000; await f.manager.tick(); assert.equal(f.state().status, 'running');
    f.reply('complete'); await f.manager.tick(); assert.equal(f.state().status, 'completed'); f.manager.close();
  });
  test(`${provider}: native question and background work stay running without spending rounds`, async () => {
    const f = fixture(provider); await f.start(); f.reply('wait'); await f.manager.tick();
    f.session.agent.hasBackgroundProcess = true; f.session.agent.question = { id: 'permission' };
    f.now += 60000; await f.manager.tick(); assert.equal(f.state().status, 'running'); assert.equal(f.sent.length, 1);
    f.session.agent.question = null; await f.manager.tick(); assert.equal(f.sent.length, 1);
    f.session.agent.hasBackgroundProcess = false; await f.manager.tick(); await f.manager.tick(); assert.equal(f.sent.length, 2); f.manager.close();
  });
}

test('closed missing result errors; later receipts cannot restart it', async () => {
  const f = fixture(); await f.start(); f.turns[0].status = 'completed';
  const exchange = f.run().exchange; await f.manager.tick(); f.now += 30001; await f.manager.tick();
  assert.equal(f.state().status, 'error');
  fs.writeFileSync(exchange.receiptFile, JSON.stringify({ nonce: exchange.nonce, status: 'continue', summary: 'late' }));
  await f.manager.tick(); assert.equal(f.state().status, 'error'); assert.equal(f.sent.length, 1); f.manager.close();
});

test('legacy fenced JSON is never accepted as an execution receipt', async () => {
  const f = fixture(); await f.start(); f.turns[0].status = 'completed';
  f.turns[0].items.push({ type: 'agentMessage', text: '```codeck-autonomy\n' + JSON.stringify({ nonce: f.run().exchange.nonce, status: 'complete', summary: '旧协议' }) + '\n```' });
  await f.manager.tick(); f.now += 30001; await f.manager.tick(); assert.equal(f.state().status, 'error'); f.manager.close();
});

test('read-only progress cannot close a live work turn or hide its completed receipt', async () => {
  const f = fixture(); await f.start();
  f.turns.push({ status: 'completed', items: [{ type: 'userMessage', content: AUTONOMY_PROGRESS_PROMPT }, { type: 'agentMessage', text: '还在执行' }] });
  await f.manager.tick(); f.now += 60000; await f.manager.tick(); assert.equal(f.state().status, 'running');
  f.turns.pop(); f.reply('complete');
  f.turns.push({ status: 'completed', items: [{ type: 'userMessage', content: '/status' }, { type: 'agentMessage', text: '状态查询' }] });
  await f.manager.tick(); assert.equal(f.state().status, 'completed'); f.manager.close();
});

for (const provider of ['codex', 'claude', 'qodercli']) test(`${provider}: ordinary conversation preserves A and waits before continuing its goal`, async () => {
  const f = fixture(provider); await f.start('5轮'); const plan = f.state().plan;
  f.turns[0].status = 'interrupted';
  f.turns.push({ status: 'inProgress', items: [{ type: 'userMessage', content: '先检查缓存这个方向' }] });
  await f.manager.tick(); f.now += 60000; await f.manager.tick();
  assert.equal(f.state().status, 'running'); assert.equal(f.sent.length, 1);
  f.turns.at(-1).status = 'completed'; f.turns.at(-1).items.push({ type: 'agentMessage', text: '缓存检查完成，下轮继续验证。' });
  await f.manager.tick(); await f.manager.tick();
  assert.equal(f.state().status, 'running'); assert.equal(f.sent.length, 2);
  assert.deepEqual(f.state().plan, plan); assert.equal(f.state().round, 2); f.manager.close();
});

for (const status of ['blocked', 'error']) test(`Agent ${status} ends with its summary and next steps, never pause/resume`, async () => {
  const f = fixture(); await f.start(); f.reply(status, { summary: '必要数据缺失', next: '补充数据后重新设置' }); await f.manager.tick();
  assert.equal(f.state().status, status === 'error' ? 'error' : 'off'); assert.equal(f.state().handoff.summary, '必要数据缺失');
  assert.equal(f.state().handoff.next, '补充数据后重新设置'); await f.manager.tick(); assert.equal(f.sent.length, 1); f.manager.close();
});

test('a user composing input defers the next loop without error or spending a round', async () => {
  const f = fixture(); await f.start(); f.reply(); await f.manager.tick();
  const send = f.manager.send; f.manager.send = async () => ({ submissionStatus: 'deferred' });
  await f.manager.tick(); assert.equal(f.state().status, 'running'); assert.equal(f.state().round, 1);
  assert.equal(f.sent.length, 1); assert.equal(f.run().exchange, null);
  f.manager.send = send; await f.manager.tick(); assert.equal(f.sent.length, 2); assert.equal(f.state().round, 2);
  f.manager.close();
});

test('unlimited budgets have no hidden round or no-progress ceiling', async () => {
  const f = fixture(); await f.start();
  for (let i = 0; i < 105; i++) { f.reply('continue', { progress: false }); await f.manager.tick(); await f.manager.tick(); }
  assert.equal(f.state().round, 106); assert.equal(f.state().status, 'running'); f.manager.close();
});

for (const budget of ['1轮', '1分钟']) test(`${budget} ends with a summary without spending an extra work round`, async () => {
  const f = fixture(); await f.start(budget);
  if (budget.includes('分钟')) f.now += 60001; else f.reply();
  await f.manager.tick(); assert.equal(f.state().status, 'exiting');
  await f.manager.tick(); assert.equal(f.state().round, 1); assert.match(f.sent[1], /"phase":"summary"/);
  f.reply('summary'); await f.manager.tick(); assert.equal(f.state().status, 'off'); assert.match(f.state().reason, /预算/); f.manager.close();
});

test('best verified evidence survives a failed exploration, missing version evidence fails', async () => {
  const f = fixture(); await f.start();
  f.reply('continue', { 'best-version': 'v1', 'best-evidence': '通过', 'best-artifact': '/fixture/result' });
  await f.manager.tick(); await f.manager.tick(); f.reply('continue', { progress: false, current: '失败实验' }); await f.manager.tick();
  assert.equal(f.state().best.version, 'v1'); await f.manager.tick();
  fs.writeFileSync(f.run().exchange.receiptFile, JSON.stringify({ nonce: f.run().exchange.nonce, status: 'complete', summary: '声称完成', evidence: '无版本' }));
  f.turns.at(-1).status = 'completed'; await f.manager.tick(); assert.equal(f.state().status, 'error'); assert.match(f.state().reason, /版本/); f.manager.close();
});

test('delivery uncertainty and pane changes error without automatic retry', async () => {
  for (const problem of ['unconfirmed', 'not-sent', 'identity']) {
    const f = fixture(); await f.manager.start(f.target); await f.approve();
    if (problem === 'identity') f.session.agent.paneId = '%2'; else f.manager.send = async () => ({ submissionStatus: problem });
    await f.manager.tick(); assert.equal(f.state().status, 'error'); await f.manager.tick(); assert.equal(f.sent.length, 0); f.manager.close();
  }
});

test('stale preparation cannot send into or fail a replacement run', async () => {
  const f = fixture(); await f.manager.start(f.target); await f.approve(); let release;
  f.manager.prepare = () => new Promise(resolve => { release = resolve; });
  const poll = f.manager.tick(); while (!release) await Promise.resolve();
  f.manager.exit(f.target); await f.manager.start(f.target); const id = f.state().id;
  release({}); await poll; assert.equal(f.state().id, id); assert.equal(f.state().setup, true); assert.equal(f.sent.length, 0); f.manager.close();
});

test('persistent history failures error, but a cancelled stale failure cannot affect a new setup', async () => {
  const f = fixture(); await f.start(); f.manager.readThread = async () => ({ thread: { historyError: 'unavailable' } });
  await f.manager.tick(); f.now += 30001; await f.manager.tick(); assert.equal(f.state().status, 'error');
  await f.manager.start(f.target); assert.equal(f.state().setup, true); f.manager.close();
});

test('autonomous prompt preserves skills, evidence, independent exploration and human handoff', async () => {
  const f = fixture(); await f.start();
  for (const pattern of [/SKILL\.md/, /writing/, /自主探索/, /不得降低|不能通过降低/, /最佳已验证/, /用户中止/, /不等待用户逐步派活/]) assert.match(f.sent[0], pattern);
  assert.doesNotMatch(f.sent[0], /输出.*fenced JSON/); f.manager.close();
});

test('progress prompt stays observational; human rendering hides old metadata, not ordinary JSON', () => {
  assert.match(AUTONOMY_PROGRESS_PROMPT, /目标.*进展/); assert.match(AUTONOMY_PROGRESS_PROMPT, /不打断.*不续跑/);
  assert.equal(autonomyDisplayText('结果\n```codeck-autonomy\n{"status":"complete"}\n```\n下一步'), '结果\n\n下一步');
  assert.equal(autonomyDisplayText('普通 JSON {"result":1}'), '普通 JSON {"result":1}');
  assert.equal(autonomyDisplayText('结果\n```codeck-autonomy\n{"stat'), '结果');
});
