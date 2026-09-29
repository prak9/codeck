import test from 'node:test';
import assert from 'node:assert/strict';
import { interruptSession } from '../src/tmux.js';

const empty = '› \n\n  gpt-6-astra medium · /project';
const params = { provider: 'codex', sessionName: 'work', threadId: 'thread', waitForIdle: true, expectedPaneId: '%7' };
test('natural cleanup defers when a new turn has started and sends no interrupt keys', async () => {
  for (const cachedBusy of [false, true]) {
    const keys = [];
    const result = await interruptSession({ ...params, onlyIfIdle: true, stopGoal: true }, {
      listTmuxSessions: async () => [{ name: 'work', hasRunningProcess: cachedBusy, agent: { kind: 'codex', id: 'thread', paneId: '%7' } }],
      capturePane: async () => `• Working (1s • esc to interrupt)\n${empty}`,
      execTmux: async args => keys.push(args),
    });
    assert.equal(result.deferred, true);
    assert.deepEqual(keys, []);
  }
});
test('A never sends Escape for cached working state with a fresh empty Codex composer', async () => {
  const keys = []; let reads = 0;
  await interruptSession(params, {
    listTmuxSessions: async () => [{ name: 'work', hasRunningProcess: reads++ < 3, agent: { kind: 'codex', id: 'thread', paneId: '%7' } }],
    capturePane: async () => empty, waitForStop: async () => {}, execTmux: async args => keys.push(args),
  });
  assert.deepEqual(keys, []);
});
test('A preserves transcript/edit mode and refuses blind Escape or other keys', async () => {
  const keys = [];
  await assert.rejects(interruptSession(params, {
    listTmuxSessions: async () => [{ name: 'work', hasRunningProcess: true, agent: { kind: 'codex', id: 'thread', paneId: '%7' } }],
    capturePane: async () => '/ T R A N S C R I P T /\n q to quit   esc/← to edit prev   enter to edit message',
    waitForStop: async () => {}, execTmux: async args => keys.push(args),
  }), /历史|输入框|弹窗/);
  assert.deepEqual(keys, []);
});
