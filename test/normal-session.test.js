import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const appJs = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

test('normal mode enters a created session before refreshing the full session list', () => {
  const start = appJs.indexOf("$('#newForm').addEventListener('submit'");
  const end = appJs.indexOf("\n\n$('#killButton').addEventListener", start);
  const handler = appJs.slice(start, end);
  const create = handler.indexOf("await api('/api/sessions'");
  const connect = handler.indexOf('connect(payload.name)');
  const refresh = handler.indexOf('await refreshSessions()');

  assert.ok(start >= 0 && end > start, 'new-session submit handler exists');
  assert.ok(create >= 0 && connect > create, 'the terminal opens only after tmux creation succeeds');
  assert.ok(refresh > connect, 'a cold session-list scan cannot block terminal attachment');
});

test('normal session polling does not refit an unchanged desktop terminal', () => {
  const start = appJs.indexOf('async function refreshSessions()');
  const end = appJs.indexOf('\n\nfunction connectedStateLabel()', start);
  const refresh = appJs.slice(start, end);

  assert.ok(start >= 0 && end > start, 'session refresh function exists');
  assert.match(refresh, /const activeGridChanged =/);
  assert.match(refresh, /if \(state\.terminal && isMobileOverview\(\) && activeGridChanged\) fitTerminalView\(\);/);
  assert.doesNotMatch(refresh, /if \(state\.active && state\.terminal\) fitTerminalView\(\);/);
});

test('normal mode reuses an open owner socket when switching sessions', () => {
  const start = appJs.indexOf('async function connect(session)');
  const end = appJs.indexOf('\n\nfunction openNewDialog()', start);
  const connect = appJs.slice(start, end);

  assert.ok(start >= 0 && end > start, 'session connect function exists');
  assert.match(connect, /const reuseSocket = state\.canSwitchSession && state\.socket\?\.readyState === WebSocket\.OPEN;/);
  assert.match(connect, /type: 'switch', session, cols: terminal\.cols, rows: terminal\.rows/);
  assert.match(connect, /if \(!reuseSocket\) state\.socket\?\.close\(\);/);
  assert.match(connect, /state\.cancelTerminalWrite\?\.\(\);/);
  assert.match(connect, /const terminalWrites = createTerminalWriteQueue\(terminal\);/);
  assert.match(connect, /terminalWrites\.write\(output, \(\) => \{/);
  assert.doesNotMatch(connect, /terminal\.write\(output/);
  assert.match(connect, /terminalElement\.style\.visibility = 'hidden';/);
  assert.match(connect, /createTerminalRevealGate/);
  assert.doesNotMatch(connect, /pendingOutput|waitingForSwitch|outputReady/);
});

test('normal mode drops stale terminal frames until the switched session reset boundary', () => {
  const start = appJs.indexOf('async function connect(session)');
  const end = appJs.indexOf('\n\nfunction openNewDialog()', start);
  const connect = appJs.slice(start, end);

  assert.match(appJs, /terminalInputReady:\s*false/);
  assert.match(appJs, /state\.canWrite && state\.terminalInputReady && state\.socket\?\.readyState === WebSocket\.OPEN/);
  assert.match(connect, /let awaitingSwitchReset = reuseSocket;/);
  assert.match(connect, /if \(awaitingSwitchReset\) \{[\s\S]*?event\.data !== '\\x1bc'[\s\S]*?switchResetFrame = true;/);
  assert.match(connect, /terminalWrites\.write\(output, \(\) => \{[\s\S]*?if \(switchResetFrame\) \{[\s\S]*?state\.terminalInputReady = true;/);
});

test('normal mode shares the sequenced owner session feed with remote mode', () => {
  assert.match(appJs, /acceptStreamCursor/);
  assert.match(appJs, /message\.type === 'sessionsSnapshot'/);
  assert.match(appJs, /SESSION_LIST_FALLBACK_MS\s*=\s*30_000/);
  assert.match(appJs, /!state\.sessionStreamHealthy/);
  assert.doesNotMatch(appJs, /SESSION_LIST_POLL_MS\s*=\s*3_000/);
});

test('normal mode suppresses Codex shared-daemon background counts', () => {
  assert.match(appJs, /hideSharedCodexBackgroundFooter/);
  assert.match(appJs, /const output = terminalOutputForSession\(event\.data, session\);/);
  assert.match(appJs, /terminalWrites\.write\(output, \(\) => \{/);
});

test('normal terminal output does not wait for input focus to repaint', () => {
  assert.match(appJs, /bindTerminalRenderWatchdog\(terminal, \{ isVisible: \(\) => !document\.hidden \}\)/);
  assert.match(appJs, /if \(!document\.hidden && state\.terminal\) state\.terminal\.refresh\(0, state\.terminal\.rows - 1\)/);
});
