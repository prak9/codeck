import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSpeechInput,
  mergeSpeechDraft,
  speechRecognitionError,
} from '../public/remote-speech.js';

class FakeRecognition {
  static instances = [];

  constructor() {
    this.started = false;
    this.stopped = false;
    this.aborted = false;
    FakeRecognition.instances.push(this);
  }

  start() { this.started = true; }
  stop() { this.stopped = true; }
  abort() { this.aborted = true; }
}

test('speech drafts preserve existing text without inserting spaces into Chinese', () => {
  assert.equal(mergeSpeechDraft('', '继续修复'), '继续修复');
  assert.equal(mergeSpeechDraft('请检查', '这个问题'), '请检查这个问题');
  assert.equal(mergeSpeechDraft('Please review', 'this change'), 'Please review this change');
  assert.equal(mergeSpeechDraft('已有内容\n', '下一段'), '已有内容\n下一段');
});

test('speech input streams one stable transcript and exposes listening state', () => {
  FakeRecognition.instances.length = 0;
  const states = [];
  const transcripts = [];
  const errors = [];
  const speech = createSpeechInput({
    scope: { SpeechRecognition: FakeRecognition },
    lang: 'zh-CN',
    onListeningChange: (listening) => states.push(listening),
    onTranscript: (result) => transcripts.push(result),
    onError: (message) => errors.push(message),
  });

  assert.equal(speech.supported, true);
  assert.equal(speech.start(), true);
  const recognition = FakeRecognition.instances[0];
  assert.equal(recognition.started, true);
  assert.equal(recognition.lang, 'zh-CN');
  assert.equal(recognition.continuous, false);
  assert.equal(recognition.interimResults, true);
  assert.equal(recognition.maxAlternatives, 1);

  recognition.onstart();
  assert.equal(speech.listening, true);
  recognition.onresult({
    results: [
      { 0: { transcript: '继续' }, isFinal: true },
      { 0: { transcript: '修复这个问题' }, isFinal: false },
    ],
  });
  assert.deepEqual(transcripts, [{ transcript: '继续修复这个问题', finalized: false }]);
  assert.equal(speech.stop(), true);
  assert.equal(recognition.stopped, true);
  recognition.onend();
  assert.equal(speech.listening, false);
  assert.deepEqual(states, [true, false]);
  assert.deepEqual(errors, []);
});

test('unsupported browsers and microphone errors fail recoverably', () => {
  const unsupported = createSpeechInput({ scope: {} });
  assert.equal(unsupported.supported, false);
  assert.equal(unsupported.start(), false);
  assert.equal(unsupported.stop(), false);

  assert.equal(speechRecognitionError('not-allowed'), '麦克风权限被拒绝，请在浏览器设置中允许。');
  assert.equal(speechRecognitionError('audio-capture'), '未检测到可用的麦克风。');
  assert.equal(speechRecognitionError('network'), '语音识别网络不可用，请稍后重试。');
  assert.equal(speechRecognitionError('no-speech'), '没有听清，请再试一次。');
});
