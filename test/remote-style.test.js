import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const html = fs.readFileSync(new URL('../public/remote.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../public/remote.css', import.meta.url), 'utf8');
const remoteJs = fs.readFileSync(new URL('../public/remote.js', import.meta.url), 'utf8');
const speechJs = fs.readFileSync(new URL('../public/remote-speech.js', import.meta.url), 'utf8');
const appJs = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const appCss = fs.readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
const appHtml = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const rootCss = css.match(/^:root\s*\{([\s\S]*?)^\}/m)?.[1] || '';

function rootBreakpoint(cssText, width) {
  const match = cssText.match(new RegExp(`@media \\(min-width: ${width}px\\) \\{\\s*:root \\{([^}]*)\\}`));
  return match?.[1] || '';
}

test('remote keeps Courier New in the conversation and uses the normal Apple-style UI font in the sidebar', () => {
  assert.match(html, /\/fonts\/inter\/wght\.css/);
  assert.match(html, /\/fonts\/noto-sans-sc\/wght\.css/);
  // 界面用 Inter、正文用等宽 —— 与终端页同样的分工, 切换模式不该换一套界面字体。
  assert.match(rootCss, /font-family:\s*"Inter Variable",\s*"Noto Sans SC Variable",\s*sans-serif/);
  assert.match(css, /\.turns \{[^}]*font-family: "Courier New"/s);
  assert.match(css, /\.thread-drawer\s*\{[^}]*font-family:\s*"Inter Variable",\s*"Noto Sans SC Variable",\s*sans-serif/s);
  assert.match(css, /\.terminal-live-output[^}]+"Courier New"/s);
});

