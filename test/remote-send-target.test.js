import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { composerSubmitAction } from '../public/remote-composer.js';

const source = fs.readFileSync(new URL('../public/remote.js', import.meta.url), 'utf8');
const start = source.indexOf('async function submitComposer(');
const submitSource = source.slice(start, source.indexOf('\n}', start) + 2);

test('sending without a bound session preserves the draft and never starts session creation', async () => {
  for (const provider of ['codex', 'claude', 'qodercli', 'shell']) {
    const input = { value: '继续处理当前任务' };
    const attachments = [];
    let created = 0, requests = 0, message = '';
    const context = vm.createContext({
      state: { provider, thread: null, attachments },
      composerRequestGate: { pending: false, run() { requests++; } },
      $: () => input,
      settleConfirmedDeliveries: () => false, abortSpeechInput() {},
      latestRunningTurn: () => null, threadExecutionState: () => 'idle',
      composerSubmitAction,
      setLiveMessage: text => { message = text; },
      openNewSession() { created++; },
    });
    vm.runInContext(submitSource, context);
    await context.submitComposer({ explicitInterrupt: true });
    await context.submitComposer();
    assert.equal(created, 0, provider);
    assert.equal(requests, 0);
    assert.equal(input.value, '继续处理当前任务');
    assert.match(message, /选择.*会话/);
  }
});
