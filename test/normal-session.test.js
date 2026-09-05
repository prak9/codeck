import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const appJs = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const indexHtml = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const stylesCss = fs.readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
const serverJs = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');

test('normal terminal replaces the slow DOM fallback with WebGL when the browser supports it', () => {
  const xtermScript = indexHtml.indexOf('/vendor/xterm/xterm.js');
  const webglScript = indexHtml.indexOf('/vendor/webgl/addon-webgl.js');
  const appScript = indexHtml.indexOf('/app.js?');

  assert.ok(xtermScript >= 0 && webglScript > xtermScript && appScript > webglScript,
    'WebGL must load after xterm and before the application starts');
  assert.match(serverJs, /app\.use\('\/vendor\/webgl', express\.static\([^\n]+@xterm\/addon-webgl\/lib/);
  assert.match(appJs, /activateTerminalWebgl\(terminal, globalThis\.WebglAddon\?\.WebglAddon\)/);
});

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

test('normal terminal deduplicates browser and tmux grids before sending resize', () => {
  const ensureStart = appJs.indexOf('function ensureTerminal()');
  const ensureEnd = appJs.indexOf('\n\nfunction isMobileOverview()', ensureStart);
  const fitStart = appJs.indexOf('function fitTerminalView(');
  const fitEnd = appJs.indexOf('\n\nfunction markActiveSession(', fitStart);
  const connectStart = appJs.indexOf('async function connect(session)');
  const connectEnd = appJs.indexOf('\n\nfunction openNewDialog()', connectStart);
  const terminalPath = appJs.slice(ensureStart, connectEnd);

  assert.match(appJs, /createTerminalResizeGate/);
  assert.match(appJs.slice(ensureStart, ensureEnd), /state\.terminalResizeGate\?\.send\(cols, rows\)/);
  assert.match(appJs.slice(fitStart, fitEnd), /state\.terminalResizeGate\?\.send\(terminal\.cols, terminal\.rows\)/);
  assert.match(appJs.slice(connectStart, connectEnd), /const resizeGate = createTerminalResizeGate/);
  assert.match(appJs.slice(connectStart, connectEnd), /state\.terminalResizeGate = resizeGate/);
  assert.match(appJs.slice(connectStart, connectEnd), /resizeGate\.mark\(terminal\.cols, terminal\.rows\)/);
  assert.equal([...terminalPath.matchAll(/socket\.send\(JSON\.stringify\(\{ type: 'resize'/g)].length, 1,
    'only the resize gate may write a resize frame');
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

test('normal mode acknowledges parsed terminal output within a per-screen flow epoch', () => {
  const start = appJs.indexOf('async function connect(session)');
  const end = appJs.indexOf('\n\nfunction openNewDialog()', start);
  const connect = appJs.slice(start, end);

  assert.match(appJs, /createTerminalOutputAcknowledger/);
  assert.match(connect, /flowControl:\s*'1',\s*flowId/);
  assert.match(connect, /type: 'switch', session, cols: terminal\.cols, rows: terminal\.rows, flowId/);
  assert.match(connect, /outputAcks\.acknowledge\(event\.data\.length\)/);
  assert.match(connect, /state\.cancelTerminalOutputAck\?\.\(\);/);
});

test('normal mode does not forward an old terminal reply through a replacement socket', () => {
  const start = appJs.indexOf('async function connect(session)');
  const end = appJs.indexOf('\n\nfunction openNewDialog()', start);
  const connect = appJs.slice(start, end);

  assert.match(connect, /let terminalResetReady = !needsReset;/);
  assert.match(connect, /const enableTerminalInput = \(\) => \{[\s\S]*?terminalResetReady[\s\S]*?state\.terminalInputReady = true;/);
  assert.match(connect, /socket\.onopen = reuseSocket \? null : \(\) => \{[\s\S]*?enableTerminalInput\(\);/);
  assert.match(connect, /await reset;[\s\S]*?terminalResetReady = true;[\s\S]*?enableTerminalInput\(\);/);
  assert.doesNotMatch(connect, /socket\.onopen = reuseSocket \? null : \(\) => \{\s*state\.terminalInputReady = true;/);
});

test('normal mode shares the sequenced owner session feed with remote mode', () => {
  // 服务端 v2 已随 remote 页上线, 终端页这次跟上: 整份快照每帧 ~2.9KB,
  // 而增量帧只有几百字节。闸门从"还不许用 v2"换成"必须把 v2 用完整"。
  assert.match(appJs, /new WebSocket\(`\$\{protocol\}\/\/\$\{location\.host\}\/agent\?streamVersion=2`/);
  assert.match(appJs, /message\.type === 'sessionsSnapshot'/);
  assert.match(appJs, /message\.type === 'sessionsPatch'/);
  assert.match(appJs, /message\.type === 'sessionsSynchronized'/);
  assert.match(appJs, /acceptStreamFrame/);
  assert.match(appJs, /applySnapshotPatch/);
  assert.match(appJs, /SESSION_LIST_FALLBACK_MS\s*=\s*30_000/);
  assert.match(appJs, /!state\.sessionStreamHealthy/);
  assert.doesNotMatch(appJs, /SESSION_LIST_POLL_MS\s*=\s*3_000/);
});

test('the normal-mode v2 client subscribes for itself and can fall back to a full snapshot', () => {
  // 服务端只对 v1 在连接时自动订阅 (agent-connection.js), v2 不自己发就一帧都收不到。
  assert.match(appJs, /protocol\?\.version === 2 && socket\.readyState === WebSocket\.OPEN/);
  assert.match(appJs, /type: 'subscribeSessions'/);
  // 补丁接不上必须能退回整份快照, 否则侧栏就此停更。
  assert.match(appJs, /accepted\.gap \|\| !state\.sessionStreamSnapshot/);
});

test('the sidebar only rebuilds when what it renders actually changed', () => {
  // 任一会话工作时服务端按 750ms 推送, activityAt 每秒都在跳, 但侧栏显示的
  // 相对时间是分桶的 —— 没变还重建 DOM 就是在和 xterm 抢主线程。
  assert.match(appJs, /sessionsRenderSignature/);
  assert.match(appJs, /if \(!force && signature === sessionRenderSignature\) return;/);
  // 事件委托: 不再每轮渲染给每一行重绑监听器。
  assert.match(appJs, /bindSessionListDelegates/);
  assert.doesNotMatch(appJs, /list\.querySelectorAll\('\.session-row'\)\.forEach/);
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

test('normal mode exposes one-click copy for the latest completed model reply', () => {
  assert.equal([...indexHtml.matchAll(/data-agent-output-copy/g)].length, 2,
    'desktop and mobile controls both expose the action');
  assert.match(indexHtml, /data-agent-output-copy[^>]+aria-label="复制最新模型输出"/);
  assert.match(appJs, /latestAgentOutputText/);
  assert.match(appJs, /sessionFeedRequest\('loadThreadHistory'/);
  assert.match(appJs, /message\.id/,
    'the existing owner Agent socket must route request responses as well as session events');
  assert.match(appJs, /writeAgentOutputToClipboard\([^)]*\.text/,
    'the click copies prefetched structured output rather than scraping terminal rows');
  assert.match(appJs, /entry\?\.state === 'empty' \? '暂无回复'/);
  assert.match(stylesCss, /\.mobile-agent-copy[^}]*min-height:\s*44px/s,
    'the mobile copy action keeps a full touch target');
});
