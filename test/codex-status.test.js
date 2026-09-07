import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_SCREEN_MARKERS, resolveAgentActivityText, resolveAgentBackgroundState,
  resolveAgentLiveOutput, resolveScreenSignals, resolveWorkingState,
} from '../src/tmux.js';
import { resolveSessionStatus } from '../src/session-status.js';

const footer = '  gpt-6-astra · /project';
const draft = Array.from({ length: 12 }, (_, index) => `${index ? ' ' : '›'} Draft line ${index + 1}`).join('\n');
const screenFor = (status, composer = draft, model = footer) => `${status}\n\n${composer}\n\n${model}`;
function statusFor(screen) {
  const screenSignals = { ...resolveScreenSignals(screen, AGENT_SCREEN_MARKERS.codex), animating: false };
  const agent = { kind: 'codex' };
  return resolveSessionStatus({
    hasRunningProcess: resolveWorkingState({ agentKind: 'codex', screenSignals }),
    agent: { ...agent, hasBackgroundProcess: resolveAgentBackgroundState({ agent, screenSignals }) },
  });
}

test('Codex status and activity remain visible above a multiline composer', () => {
  for (const model of [footer, '  gpt-6-astra xhigh…']) {
    const wait = screenFor('• Ran npm test\n• Waiting for background terminal (25s)', draft, model);
    assert.equal(statusFor(wait), 'working');
    assert.equal(resolveAgentActivityText('codex', wait), '等待后台进程 · 25秒');
    assert.equal(resolveAgentLiveOutput('codex', wait), '• Ran npm test\n• Waiting for background terminal (25s)');
    assert.equal(statusFor(screenFor('◦ Working (25s • esc to interrupt)', draft, model)), 'working');
    assert.equal(statusFor(screenFor('• Waited for background terminal\nThe command finished.', draft, model)), 'done');
  }
});

test('Codex background waiting supports reduced motion and narrow truncation', () => {
  const marker = 'Waiting for background terminal (2h 04m 00s • esc to interrupt)';
  for (let cols = 20; cols <= marker.length; cols += 1) {
    const line = cols === marker.length ? marker : `${marker.slice(0, cols - 1)}…`;
    const screen = screenFor(line, '› Ask Codex to do anyth');
    assert.equal(statusFor(screen), 'working', line);
    assert.match(resolveAgentActivityText('codex', screen), /^等待后台进程/);
  }
  assert.equal(statusFor(screenFor('Waiting for background terminal (25s)')), 'working');
  const indented = screenFor('  • Waiting for background terminal (25s)');
  assert.equal(statusFor(indented), 'working');
  assert.equal(resolveAgentActivityText('codex', indented), '等待后台进程 · 25秒');
});

test('Codex does not turn draft contents or explanatory wait text into activity', () => {
  for (const line of [
    'Working (25s • esc to interrupt)',
    'Waiting for background terminal (25s)',
    'Waiting for backgro…',
    '• Waiting for background terminal (25s)',
  ]) {
    const screen = screenFor('The command finished.', `› Explain this message:\n  ${line}`);
    assert.equal(statusFor(screen), 'done', screen);
  }
  for (const line of [
    'Waiting for background terminal is a status label.',
    '• Waiting for background terminal is a status label.',
    '• Waited for background terminal (25s)',
    '• Waiting for backup…',
    '• Waiting for background task…',
  ]) assert.equal(statusFor(screenFor(line, '› Follow up')), 'done', line);
});

test('Codex composerless active turns and other provider markers retain their behavior', () => {
  assert.equal(statusFor('› Previous request\nWaiting for background terminal (25s)'), 'working');
  assert.equal(statusFor('› Previous request\n◦ Working (25s • esc to interrupt)'), 'working');
  for (const kind of ['claude', 'qodercli']) {
    assert.deepEqual(resolveScreenSignals(screenFor('Waiting for background terminal (25s)'), AGENT_SCREEN_MARKERS[kind]), {
      busy: false, background: false,
    });
  }
});
