import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const html = fs.readFileSync(new URL('../public/remote.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../public/remote.css', import.meta.url), 'utf8');
const remoteJs = fs.readFileSync(new URL('../public/remote.js', import.meta.url), 'utf8');
const appJs = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const appCss = fs.readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
const rootCss = css.match(/^:root\s*\{([\s\S]*?)^\}/m)?.[1] || '';

function rootBreakpoint(cssText, width) {
  const match = cssText.match(new RegExp(`@media \\(min-width: ${width}px\\) \\{\\s*:root \\{([^}]*)\\}`));
  return match?.[1] || '';
}

test('remote keeps Courier New in the conversation and uses the normal Apple-style UI font in the sidebar', () => {
  assert.match(html, /\/fonts\/inter\/wght\.css/);
  assert.match(html, /\/fonts\/noto-sans-sc\/wght\.css/);
  assert.match(rootCss, /font-family:\s*"Courier New",\s*Courier,\s*"Noto Sans SC Variable",\s*monospace/);
  assert.match(css, /\.thread-drawer\s*\{[^}]*font-family:\s*"Inter Variable",\s*"Noto Sans SC Variable",\s*sans-serif/s);
  assert.match(css, /\.terminal-live-output[^}]+"Courier New"/s);
});

test('remote restores and persists a selectable light theme before first paint', () => {
  assert.ok(html.indexOf("localStorage.getItem('codeck-remote-theme')") < html.indexOf('/remote.css'));
  assert.match(html, /id="settingsTheme"[\s\S]*value="dark"[\s\S]*value="light"/);
  assert.match(remoteJs, /function applyTheme\(/);
  assert.match(remoteJs, /localStorage\.setItem\('codeck-remote-theme'/);
  assert.match(css, /:root\[data-theme="light"\]\s*\{[^}]*color-scheme:\s*light[^}]*--base:\s*#fff[^}]*--ink:\s*#111/s);
});

test('remote light theme uses the neutral floating surfaces from the supplied reference', () => {
  assert.match(css, /:root\[data-theme="light"\] \.conversation-shell\s*\{[^}]*background:\s*#fff;/s);
  assert.match(css, /:root\[data-theme="light"\] \.user-message\s*\{[^}]*background:\s*#f4f4f4;[^}]*color:\s*#111;/s);
  assert.match(css, /:root\[data-theme="light"\] \.tool-card\s*\{[^}]*background:\s*#f7f7f8;/s);
  assert.match(css, /:root\[data-theme="light"\] \.composer\s*\{[^}]*border-radius:\s*29px;[^}]*background:\s*#fff;[^}]*box-shadow:\s*0 12px 36px #00000012/s);
  assert.match(css, /:root\[data-theme="light"\] \.sheet\s*\{[^}]*background:\s*#fff;/s);
  assert.match(html, /\/remote\.css\?v=25/);
});

test('a closed mobile drawer cannot cast a shadow over the conversation', () => {
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.thread-drawer\s*\{[^}]*box-shadow:\s*none[^}]*\}[\s\S]*?\.thread-drawer\.open\s*\{[^}]*box-shadow:/s);
});

test('remote desktop uses the normal workspace width and sidebar breakpoints', () => {
  assert.match(css, /--content:\s*100%/);

  for (const [width, drawer, gutter] of [[1800, 310, 24], [3000, 350, 32], [4500, 390, 42]]) {
    assert.match(rootBreakpoint(appCss, width), new RegExp(`--sidebar-width:\\s*${drawer}px`));
    assert.match(rootBreakpoint(css, width), new RegExp(`--drawer:\\s*${drawer}px`));
    assert.match(rootBreakpoint(css, width), new RegExp(`--workspace-gutter:\\s*${gutter}px`));
  }

  assert.match(css, /\.assistant-message\s*\{[^}]*max-width:\s*78ch/s);
  assert.match(css, /@media \(min-width: 1800px\)\s*\{[^}]*\}[^}]*\.assistant-message\s*\{[^}]*max-width:\s*100%/s);
  assert.match(css, /\.user-message\s*\{[^}]*620px/s);
  assert.match(css, /grid-template-columns:\s*92px minmax\(0, 1fr\) 92px/);
});

test('completed model turns expose a touch-accessible copy action', () => {
  assert.match(remoteJs, /agentOutputText\(turn\)/);
  assert.match(remoteJs, /setAttribute\('aria-label', '复制本轮模型输出'\)/);
  assert.match(css, /\.message-copy-button\s*\{[^}]*min-height:\s*34px/s);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.message-copy-button\s*\{[^}]*min-height:\s*44px/s);
});

