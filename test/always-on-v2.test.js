import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { AlwaysOnStore } from '../src/always-on-store.js';
import { createAlwaysOnRuntime } from '../src/always-on-runtime.js';
import { createMemoryStore } from '../src/always-on-memory.js';
import { analyzeBrainDump, materializeBlueprint, runBlueprintDryRun } from '../src/always-on-architect.js';
import { buildMicroCollectorHtml, generateImprovementProposals, resolveImprovementProposal } from '../src/always-on-feedback.js';
import { mountAlwaysOnRoutes } from '../src/always-on-routes.js';
import { runCodeck } from '../src/codeck-client.js';

test('Architect detects process-as-goal confusion, builds single-question interview, materializes blueprint, and runs side-effect-free Dry-Run', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codeck-v2-arch-'));
  const store = new AlwaysOnStore(':memory:');
  const memory = createMemoryStore({ directory: dir });
  try {
    const analysis = analyzeBrainDump({
      text: '每天发邮件整理昨天的交易总结并公网分享。',
      existingSessions: [{ name: 'research' }],
    });
    assert.ok(analysis.processConfusionWarning, 'should warn when first sentence describes a process step');
    assert.ok(analysis.questions.length >= 2, 'should produce one-question-at-a-time interview items');
    assert.equal(analysis.edgeCases.length, 2);

    const materialized = await materializeBlueprint({
      store,
      memory,
      draft: { ...analysis.draft, slug: 'daily-review', title: '每日复盘', targetSession: 'research' },
      recurrenceMs: 3_600_000,
      now: 10_000,
    });
    assert.equal(materialized.blueprint.version, 1);
    assert.equal(materialized.blueprint.status, 'paused');
    assert.equal(materialized.timer.status, 'paused');

    // Mirrored into white-box memory/blueprints/
    const memFile = await memory.readFile('blueprints/daily-review.md');
    assert.match(memFile.content, /每日复盘/);

    // Entity timeline tracks blueprint + timer
    const timeline = store.listEntityLinks({ entityKey: materialized.blueprint.entityKey });
    assert.equal(timeline.length, 2);

    // Dry-run executes ZERO side effects (no outbox enqueued, no events created)
    const dry = await runBlueprintDryRun({
      store,
      memory,
      blueprint: materialized.blueprint,
      listSessions: async () => [{ name: 'research', agent: { kind: 'codex' }, executionState: 'idle' }],
      now: 20_000,
    });
    assert.equal(dry.dryRun, true);
    assert.equal(dry.sideEffectsExecuted, false);
    assert.equal(dry.predictedRisk, 'defer');
    assert.equal(store.listOutbox({}).length, 0);
    assert.equal(store.listEvents({}).length, 0);
  } finally {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('Feedback engine generates deduplicated proposals, applies accepted patches atomically, and records rejected notes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codeck-v2-fb-'));
  const store = new AlwaysOnStore(':memory:');
  const memory = createMemoryStore({ directory: dir });
  try {
    const { blueprint, timer } = await materializeBlueprint({
      store,
      memory,
      draft: { slug: 'futures-daily', title: '期货日报', goal: '收盘后产出可核验影子建议', targetSession: 'report', status: 'active' },
      recurrenceMs: 600_000,
      now: 1000,
    });
    // Simulate timer check error + rejected approval + 2 collector feedbacks
    store.updateTimerState(timer.id, { lastStatus: 'check_error', lastError: '上游数据未落盘', now: 2000 });
    const apr = store.createApproval({ scopeKey: 'session:report', sessionName: 'report', summary: '切换实盘配置', action: { kind: 'prod_restart' }, now: 2000 });
    store.resolveApproval(apr.id, { status: 'rejected', decisionNote: '收盘后禁止临盘切换', now: 2100 });
    store.addEntityLink({ entityKey: blueprint.entityKey, refType: 'collector', refId: 'c1', summary: '夜盘延迟10分钟更稳', now: 2200 });
    store.addEntityLink({ entityKey: blueprint.entityKey, refType: 'feedback', refId: 'c2', summary: '补充波动率校验', now: 2300 });

    const gen1 = generateImprovementProposals({ store, now: 3000 });
    assert.equal(gen1.generated, 3);
    // Deduplication: running again produces 0 duplicates
    const gen2 = generateImprovementProposals({ store, now: 3100 });
    assert.equal(gen2.generated, 0);

    // Accept one proposal -> bumps blueprint version and writes entity_link
    const accepted = await resolveImprovementProposal({ store, memory, id: gen1.proposals[0].id, decision: 'accepted', now: 4000 });
    assert.equal(accepted.blueprint.version, 2);
    assert.match(accepted.blueprint.tacitRulesMd, /预检脚本异常/);

    // Reject another proposal -> records in notes/rejected-proposals.md
    await resolveImprovementProposal({ store, memory, id: gen1.proposals[1].id, decision: 'rejected', note: '暂不需要', now: 4100 });
    const rejectedNote = await memory.readFile('notes/rejected-proposals.md');
    assert.match(rejectedNote.content, /暂不需要/);
  } finally {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('Micro-Collector HTML is self-contained, and all v2 routes + CLI commands enforce ownerOnly isolation', async () => {
  const html = buildMicroCollectorHtml({ slug: 'trade-log', title: '复盘打卡', entityKey: 'mission:trade-log' });
  assert.doesNotMatch(html, /<script\s+src=/i, 'must not include external scripts');
  assert.match(html, /\/api\/always-on\/collectors\/trade-log\/submit/);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codeck-v2-http-'));
  const store = new AlwaysOnStore(':memory:');
  const memory = createMemoryStore({ directory: path.join(dir, 'memory') });
  const runtime = createAlwaysOnRuntime({ store, handleScope: async () => ({ status: 'done' }) });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.auth = { owner: req.headers['x-owner'] === '1' }; next(); });
  const ownerOnly = (req, res, next) => (req.auth.owner ? next() : res.status(403).json({ error: 'forbidden' }));
  mountAlwaysOnRoutes(app, {
    store,
    runtime,
    memory,
    publishCollectorPage: async ({ title }) => ({ id: 'pg-collector-1', url: `/pages/pg-collector-1`, title }),
    ownerOnly,
  });

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    // Non-owner blocked on all v2 endpoints
    for (const [method, endpoint] of [
      ['GET', '/api/always-on/blueprints'],
      ['POST', '/api/always-on/architect/analyze'],
      ['GET', '/api/always-on/entities'],
      ['GET', '/api/always-on/proposals'],
      ['POST', '/api/always-on/collectors/demo/submit'],
    ]) {
      const res = await fetch(`${baseUrl}${endpoint}`, {
        method,
        headers: { 'x-owner': '0', 'content-type': 'application/json' },
        ...(method === 'POST' ? { body: '{}' } : {}),
      });
      assert.equal(res.status, 403, `${method} ${endpoint} must be ownerOnly`);
    }

    const request = async (_conn, endpoint, method = 'GET', body) => {
      const res = await fetch(`${baseUrl}${endpoint}`, {
        method,
        headers: { 'x-owner': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      return data;
    };

    const bpFile = path.join(dir, 'bp.json');
    await fs.writeFile(bpFile, JSON.stringify({ title: '周报目标', goal: '每周五产出周报' }));
    const created = await runCodeck(['blueprint', 'put', 'weekly-report', '--file', bpFile], {}, { request });
    assert.equal(created.slug, 'weekly-report');

    const dry = await runCodeck(['blueprint', 'dry-run', 'weekly-report'], {}, { request });
    assert.equal(dry.dryRun, true);

    // Collector publish + submit correlates via entityKey
    const pubRes = await request({}, '/api/always-on/collectors/weekly-report/publish', 'POST', {});
    assert.equal(pubRes.url, '/pages/pg-collector-1');
    const subRes = await request({}, '/api/always-on/collectors/weekly-report/submit', 'POST', {
      entityKey: created.entityKey,
      data: { observation: '本周指标稳定' },
    });
    assert.equal(subRes.ok, true);

    const tl = await runCodeck(['entity', 'timeline', created.entityKey], {}, { request });
    assert.ok(tl.links.length >= 3);
  } finally {
    runtime.close();
    store.close();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});
