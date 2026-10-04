import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixture } from '../test-support/autonomy-fixture.js';
import { writeReceipt } from '../src/autonomy-receipt.js';

for (const provider of ['codex', 'claude', 'qodercli']) {
  for (const status of ['completed', 'ended', 'error']) {
    test(`${provider}: resetting verified ${status} is local even when the terminal has new work`, async t => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codeck-reset-verified-'));
      const f = fixture(provider, path.join(directory, 'state.json'));
      t.after(() => { f.manager.close(); fs.rmSync(directory, { recursive: true, force: true }); });
      await f.manager.preparePlanning(f.target);
      const source = f.run().observation;
      writeReceipt(['--receipt', source.startFile, '--status', 'started', '--goal', 'old task', '--summary', 'start']);
      await f.manager.tick();
      writeReceipt(['--receipt', source.endFile, '--status', status === 'ended' ? 'budget' : 'completed',
        '--summary', 'verified result', '--next', 'review', '--evidence', 'tests',
        '--version', 'v1', '--verification', 'pass', '--cleanup', 'verified resources']);
      await f.manager.tick();
      assert.equal(f.state().cleanupVerified, true);
      if (status === 'error') {
        // Persist the state left by the old reset path after rejecting new work.
        f.run().exitFailed = true;
        f.run().exitPlanning = false;
        f.manager.fail(f.target, '会话有新的执行，未打断；请等待其结束后重试退出');
      }
      f.restart();
      assert.equal(f.state().status, status);
      f.session.hasRunningProcess = true;
      f.session.agent.question = { id: 'new-question' };
      f.session.agent.hasBackgroundProcess = true;
      f.session.draft = 'keep new draft';
      const beforeSession = structuredClone(f.session);
      const before = f.state();
      const read = f.manager.readSession;
      f.manager.readSession = async () => { throw Error('reset must not inspect the current terminal'); };
      f.manager.stop = async () => { throw Error('reset must not interrupt new work or inspect drafts'); };
      f.manager.send = async () => { throw Error('reset must not send another summary'); };

      await assert.rejects(f.manager.resetObserved(f.target, 'stale-run'), /已变化/);
      assert.equal(f.state().status, status);
      await Promise.all([
        f.manager.resetObserved(f.target, before.id),
        f.manager.resetObserved(f.target, before.id),
      ]);
      assert.equal(f.state().status, 'off');
      assert.equal(f.state().exitFailed, undefined);
      assert.equal(f.state().exitPlanning, undefined);
      assert.equal(f.state().summary, before.summary);
      assert.equal(f.state().evidence, before.evidence);
      assert.deepEqual(f.session, beforeSession);
      assert.equal(f.sent.length, 0);
      assert.equal(fs.existsSync(path.dirname(source.endFile)), false);

      f.manager.readSession = read;
      const next = await f.manager.preparePlanning(f.target);
      assert.notEqual(next.planningId, before.id);
      assert.equal(f.state().status, 'planning');
      assert.equal(f.state().cleanupVerified, undefined);
    });
  }
}

for (const [status, verified] of [['running', true], ['completed', false], ['error', false]]) {
  test(`${status} with cleanupVerified=${verified} still requires the stop path`, async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codeck-reset-guard-'));
    const f = fixture('codex', path.join(directory, 'state.json'));
    t.after(() => { f.manager.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    await f.manager.preparePlanning(f.target);
    f.run().status = status;
    f.run().cleanupVerified = verified;
    let stops = 0;
    f.manager.stop = async () => { stops++; throw Error('stop not verified'); };
    await assert.rejects(f.manager.resetObserved(f.target), /stop not verified/);
    assert.equal(stops, 1);
    assert.equal(f.state().status, 'error');
    assert.equal(f.state().exitFailed, true);
  });
}
