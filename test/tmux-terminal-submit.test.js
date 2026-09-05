import test from 'node:test';
import assert from 'node:assert/strict';
import { submitTerminalInput } from '../src/tmux.js';

function submissionDependencies(overrides = {}) {
  const calls = [];
  return {
    calls,
    bufferName: 'codeck-local-test',
    isCurrent: () => true,
    loadBuffer: async (name, data) => calls.push(['load', name, data]),
    execTmux: async (args) => {
      calls.push(args);
      return { stdout: 'work\t%17\n' };
    },
    ...overrides,
  };
}

test('local submissions preserve exact bytes and atomically exit copy mode before pasting', async () => {
  const deps = submissionDependencies();
  await submitTerminalInput('work', 'echo one\necho 二\r', deps);
  assert.deepEqual(deps.calls, [
    ['display-message', '-p', '-t', '=work:', '#{session_name}\t#{pane_id}'],
    ['load', 'codeck-local-test', 'echo one\necho 二\r'],
    ['display-message', '-p', '-t', '=work:', '#{session_name}\t#{pane_id}'],
    ['copy-mode', '-q', '-t', '%17', ';', 'paste-buffer', '-r', '-d', '-b', 'codeck-local-test', '-t', '%17'],
  ]);
});

test('local submissions reject unsafe or stale target panes before any input', async () => {
  for (const target of ['other\t%17\n', 'work\twork:0.0\n', 'work\t%17\nwork\t%18\n']) {
    const deps = submissionDependencies({ execTmux: async () => ({ stdout: target }) });
    await assert.rejects(submitTerminalInput('work', 'echo safe\r', deps), /会话|pane/i);
    assert.deepEqual(deps.calls, [], 'nothing was loaded or pasted');
  }
});

test('local submissions revalidate pane and connection after loading and clean a cancelled buffer', async () => {
  for (const cancel of ['pane', 'connection']) {
    const deps = submissionDependencies();
    let current = true;
    let reads = 0;
    deps.isCurrent = () => current;
    deps.loadBuffer = async (name, data) => {
      deps.calls.push(['load', name, data]);
      if (cancel === 'connection') current = false;
    };
    deps.execTmux = async (args) => {
      deps.calls.push(args);
      if (args[0] === 'display-message') {
        reads += 1;
        return { stdout: `work\t%${cancel === 'pane' && reads > 1 ? 18 : 17}\n` };
      }
      return { stdout: '' };
    };
    await assert.rejects(submitTerminalInput('work', 'never delivered\r', deps), /会话|连接|pane/i);
    assert.equal(deps.calls.some((args) => args.includes('paste-buffer')), false);
    assert.deepEqual(deps.calls.at(-1), ['delete-buffer', '-b', 'codeck-local-test']);
  }
});

test('local submissions clean a failed load or paste without retrying the user input', async () => {
  for (const stage of ['load', 'paste']) {
    const deps = submissionDependencies();
    if (stage === 'load') deps.loadBuffer = async () => { throw new Error('load failed'); };
    deps.execTmux = async (args) => {
      deps.calls.push(args);
      if (args.includes('paste-buffer')) throw new Error('paste failed');
      return { stdout: 'work\t%17\n' };
    };
    await assert.rejects(submitTerminalInput('work', 'keep draft\r', deps), new RegExp(`${stage} failed`));
    assert.deepEqual(deps.calls.at(-1), ['delete-buffer', '-b', 'codeck-local-test']);
    assert.equal(deps.calls.filter((args) => args.includes('paste-buffer')).length, stage === 'paste' ? 1 : 0);
  }
});

test('local submissions validate size and session before inspecting tmux', async () => {
  const deps = submissionDependencies();
  for (const [session, data] of [['-unsafe', 'pwd\r'], ['work', ''], ['work', 'x'.repeat(100_002)]]) {
    await assert.rejects(submitTerminalInput(session, data, deps), /会话|输入/);
  }
  assert.deepEqual(deps.calls, []);
});

test('local submissions accept the full textarea limit followed by Enter', async () => {
  const deps = submissionDependencies();
  const data = `${'x'.repeat(100_000)}\r`;
  await submitTerminalInput('work', data, deps);
  assert.equal(deps.calls.find((args) => args[0] === 'load')[2], data);
});

test('queued local submissions recheck cancellation before loading any bytes', async () => {
  const deps = submissionDependencies();
  let finishFirst;
  const started = new Promise((resolve) => {
    deps.loadBuffer = async (name, data) => {
      deps.calls.push(['load', name, data]);
      if (data === 'first\r') {
        resolve();
        await new Promise((finish) => { finishFirst = finish; });
      }
    };
  });
  const first = submitTerminalInput('work', 'first\r', deps);
  await started;
  let current = true;
  const second = submitTerminalInput('work', 'cancelled\r', { ...deps, isCurrent: () => current });
  current = false;
  const rejected = assert.rejects(second, /连接|会话/);
  finishFirst();
  await Promise.all([first, rejected]);
  assert.deepEqual(deps.calls.filter((args) => args[0] === 'load').map((args) => args[2]), ['first\r']);
});
