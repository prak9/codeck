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

test('normal terminal voice input is confirmed before insertion', () => {
  assert.ok(html.indexOf('SpeechRecognition') < html.indexOf('/styles.css'));
  assert.match(html, /id="terminalVoiceButton"[^>]*data-terminal-action="voice"[^>]*aria-label="语音输入"/);
  assert.match(html, /class="voice-input-trigger mobile-voice-trigger"[^>]*data-terminal-action="voice"/);
  assert.match(html, /id="terminalVoiceDialog"[^>]*aria-labelledby="terminalVoiceTitle"/);
  assert.match(html, /<label for="terminalVoiceDraft">识别文字<\/label>/);
  assert.match(html, /id="terminalVoiceDraft"[^>]*rows="4"/);
  assert.match(html, /id="insertTerminalVoiceButton"[^>]*type="submit"[^>]*>插入终端<\/button>/);
  assert.match(css, /\.voice-input-trigger\s*\{[^}]*display:\s*none/s);
  assert.match(css, /\.speech-input \.voice-input-trigger\s*\{[^}]*display:\s*inline-flex/s);
  assert.match(css, /\.voice-dialog textarea\s*\{[^}]*font-size:\s*16px/s);
  assert.match(appJs, /createSpeechInput/);
  assert.match(appJs, /speechDraftForTerminal/);
  assert.match(appJs, /function insertTerminalVoiceDraft\(/);
  assert.match(appJs, /socket\.send\(JSON\.stringify\(\{ type: 'input', data: text \}\)\)/);
  assert.doesNotMatch(appJs, /data:\s*`?\$?\{?text\}?\\r/);
});

test('terminal voice input follows terminal access and browser support', () => {
  assert.match(appJs, /voiceInput\.supported/);
  assert.match(appJs, /trigger\.hidden = !state\.canManage/);
  assert.match(appJs, /trigger\.disabled = !connected/);
  assert.match(appJs, /voiceInput\.abort\(\)/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*?\.terminal-actions \.voice-input-trigger\s*\{[^}]*display:\s*none/s);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*?\.mobile-voice-trigger\s*\{[^}]*min-height:\s*44px/s);
});