test('skills command renders as a structured panel instead of plain terminal text', () => {
  assert.match(remoteJs, /parseSkillsCommandOutput/);
  assert.match(remoteJs, /skillsCommandDialog\(commandOutput\)/);
  assert.match(css, /\.skills-panel\s*\{[^}]*overflow:\s*clip/s);
  assert.match(css, /\.skill-row\s*\{[^}]*grid-template-columns:\s*minmax\(112px,\s*32%\)/s);
});

test('model command renders as a selectable popup list', () => {
  assert.match(remoteJs, /parseModelCommandOutput/);
  assert.match(remoteJs, /modelCommandDialog\(commandOutput\)/);
  assert.match(remoteJs, /openCommandDialog\(commandOutput\)/);
  assert.match(remoteJs, /modelRowButton\(/);
  assert.match(remoteJs, /modelRowButton\(item, parsed\.selected\)/);
  assert.match(remoteJs, /dialog\.showModal\(\)/);
  assert.match(remoteJs, /commandPendingMessage\(/);
  assert.match(remoteJs, /setLiveMessage\(commandPendingMessage\(input\.value\)\)/);
  assert.match(remoteJs, /form\.requestSubmit\(\)/);
  assert.match(css, /\.model-panel\s*\{[^}]*overflow:\s*clip/s);
  assert.match(css, /\.model-row\s*\{[^}]*grid-template-columns:\s*minmax\(112px,\s*32%\)/s);
});

test('model picker can be dismissed without sending a model selection', () => {
  assert.match(html, /<dialog[^>]*class="sheet command-sheet"[^>]*id="commandDialog"/);
  assert.match(html, /id="commandDialogClose"[^>]*type="button"[^>]*aria-label="关闭命令弹窗"/);
  assert.match(remoteJs, /function dismissCommandDialog\(/);
  assert.match(remoteJs, /delete state\.thread\.tmux\.commandOutput/);
  assert.match(remoteJs, /\$\('#commandDialog'\)\.addEventListener\('cancel'/);
  assert.match(remoteJs, /event\.target === event\.currentTarget/);
});

test('all slash command results use the same dismissible dialog', () => {
  assert.match(html, /<dialog[^>]*class="sheet command-sheet"[^>]*id="commandDialog"/);
  assert.match(remoteJs, /function openCommandDialog\(commandOutput\)/);
  assert.match(remoteJs, /commandOutput\.command === '\/model'/);
  assert.match(remoteJs, /commandOutput\.command === '\/skills'/);
  assert.match(remoteJs, /commandOutput\?\.command\?\.startsWith\('\/'\)/);
  assert.match(remoteJs, /function dismissCommandDialog\(/);
});

test('normal and remote sidebars use the same ready and background status labels', () => {
  for (const source of [appJs, remoteJs]) {
    assert.match(source, /status === 'background'/);
    assert.match(source, /'后台运行'/);
    assert.match(source, /'已就绪'/);
    assert.doesNotMatch(source, /:\s*'完成'/);
  }
  for (const source of [appCss, css]) {
    assert.match(source, /\.presence\.background/);
  }
});

test('normal sidebar matches the remote session hierarchy and restores its UI typography', () => {
  assert.match(appJs, /const meta = \[statusText, timeAgo\(session\.activityAt\)\]\.filter\(Boolean\)\.join\(' · '\)/);
  assert.match(appJs, /<span class="session-copy"><b[^>]*>\$\{escapeHtml\(session\.name\)\}<\/b><small>\$\{escapeHtml\(meta\)\}<\/small><\/span>/);
  assert.doesNotMatch(appJs, /tmux \$\{escapeHtml\(session\.name\)\}/);

  assert.doesNotMatch(appCss, /\.sidebar\s*\{[^}]*font-family:/s);
  assert.match(appCss, /html, body\s*\{[^}]*font-family:\s*"Inter Variable",\s*"Noto Sans SC Variable",\s*sans-serif/s);
  assert.doesNotMatch(appCss, /\.session-row\s*\{[^}]*min-height:\s*(?:66|72|78)px/s);
  assert.doesNotMatch(appCss, /\.session-copy b\s*\{[^}]*font-size:\s*(?:13|14|15)px/s);
});

test('unchanged Agent transcript refreshes are reconciled without a full redraw', () => {
  assert.match(remoteJs, /reconcileAgentThreadRefresh/);
  assert.match(remoteJs, /if \(reconciled === state\.thread\) return/);
});

test('a completed tmux turn waits for the authoritative session status', () => {
  assert.doesNotMatch(
    remoteJs,
    /message\.method === 'turn\/completed'\)\s*\{\s*updateThreadActivity\([^;]*'done'/s,
  );
  assert.match(remoteJs, /message\.method === 'turn\/completed'[\s\S]*loadThreads\(\{ quiet: true \}\)/);
});

test('remote slash commands use explicit pending status messages', () => {
  assert.match(remoteJs, /commandPendingMessage\(/);
  assert.match(remoteJs, /'正在读取状态…'/);
  assert.match(remoteJs, /'正在切换模型…'/);
});

test('remote slash command completion is accessible without shifting the composer', () => {
  assert.match(html, /id="composerInput"[^>]*role="combobox"/);
  assert.match(html, /id="composerInput"[^>]*aria-controls="slashCommandMenu"/);
  assert.match(html, /id="slashCommandMenu"[^>]*role="listbox"/);
  assert.match(css, /\.slash-command-menu\s*\{[^}]*position:\s*absolute/s);
  assert.match(css, /\.slash-command-option\s*\{[^}]*min-height:\s*44px/s);
  assert.match(remoteJs, /event\.key === 'ArrowDown'/);
  assert.match(remoteJs, /event\.key === 'Tab'/);
  assert.match(remoteJs, /event\.key === 'Escape'/);
  assert.match(remoteJs, /addEventListener\('pointerdown'/);
});

test('remote composer exposes an accessible image and file attachment flow', () => {
  assert.match(html, /id="attachmentDialog"/);
  assert.match(html, /id="attachmentImageInput"[^>]*type="file"[^>]*accept="image\/\*"[^>]*multiple/);
  assert.match(html, /id="attachmentFileInput"[^>]*type="file"[^>]*multiple/);
  assert.match(html, /id="attachmentTray"[^>]*aria-live="polite"/);
  assert.match(html, /id="composerPlus"[^>]*aria-label="添加图片或文件"/);
  assert.match(remoteJs, /function renderAttachments\(/);
  assert.match(remoteJs, /function uploadAttachment\(/);
  assert.match(remoteJs, /Promise\.allSettled\(attachments\.map\(uploadAttachment\)\)/);
  assert.match(remoteJs, /attachmentMessage\(/);
  assert.match(css, /\.attachment-remove\s*\{[^}]*width:\s*44px[^}]*height:\s*44px/s);
  assert.match(css, /\.attachment-tray\s*\{[^}]*overflow-x:\s*auto/s);
  assert.match(css, /\.composer-stack\s*\{[^}]*min-width:\s*0/s);
  assert.match(css, /\.attachment-tray\s*\{[^}]*max-width:\s*100%/s);
});