test('remote voice input is touch-sized, accessible and absent when unsupported', () => {
  assert.ok(html.indexOf('SpeechRecognition') < html.indexOf('/remote.css'));
  assert.match(html, /id="voiceInputButton"[^>]*type="button"[^>]*aria-label="开始语音输入"[^>]*aria-pressed="false"/);
  assert.match(html, /id="speechInputStatus"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(css, /\.speech-input \.composer\s*\{[^}]*grid-template-columns:\s*44px minmax\(0, 1fr\) 44px 44px/s);
  assert.match(css, /\.voice-input-button\s*\{[^}]*width:\s*44px;[^}]*height:\s*44px/s);
  assert.match(css, /\.voice-input-button\s*\{[^}]*display:\s*none/s);
  assert.match(css, /\.speech-input \.voice-input-button\s*\{[^}]*display:\s*grid/s);
  assert.match(css, /\.voice-input-button\.listening/);
  assert.match(remoteJs, /createSpeechInput\(/);
  assert.match(remoteJs, /voiceInputButton'[\s\S]*pointerdown[\s\S]*preventDefault\(\)/);
  assert.match(remoteJs, /speechInput\.abort\(\)/);
  assert.doesNotMatch(speechJs, /fetch\(|WebSocket|MediaRecorder/);
});

test('remote restores and persists a selectable light theme before first paint', () => {
  assert.ok(html.indexOf("localStorage.getItem('codeck-remote-theme')") < html.indexOf('/remote.css'));
  assert.match(html, /id="settingsTheme"[\s\S]*value="dark"[\s\S]*value="light"/);
  assert.match(remoteJs, /function applyTheme\(/);
  assert.match(remoteJs, /localStorage\.setItem\('codeck-remote-theme'/);
  assert.match(css, /:root\[data-theme="light"\]\s*\{[^}]*color-scheme:\s*light[^}]*--base:\s*#fff[^}]*--ink:\s*#111/s);
});

test('remote new sessions request and submit a tmux session name', () => {
  assert.match(html, /<dialog class="sheet settings-sheet" id="newSessionDialog">/);
  assert.match(html, /<label for="sessionNameInput">会话名称<\/label>/);
  assert.match(html, /id="sessionNameInput"[^>]*name="name"[^>]*required/);
  assert.match(remoteJs, /createRemoteSessionPayload/);
  assert.match(remoteJs, /fetch\('\/api\/sessions'/);
  assert.match(remoteJs, /\$\('#drawerNewButton'\)\.addEventListener\('click', openNewSession\)/);
  assert.match(remoteJs, /\$\('#newThreadButton'\)\.addEventListener\('click', openNewSession\)/);
  assert.match(remoteJs, /if \(!state\.thread\)[\s\S]{0,180}openNewSession\(\)/);
  assert.doesNotMatch(remoteJs, /agentRequest\('newThread'/);
});

test('remote keeps the overflow menu as settings instead of session creation', () => {
  const settingsDialog = html.match(/<dialog class="sheet settings-sheet" id="settingsDialog">([\s\S]*?)<\/dialog>/)?.[1] || '';
  assert.match(settingsDialog, /<h2>设置<\/h2>/);
  assert.match(settingsDialog, /id="settingsTheme"/);
  assert.doesNotMatch(settingsDialog, /sessionNameInput/);
  assert.match(remoteJs, /\$\('#settingsButton'\)\.addEventListener\('click', openSettings\)/);
  assert.match(remoteJs, /\$\('#cwdButton'\)\.addEventListener\('click', openSettings\)/);
  assert.match(remoteJs, /\$\('#newSessionForm'\)\.addEventListener\('submit'/);
  assert.match(remoteJs, /\$\('#settingsForm'\)\.addEventListener\('submit'/);
});

test('remote closes only the active tmux session after explicit confirmation', () => {
  const settingsDialog = html.match(/<dialog class="sheet settings-sheet" id="settingsDialog">([\s\S]*?)<\/dialog>/)?.[1] || '';
  const closeDialog = html.match(/<dialog class="sheet destructive-sheet" id="closeSessionDialog"[\s\S]*?<\/dialog>/)?.[0] || '';

  assert.match(settingsDialog, /id="closeSessionButton"[^>]*type="button"[^>]*hidden/);
  assert.match(closeDialog, /id="closeSessionName"/);
  assert.match(closeDialog, /id="confirmCloseSessionButton"[^>]*type="submit"/);
  assert.match(closeDialog, /未保存的进程状态和当前草稿会丢失/);
  assert.match(remoteJs, /function requestSessionClose\(name\)/);
  assert.match(remoteJs, /fetch\(`\/api\/sessions\/\$\{encodeURIComponent\(name\)\}`,[\s\S]*method: 'DELETE'/);
  assert.match(remoteJs, /nextThreadAfterClose\(state\.threads, sessionName\)/);
  assert.match(remoteJs, /sessionClosePending/);
  assert.match(remoteJs, /clearAttachments\(\[\.\.\.state\.attachments\]\)/);
  assert.match(css, /\.destructive-button\s*\{[^}]*min-height:\s*44px/s);
});

test('remote light theme uses the neutral floating surfaces from the supplied reference', () => {
  assert.match(css, /:root\[data-theme="light"\] \.conversation-shell\s*\{[^}]*background:\s*#fff;/s);
  assert.match(css, /:root\[data-theme="light"\] \.user-message\s*\{[^}]*background:\s*#f4f4f4;[^}]*color:\s*#111;/s);
  assert.match(css, /:root\[data-theme="light"\] \.tool-card\s*\{[^}]*background:\s*#f7f7f8;/s);
  assert.match(css, /:root\[data-theme="light"\] \.composer\s*\{[^}]*border-radius:\s*29px;[^}]*background:\s*#fff;[^}]*box-shadow:\s*0 12px 36px #00000012/s);
  assert.match(css, /:root\[data-theme="light"\] \.sheet\s*\{[^}]*background:\s*#fff;/s);
  assert.match(html, /\/remote\.css\?v=32/);
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
  assert.match(remoteJs, /agentRequest\('selectSessionModel'/);
  assert.doesNotMatch(remoteJs, /input\.value = `\/model \$\{label\}`/);
  assert.match(remoteJs, /dialog\.showModal\(\)/);
  assert.match(remoteJs, /commandPendingMessage\(/);
  assert.match(remoteJs, /setLiveMessage\(`正在选择 \$\{label\}…`\)/);
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

test('remote streaming reuses unchanged turn nodes instead of rebuilding the whole transcript', () => {
  assert.match(remoteJs, /reconcileChildOrder/);
  assert.match(remoteJs, /existingTurnNodes/);
  assert.match(remoteJs, /node\?\._codeckTurn === turn/);
  assert.doesNotMatch(remoteJs, /\$\('#turns'\)\.replaceChildren\(\.\.\.nodes\)/);
});

test('default terminal activity updates in place without scheduling a replacement render', () => {
  assert.match(remoteJs, /const shell = state\.thread\?\.provider === 'shell';[\s\S]*?return \{\s*kind: 'text',\s*status: working \? 'working' : 'done'/);
});

test('remote consumes sequenced session and thread snapshots before using slow polling fallbacks', () => {
  assert.match(remoteJs, /message\.type === 'sessionsSnapshot'/);
  assert.match(remoteJs, /message\.type === 'threadSnapshot'/);
  assert.match(remoteJs, /acceptStreamCursor/);
  assert.match(remoteJs, /matchesThreadStreamTarget/);
  assert.match(remoteJs, /SESSION_LIST_FALLBACK_MS\s*=\s*30_000/);
  assert.match(remoteJs, /THREAD_REFRESH_FALLBACK_MS\s*=\s*10_000/);
  assert.match(remoteJs, /Date\.now\(\) < state\.threadCompletionRefreshUntil[\s\S]*?refreshActiveThread\(\{ force: true \}\)/);
  assert.doesNotMatch(remoteJs, /Date\.now\(\) < state\.threadRefreshUntil[\s\S]*?refreshActiveThread\(\)/);
  assert.match(remoteJs, /if \(applyTmuxSnapshot[\s\S]*?refreshActiveThread\(\{ force: true \}\)/);
  assert.doesNotMatch(remoteJs, /SESSION_LIST_POLL_MS\s*=\s*1_500/);
  assert.doesNotMatch(remoteJs, /THREAD_REFRESH_POLL_MS\s*=\s*1_000/);
});

test('remote sends stable command ids and preserves an uncertain draft for safe retry', () => {
  assert.match(remoteJs, /prepareDeliveryAttempt/);
  assert.match(remoteJs, /commandId:\s*delivery\.commandId/);
  assert.match(remoteJs, /shouldKeepDeliveryAttempt/);
  assert.match(remoteJs, /发送状态未知/);
});

test('an accepted tmux message is echoed before an Agent turn exists', () => {
  assert.match(remoteJs, /if \(stillActive\) \{[\s\S]{0,180}state\.thread = applyAcceptedUserMessage/);
  assert.doesNotMatch(remoteJs, /if \(delivery\.turnId\) \{\s*state\.thread = applyAcceptedUserMessage/s);
  assert.match(remoteJs, /userMessageDeliveryBaseline\(state\.thread, text\)/);
  assert.match(remoteJs, /baselineUserMessageId:\s*delivery\.baselineUserMessageId/);
  assert.match(remoteJs, /baselineMatchingTextCount:\s*delivery\.baselineMatchingTextCount/);
  assert.match(remoteJs, /targetProvider !== 'shell' && !message\.trimStart\(\)\.startsWith\('\/'\)/);
  assert.match(remoteJs, /if \(!turn\.deliveryOnly\)/);
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

test('the load-earlier control is styled', () => {
  // 首帧只带尾部若干轮时顶部会出现这个按钮; 没样式会挤在转录内容里。
  assert.match(css, /\.load-earlier\s*\{[^}]*display:\s*flex/s);
  assert.match(css, /\.load-earlier button:disabled/s);
});

test('remote carries the way back to terminal mode in the header, where a phone can reach it', () => {
  // 之前三个入口全在抽屉和设置弹层里; 普通模式那边是顶栏上一个常驻链接。两边对称。
  assert.match(html, /<a class="header-button" href="\/" data-terminal-mode aria-label="切换到终端模式">/);
  assert.match(css, /\.conversation-header \{[^}]*grid-template-columns: 44px minmax\(0, 1fr\) 132px/s);
});

test('both modes draw their chrome in the same face, so switching does not restyle the product', () => {
  // 两边正文早就都是 Courier New、侧栏都是 Inter; 分歧只剩会话图标、kbd 这些小徽标 ——
  // 终端页为它们单独拉了一份 JetBrains Mono。统一到正文那一款, 顺带省掉一个网络字体。
  assert.doesNotMatch(appCss, /JetBrains/);
  assert.doesNotMatch(appHtml, /jetbrains/);
  for (const sheet of [appCss, css]) {
    assert.match(sheet, /\.brand-mark[^}]*"Courier New"/s);
  }
});

test('the terminal output card is cleared once it should no longer show, working or not', () => {
  // 清理条件曾经挂在 .working 上, 而那个元素只在"正在工作"时存在。agent 收尾后面板
  // 是 done 状态, 于是没有任何东西来移除它, 那个框就一直留在对话里。
  assert.match(remoteJs, /if \(!visible\) \{[\s\S]{0,400}?if \(section\) scheduleThreadRender\(false\)/);
  assert.doesNotMatch(remoteJs, /if \(!visible\) \{[\s\S]{0,300}?if \(current\) scheduleThreadRender/);
});

test('leaving the conversation for the terminal keeps the session you were in', () => {
  // 三个入口都是裸 href="/", 于是从某个会话的对话里出去会落到终端的默认页面。
  assert.match(html, /href="\/" data-terminal-mode/);
  assert.match(remoteJs, /a\[data-terminal-mode\]/);
  assert.match(remoteJs, /\/\?session=\$\{encodeURIComponent\(name\)\}/);
  // 终端页只认真实存在的会话名, 不让 URL 里的任意字符串生效。
  assert.match(appJs, /state\.sessions\.some\(\(session\) => session\.name === requested\)\) return connect\(requested\)/);
});

test('the session travels in both directions between the two modes', () => {
  // 终端 → 对话: 之前是裸链接, 切过去落在空的对话页, 还得再找一次会话。
  assert.match(appHtml, /class="remote-entry" href="\/remote\.html"/);
  assert.match(appJs, /a\.remote-entry/);
  assert.match(appJs, /\/remote\.html\?session=\$\{encodeURIComponent\(state\.active\)\}/);
  // 对话页只认列表里真有的会话, 且只认一次 —— 用户手动切走后不该被拽回来。
  assert.match(remoteJs, /state\.threads\.find\(\(thread\) => thread\.tmux\?\.name === requestedTmuxSession\)/);
  assert.match(remoteJs, /requestedTmuxSession = '';/);
});

test('both modes are drawn from one palette, token for token', () => {
  // 之前两套中性色一冷一暖 (#f5f5f7 vs #f6f4f2, #9b9ba1 vs #a4a09d), 差异落在每一处
  // 文字和边框上 —— 切模式时整个产品像换了一套皮。共有的 token 必须逐字节相同。
  const tokens = (sheet) => Object.fromEntries(
    [...(sheet.match(/^:root \{[\s\S]*?^\}/m)?.[0] || '').matchAll(/(--[\w-]+):\s*([^;]+);/g)]
      .map((m) => [m[1], m[2].trim()]),
  );
  const terminal = tokens(appCss);
  const remote = tokens(css);
  const shared = Object.keys(terminal).filter((key) => key in remote);
  assert.ok(shared.length >= 10, `共有 token 太少, 守卫失效: ${shared.length}`);
  for (const key of shared) {
    assert.equal(remote[key], terminal[key], `${key} 在两个模式里不一致`);
  }
});

test('the modal chrome and press feedback match across modes', () => {
  // 弹层的圆角、底色、投影、毛玻璃, 以及按压回弹, 都与触摸尺寸无关 —— 两边不同
  // 纯粹是漂移。(触摸目标 44px 是有意为之, 不在此列。)
  const dialog = appCss.match(/^dialog \{([^}]*)\}/m)?.[1] || '';
  const sheet = css.match(/^\.sheet \{([^}]*)\}/m)?.[1] || '';
  for (const bit of ['background: #252529f2', 'box-shadow: 0 28px 80px #00000080', 'backdrop-filter: blur(28px) saturate(140%)']) {
    assert.ok(dialog.includes(bit), `普通模式 dialog 缺少 ${bit}`);
    assert.ok(sheet.includes(bit), `对话模式 sheet 缺少 ${bit}`);
  }
  assert.doesNotMatch(css, /transform: scale\(\.95\)/);
});

test('the conversation surface is the terminal surface', () => {
  // 正文区要读起来就是普通模式那块终端: 同一个底色、同一个前景、同一款字体。
  // 之前它是一个暖色径向渐变, 和 #2e3436 完全两回事。
  const terminalBg = appCss.match(/--terminal:\s*(#[0-9a-f]{6})/i)?.[1];
  assert.equal(terminalBg, '#2e3436');
  assert.match(css, new RegExp(`--terminal:\\s*${terminalBg}`, 'i'));
  assert.match(css, /\.conversation-shell \{[^}]*background: var\(--terminal\)/s);
  assert.doesNotMatch(css, /\.conversation-shell \{[^}]*radial-gradient/s);
  assert.match(css, /\.turns \{[^}]*color: var\(--terminal-ink\)[^}]*"Courier New"/s);
  // xterm 的前景色就是这个值, 两边必须同源。
  assert.match(appJs, /foreground: '#d3d7cf'/);
  assert.match(css, /--terminal-ink:\s*#d3d7cf/i);
});
