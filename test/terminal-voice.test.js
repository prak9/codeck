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
  assert.match(html, /id="terminalVoiceDraft"[^>]*rows="1"[^>]*aria-label="语音输入草稿"/);
  assert.match(html, /id="terminalVoiceCaptureButton"[^>]*aria-label="开始语音输入"[^>]*aria-pressed="false"/);
  assert.match(html, /id="sendTerminalVoiceButton"[^>]*type="submit"[^>]*aria-label="发送到终端"/);
  assert.doesNotMatch(html, /id="terminalVoiceDialog"/);
  assert.match(css, /\.voice-input-trigger\s*\{[^}]*display:\s*none/s);
  assert.match(css, /\.speech-input \.voice-input-trigger\s*\{[^}]*display:\s*inline-flex/s);
  assert.match(css, /\.terminal-voice-composer textarea\s*\{[^}]*font-size:\s*16px/s);
  assert.match(appJs, /createSpeechInput/);
  assert.match(appJs, /speechDraftForTerminal/);
  assert.match(appJs, /function submitTerminalVoiceDraft\(/);
  assert.match(appJs, /socket\.send\(JSON\.stringify\(\{ type: 'input', data: `\$\{text\}\\r` \}\)\)/);
  assert.doesNotMatch(appJs, /onTranscript:[\s\S]{0,500}socket\.send/);
});

test('terminal voice input follows terminal access and browser support', () => {
  assert.match(appJs, /voiceInput\.supported/);
  assert.match(appJs, /trigger\.hidden = !state\.canManage \|\| composerOpen/);
  assert.match(appJs, /trigger\.disabled = !connected/);
  assert.match(appJs, /voiceInput\.abort\(\)/);
  assert.match(appJs, /closeTerminalVoiceComposer\(\{ restoreFocus: false \}\)/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*?\.terminal-actions \.voice-input-trigger\s*\{[^}]*display:\s*none/s);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*?\.mobile-voice-trigger\s*\{[^}]*min-height:\s*44px/s);
});
