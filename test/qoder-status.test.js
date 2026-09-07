import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_SCREEN_MARKERS, resolveAgentActivityText, resolveAgentBackgroundState,
  resolveAgentSessionLiveOutput, resolveScreenSignals, resolveWorkingState,
} from '../src/tmux.js';
import { resolveSessionStatus, sessionSnapshotRefreshInterval, threadSnapshotRefreshInterval } from '../src/session-status.js';
import { latestRunningTurn, tmuxSessionsToThreads } from '../public/agent-model.js';

const footer = [
  '────────────────────────────────────────',
  ' Shift+Tab to Accept Edits     14 skills',
  '────────────────────────────────────────',
  ' > Type your message or @path/to/file',
  '────────────────────────────────────────',
  ' Qwen3.8-Max Model · ctx ░░░░░░░░░░ 0% · /project',
].join('\n');

function sessionFor(screen, animating = false) {
  const signals = { ...resolveScreenSignals(screen, AGENT_SCREEN_MARKERS.qodercli), animating };
  const agent = { kind: 'qodercli', id: 'thread-1' };
  const session = {
    name: 'qoder',
    hasRunningProcess: resolveWorkingState({ agentKind: agent.kind, screenSignals: signals }),
    agent: { ...agent, hasBackgroundProcess: resolveAgentBackgroundState({ agent, screenSignals: signals }) },
  };
  session.status = resolveSessionStatus(session);
  return { session, signals };
}

// QoderCLI 1.1.28 and 1.1.45 render this transient info item with the star
// spinner while streamingState is idle and background local agents are pending/running.
test('Qoder background-agent waits stay background even with no detached process or repaint', () => {
  for (const star of ['✶', '✷', '✸', '✹', '✺']) {
    for (const text of ['Waiting for 1 background agent to finish', 'Waiting for 3 background agents to finish']) {
      for (const animating of [false, true]) {
        const screen = `> Review the code\n\x1b[2m${star} ${text}\x1b[0m\n${footer}`;
        const { session, signals } = sessionFor(screen, animating);
        assert.equal(signals.busy, false);
        assert.equal(signals.background, true, screen);
        assert.equal(session.status, 'background');
        assert.equal(session.hasRunningProcess, false, 'do not enable foreground stop for an idle main agent');
        assert.equal(resolveAgentActivityText('qodercli', screen), '后台任务运行中');
        assert.match(resolveAgentSessionLiveOutput(session.agent, false, signals, screen), /Waiting for/);
        const [thread] = tmuxSessionsToThreads([session]);
        assert.equal(thread.tmux.status, 'background');
        assert.equal(latestRunningTurn(thread), null);
        assert.equal(sessionSnapshotRefreshInterval({ sessions: [session] }), 2_000);
        assert.equal(threadSnapshotRefreshInterval({ thread }, session.status), 2_000);
      }
    }
  }
});

test('Qoder background waits tolerate narrow-pane word wrapping', () => {
  for (const wait of [
    '✶ Waiting for 1 background\n  agent to finish',
    '✸ Waiting for 2\n  background agents to\n  finish',
    '✹ Waiting for 12\n  background agents\n  to finish',
  ]) {
    assert.equal(sessionFor(`${wait}\n${footer}`).session.status, 'background', wait);
  }
});

test('Qoder background waits clear on completion and do not replace later foreground work', () => {
  const waiting = `✶ Waiting for 1 background agent to finish\n${footer}`;
  const working = `⠋ Generating... (esc to cancel, 25s)\n${footer}`;
  const complete = `The review is complete.\n${footer}`;
  assert.deepEqual([waiting, working, complete].map(screen => sessionFor(screen).session.status), [
    'background', 'working', 'done',
  ]);
  assert.equal(resolveAgentActivityText('qodercli', working), '正在生成 · 25秒');
});

test('Qoder does not treat quoted, completed, zero-count, or composer wait text as background activity', () => {
  for (const screen of [
    `Waiting for 1 background agent to finish\n${footer}`,
    `ℹ Waiting for 1 background agent to finish\n${footer}`,
    `> ✶ Waiting for 1 background agent to finish\n${footer}`,
    `✶ Waiting for 0 background agents to finish\n${footer}`,
    `✶ Waited for 1 background agent to finish\n${footer}`,
    `✶ Waiting for 1 background agent to finish\nThe review is complete.\n${footer}`,
    `✶ Waiting for 1 background agent to finish was the previous status.\n${footer}`,
    footer.replace('> Type your message or @path/to/file', '> Explain this status:\n   ✶ Waiting for 1 background agent to finish'),
  ]) {
    assert.equal(sessionFor(screen).session.status, 'done', screen);
  }
  for (const kind of ['codex', 'claude']) {
    assert.deepEqual(resolveScreenSignals(`✶ Waiting for 1 background agent to finish\n${footer}`, AGENT_SCREEN_MARKERS[kind]), {
      busy: false, background: false,
    });
  }
});
