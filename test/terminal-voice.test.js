import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { speechDraftForTerminal } from '../public/remote-speech.js';

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
const appJs = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

test('terminal voice drafts cannot contain an implicit Enter', () => {
  assert.equal(speechDraftForTerminal('  检查这个问题\n然后修复  '), '检查这个问题 然后修复');
  assert.equal(speechDraftForTerminal('git status\r\ngit diff'), 'git status git diff');
  assert.equal(speechDraftForTerminal(''), '');
});

test('normal terminal voice input uses an inline Remote-style draft composer', () => {
  assert.ok(html.indexOf('SpeechRecognition') < html.indexOf('/styles.css'));
  assert.match(html, /id="terminalVoiceButton"[^>]*data-terminal-action="voice"[^>]*aria-label="语音输入"/);
  assert.match(html, /class="voice-input-trigger mobile-voice-trigger"[^>]*data-terminal-action="voice"/);
  assert.match(html, /id="terminalVoiceComposer"[^>]*hidden/);
  assert.match(html, /id="terminalVoiceDraft"[^>]*rows="1"[^>]*aria-label="终端输入"/);
  assert.match(html, /id="terminalVoiceCaptureButton"[^>]*aria-label="开始语音输入"[^>]*aria-pressed="false"/);
  assert.match(html, /id="sendTerminalVoiceButton"[^>]*type="submit"[^>]*aria-label="发送到终端"/);
  assert.doesNotMatch(html, /id="terminalVoiceDialog"/);
  assert.match(css, /\.voice-input-trigger\s*\{[^}]*display:\s*none/s);
  assert.match(css, /\.speech-input \.voice-input-trigger\s*\{[^}]*display:\s*inline-flex/s);
  assert.match(css, /\.terminal-voice-composer textarea\s*\{[^}]*font-size:\s*16px/s);
  assert.match(appJs, /createSpeechInput/);
  assert.match(appJs, /onStatus:\s*\(message\)\s*=>\s*setTerminalVoiceState/);
  assert.match(appJs, /if \(!draft\.value\) draft\.placeholder = message/);
  assert.match(appJs, /speechDraftForTerminal/);
  assert.match(appJs, /function submitTerminalVoiceDraft\(/);
  assert.match(appJs, /socket\.send\(JSON\.stringify\(\{ type: 'input', data: `\$\{text\}\\r` \}\)\)/);
  assert.doesNotMatch(appJs, /onTranscript:[\s\S]{0,500}socket\.send/);
});

test('terminal voice input follows terminal access and browser support', () => {
  assert.match(appJs, /voiceInput\.supported/);
  assert.match(appJs, /trigger\.hidden = !state\.canWrite \|\| composerOpen/);
  assert.match(appJs, /trigger\.disabled = !connected/);
  assert.match(appJs, /voiceInput\.abort\(\)/);
  assert.match(appJs, /closeTerminalVoiceComposer\(\{ restoreFocus: false \}\)/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*?\.terminal-actions \.voice-input-trigger\s*\{[^}]*display:\s*none/s);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*?\.mobile-voice-trigger\s*\{[^}]*min-height:\s*44px/s);
});

test('the terminal input bar is local by default and hands whitelisted keys to the CLI', () => {
  // 逐字符直通让打字延迟等于 RTT。默认收进本地输入条, 回车才发一次;
  // 而补全/切模式/中断必须逐键到达 CLI, 否则本地缓冲就把它们吃掉了。
  assert.match(appJs, /if \(writable\) openTerminalComposer\(\)/);
  assert.match(appJs, /terminalComposerKeyAction\(event, \{ draft: \$\('#terminalVoiceDraft'\)\.value \}\)/);
  assert.match(appJs, /action\.key === 'tab' && action\.shift.*TERMINAL_SHIFT_TAB/s);
  assert.match(appJs, /function handOffTerminalInput\(/);
  // 输入条常驻: 没有会改变终端高度的开关, 也就没有随之而来的重排与重绘问题。
  assert.doesNotMatch(html, /closeTerminalVoiceButton/);
  assert.match(html, /placeholder="输入后回车发送 · @ Tab Esc 直达 CLI"/);
});

test('the input bar renders in the same face the terminal will echo it in', () => {
  // 输入条里的字下一秒就出现在正上方的终端里。字体不一致时同一句话换了张脸,
  // 拉丁字母尤其刺眼。终端与 remote 正文都是 Courier New, 输入条必须跟着它,
  // 而不是跟侧栏图标那套 chrome 字体。
  const xtermFont = appJs.match(/fontFamily: '([^']+)'/)?.[1] || '';
  assert.match(xtermFont, /^"Courier New"/);
  assert.match(css, /\.terminal-voice-composer textarea\s*\{[^}]*font-family:\s*"Courier New"/s);
  // 16px 是 iOS 聚焦时不缩放页面的下限。
  assert.match(css, /\.terminal-voice-composer textarea\s*\{[^}]*font-size:\s*16px/s);
});

test('the always-on input bar rests in the frame neutral border, not the accent', () => {
  // 强调色在这个应用里表示"动作"(发送按钮)。输入条常驻且默认持有焦点, 若聚焦态
  // 用强调色描边, 那圈橙红就成了常亮状态, 比它包裹的终端还抢眼。
  assert.match(css, /\.terminal-voice-composer \{[^}]*border: 1px solid var\(--line-strong\)/s);
  // 中性 = 白色透明度; 强调色是暖橙 (#ff6b35 系), 两者都以 ff 开头, 所以直接断言前者。
  assert.match(css, /\.terminal-voice-composer:focus-within \{[^}]*border-color:\s*#ffffff[0-9a-f]{2}/s);
});
