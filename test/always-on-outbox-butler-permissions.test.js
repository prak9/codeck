import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AlwaysOnStore } from '../src/always-on-store.js';
import { createAlwaysOnRuntime } from '../src/always-on-runtime.js';
import { createMemoryStore } from '../src/always-on-memory.js';
import { createOutboxDispatcher } from '../src/always-on-outbox.js';
import { createButlerOrchestrator } from '../src/always-on-butler.js';
import { classifyActionRisk, createApprovalGate, createCredentialProxy } from '../src/always-on-permissions.js';

test('OutboxDispatcher suppresses silent, merges notify per scope, compiles digest, and retries without rerunning models', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codeck-outbox-'));
  const store = new AlwaysOnStore(':memory:');
  try {
    const memory = createMemoryStore({ directory: dir });
    const sent = [];
    let shouldFail = false;
    const dispatcher = createOutboxDispatcher({
      store,
      memory,
      deliverTelegram: async msg => {
        if (shouldFail) throw new Error('network timeout');
        sent.push(msg);
      },
      publishDigestPage: async ({ title }) => ({ url: `/pages/digest-${title.length}` }),
      now: () => 50_000,
    });

    store.enqueueOutbox({ scopeKey: 'butler', priority: 'silent', channel: 'telegram', title: '静默检查', contentMd: '无变化', now: 1000 });
    store.enqueueOutbox({ scopeKey: 'butler', priority: 'notify', channel: 'telegram', title: '任务A完成', contentMd: '通过', deliverAfter: 1000, now: 1000 });
    store.enqueueOutbox({ scopeKey: 'butler', priority: 'notify', channel: 'telegram', title: '任务B完成', contentMd: '通过', deliverAfter: 1000, now: 1000 });
    store.enqueueOutbox({ scopeKey: 'butler', priority: 'digest', channel: 'web', title: '研究进展', contentMd: '已完成初稿', deliverAfter: 1000, now: 1000 });
    store.enqueueOutbox({ scopeKey: 'butler', priority: 'urgent', channel: 'telegram', title: '需要审批', contentMd: '高危命令', deliverAfter: 1000, now: 1000 });

    const res = await dispatcher.tick();
    assert.equal(res.delivered, 3); // 1 urgent + 2 merged notify
    assert.equal(sent.length, 2); // 1 urgent call + 1 merged notify call
    assert.match(sent[0].title, /需要审批/);
    assert.match(sent[1].title, /合并 2 条/);

    const digest = await dispatcher.compileDigest({ title: '每日晨报' });
    assert.equal(digest.count, 1);
    assert.match(digest.digestMd, /研究进展/);
    assert.ok(digest.pageUrl);

    // Reported memory recorded summaries
    const reported = await memory.readFile('reported.md');
    assert.match(reported.content, /需要审批/);
    assert.match(reported.content, /每日晨报/);

    // Failed delivery increments attempts without marking sent
    shouldFail = true;
    const failItem = store.enqueueOutbox({ scopeKey: 'butler', priority: 'urgent', channel: 'telegram', title: '重试项', contentMd: 'test', deliverAfter: 1000, now: 1000 }).item;
    const failRes = await dispatcher.tick();
    assert.equal(failRes.failed, 1);
    assert.equal(store.listOutbox({ status: 'pending' }).find(i => i.id === failItem.id).attempts, 1);
  } finally {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('Ephemeral Butler orchestrates delegation + follow-up, deduplicates against reported.md, and can be toggled off', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codeck-butler-'));
  const store = new AlwaysOnStore(':memory:');
  try {
    const memory = createMemoryStore({ directory: dir });
    const dispatched = [];
    const butler = createButlerOrchestrator({
      store,
      memory,
      listSessions: async () => [{ name: 'research', agent: { kind: 'codex', id: 'thr-1' } }],
      dispatchSession: async args => { dispatched.push(args); },
      now: () => 10_000,
    });

    // 1. Delegate + auto follow-up timer
    const ev1 = store.enqueueEvent({
      scopeKey: 'butler',
      source: 'web',
      payload: { delegateSession: 'research', prompt: '跑回归', followUpMs: 30_000, followUpReason: '检查回归结果' },
      now: 10_000,
    }).event;
    const out1 = await butler.handleBatch([ev1], { markSubmitting: () => {} });
    assert.equal(out1.actions[0].status, 'dispatched');
    assert.equal(dispatched.length, 1);
    assert.equal(store.listTimers({ kind: 'follow_up' }).length, 1);

    // 2. Duplicate summary already in reported.md is silenced
    await memory.appendReported({ title: '旧汇报', summary: '已经汇报过的事项' });
    const ev2 = store.enqueueEvent({ scopeKey: 'butler', source: 'timer', payload: { reason: '已经汇报过的事项' }, now: 10_000 }).event;
    await butler.handleBatch([ev2], {});
    const silenced = store.listOutbox({ status: 'suppressed' });
    assert.equal(silenced.length, 1);

    // 3. Toggle off stops orchestration cleanly
    assert.equal(butler.setEnabled(false), false);
    const ev3 = store.enqueueEvent({ scopeKey: 'butler', source: 'web', payload: { delegateSession: 'research', prompt: '不应执行' }, now: 10_000 }).event;
    const out3 = await butler.handleBatch([ev3], {});
    assert.equal(out3.skipped, true);
    assert.equal(dispatched.length, 1);
  } finally {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('Deferred ApprovalGate suspends non-blockingly and resumes via Inbox event; CredentialProxy isolates secrets', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codeck-perm-'));
  const store = new AlwaysOnStore(':memory:');
  const resumed = [];
  const runtime = createAlwaysOnRuntime({
    store,
    handleScope: async (scopeKey, batch) => {
      resumed.push({ scopeKey, sources: batch.map(e => e.source), decisions: batch.map(e => e.payload.decision) });
    },
  });
  try {
    assert.equal(classifyActionRisk({ kind: 'page_share' }), 'defer');
    assert.equal(classifyActionRisk({ kind: 'worktree_create' }), 'guard');
    assert.equal(classifyActionRisk({ kind: 'read_file' }), 'allow');

    const gate = createApprovalGate({ store, runtime });
    const req = gate.requestApproval({
      scopeKey: 'session:research',
      sessionName: 'research',
      provider: 'codex',
      threadId: 'thr-1',
      summary: '公网分享报告页面',
      action: { kind: 'page_share', pageId: 'p-1' },
    });
    assert.equal(req.deferred, true);
    assert.equal(store.listApprovals({ status: 'pending' }).length, 1);
    assert.equal(store.listOutbox({ priority: 'urgent' }).length, 1);

    // Other scopes remain completely unblocked while approval is pending!
    await runtime.enqueueAndWake({ scopeKey: 'butler', source: 'web', payload: { text: 'unblocked' } });
    await runtime.drainScope('butler');
    assert.equal(resumed.length, 1);
    assert.equal(resumed[0].scopeKey, 'butler');

    // Resolve approval -> enqueues approval_resolved event -> wakes original scope!
    const resolved = await gate.resolveApproval(req.approval.id, { decision: 'approved', note: '已复核' });
    assert.equal(resolved.approval.status, 'approved');
    await runtime.drainScope('session:research');
    assert.equal(resumed.length, 2);
    assert.equal(resumed[1].scopeKey, 'session:research');
    assert.deepEqual(resumed[1].sources, ['approval_resolved']);
    assert.deepEqual(resumed[1].decisions, ['approved']);

    // Credential Proxy framework test with 0600 sample secret
    const secretFile = path.join(dir, 'sample.token');
    await fs.writeFile(secretFile, 'super-secret-xyz-999\n', { mode: 0o600 });
    const seenHeaders = [];
    const proxy = createCredentialProxy({
      secretsDir: dir,
      fetchImpl: async (url, init) => {
        seenHeaders.push({ url, headers: init.headers });
        if (url.includes('/fail')) throw new Error('upstream failed for super-secret-xyz-999');
        return { ok: true, status: 200, text: async () => '{"ok":true}' };
      },
    });
    proxy.registerService('sample-echo', {
      baseUrl: 'https://api.example.test',
      secretFile: 'sample.token',
      allowedPathPrefix: '/v1/',
      allowedMethods: ['GET'],
    });

    const okRes = await proxy.forward({
      service: 'sample-echo',
      method: 'GET',
      requestPath: '/v1/ping',
      headers: { Authorization: 'spoofed', 'X-Trace': '1' },
    });
    assert.equal(okRes.status, 200);
    assert.equal(seenHeaders[0].headers.Authorization, 'Bearer super-secret-xyz-999');
    assert.equal(seenHeaders[0].headers['X-Trace'], '1');

    // Secret must be redacted from error messages
    await assert.rejects(
      () => proxy.forward({ service: 'sample-echo', method: 'GET', requestPath: '/v1/fail' }),
      err => !err.message.includes('super-secret-xyz-999') && err.message.includes('[REDACTED]'),
    );

    // Path traversal & disallowed prefix rejected
    await assert.rejects(() => proxy.forward({ service: 'sample-echo', method: 'GET', requestPath: '/admin' }), /不在允许前缀/);
    await assert.rejects(() => proxy.forward({ service: 'sample-echo', method: 'POST', requestPath: '/v1/ping' }), /不允许方法/);
  } finally {
    runtime.close();
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
