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

test('a synchronous recognition start failure is reported without becoming active', () => {
  class BrokenRecognition extends FakeRecognition {
    start() {
      const error = new Error('blocked');
      error.name = 'NotAllowedError';
      throw error;
    }
  }
  const errors = [];
  const speech = createSpeechInput({
    scope: { SpeechRecognition: BrokenRecognition },
    onError: (message) => errors.push(message),
  });

  assert.equal(speech.start(), false);
  assert.equal(speech.active, false);
  assert.deepEqual(errors, ['麦克风权限被拒绝，请在浏览器设置中允许。']);
});

test('speech input prefers an available on-device language pack', async () => {
  class LocalRecognition extends FakeRecognition {
    static availableCalls = [];

    static available(options) {
      this.availableCalls.push(options);
      return Promise.resolve('available');
    }
  }
  FakeRecognition.instances.length = 0;
  const statuses = [];
  const speech = createSpeechInput({
    scope: { SpeechRecognition: LocalRecognition },
    lang: 'zh-CN',
    onStatus: (message) => statuses.push(message),
  });

  assert.equal(speech.start(), true);
  await new Promise((resolve) => setImmediate(resolve));

  const recognition = FakeRecognition.instances[0];
  assert.deepEqual(LocalRecognition.availableCalls, [{ langs: ['zh-CN'], processLocally: true, quality: 'dictation' }]);
  assert.equal(recognition.processLocally, true);
  assert.equal(recognition.started, true);
  assert.deepEqual(statuses, ['正在检查本地语音识别…']);
});

test('speech input installs a downloadable local pack and falls back online when unavailable', async () => {
  class DownloadableRecognition extends FakeRecognition {
    static installCalls = [];

    static available() { return Promise.resolve('downloadable'); }

    static install(options) {
      this.installCalls.push(options);
      return Promise.resolve(true);
    }
  }
  FakeRecognition.instances.length = 0;
  const downloadStatuses = [];
  const localSpeech = createSpeechInput({
    scope: { SpeechRecognition: DownloadableRecognition },
    lang: 'zh-CN',
    onStatus: (message) => downloadStatuses.push(message),
  });

  assert.equal(localSpeech.start(), true);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(DownloadableRecognition.installCalls, [{ langs: ['zh-CN'], processLocally: true, quality: 'dictation' }]);
  assert.equal(FakeRecognition.instances[0].processLocally, true);
  assert.equal(FakeRecognition.instances[0].started, true);
  assert.deepEqual(downloadStatuses, ['正在检查本地语音识别…', '正在下载本地语音识别语言包…']);

  class OnlineRecognition extends FakeRecognition {
    static available() { return Promise.resolve('unavailable'); }
  }
  FakeRecognition.instances.length = 0;
  const onlineStatuses = [];
  const onlineSpeech = createSpeechInput({
    scope: { SpeechRecognition: OnlineRecognition },
    lang: 'zh-CN',
    onStatus: (message) => onlineStatuses.push(message),
  });

  assert.equal(onlineSpeech.start(), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.notEqual(FakeRecognition.instances[0].processLocally, true);
  assert.equal(FakeRecognition.instances[0].started, true);
  assert.deepEqual(onlineStatuses, ['正在检查本地语音识别…', '本地识别不可用，正在使用浏览器在线识别…']);
});
