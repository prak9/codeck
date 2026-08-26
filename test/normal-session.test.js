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
