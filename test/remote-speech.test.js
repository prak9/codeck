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

function fakeScope() {
  const listeners = new Map();
  const doc = {
    visibilityState: 'visible',
    addEventListener: (type, fn) => listeners.set(`doc:${type}`, fn),
    removeEventListener: (type) => listeners.delete(`doc:${type}`),
  };
  return {
    SpeechRecognition: FakeRecognition,
    document: doc,
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type) => listeners.delete(type),
    fire: (type) => listeners.get(type)?.(),
    has: (type) => listeners.has(type),
  };
}

test('a finished recognition releases the microphone instead of only ending the session', () => {
  // stop() 只结束本次识别; 部分浏览器要等 abort() 才真正放开麦克风 ——
  // 这就是 iOS 上话筒图标停在刘海屏不走的原因。
  FakeRecognition.instances.length = 0;
  const speech = createSpeechInput({ scope: fakeScope() });
  speech.start();
  const active = FakeRecognition.instances.at(-1);

  active.onend();

  assert.equal(active.aborted, true, 'the recognizer must be released, not just ended');
  assert.equal(active.onresult, null, 'handlers must be detached so nothing retains it');
  assert.equal(speech.active, false);
});

test('an errored recognition also releases the microphone', () => {
  FakeRecognition.instances.length = 0;
  const speech = createSpeechInput({ scope: fakeScope(), onError: () => {} });
  speech.start();
  const active = FakeRecognition.instances.at(-1);

  active.onerror({ error: 'no-speech' });

  assert.equal(active.aborted, true);
  assert.equal(speech.active, false);
});

test('backgrounding the page releases the microphone', () => {
  // 手机切后台/锁屏时页面不卸载, 识别对象会继续占着麦克风。
  FakeRecognition.instances.length = 0;
  const scope = fakeScope();
  const speech = createSpeechInput({ scope });
  speech.start();
  const active = FakeRecognition.instances.at(-1);

  scope.document.visibilityState = 'hidden';
  scope.fire('doc:visibilitychange');

  assert.equal(active.aborted, true);
  assert.equal(speech.active, false);
});

test('leaving the page releases the microphone', () => {
  FakeRecognition.instances.length = 0;
  const scope = fakeScope();
  const speech = createSpeechInput({ scope });
  speech.start();
  const active = FakeRecognition.instances.at(-1);

  scope.fire('pagehide');

  assert.equal(active.aborted, true);
});

test('dispose detaches the lifecycle listeners it installed', () => {
  const scope = fakeScope();
  const speech = createSpeechInput({ scope });
  assert.equal(scope.has('pagehide'), true);
  speech.dispose();
  assert.equal(scope.has('pagehide'), false);
});

test('a stop that never gets its onend still releases the microphone', async () => {
  // stop() 之后完全依赖浏览器回调 onend 才会释放。iOS 上切后台或识别从未真正
  // 启动时 onend 可能不来, 那个对象就一直握着麦克风 —— 话筒图标不走。
  FakeRecognition.instances.length = 0;
  const timers = [];
  const scope = fakeScope();
  const speech = createSpeechInput({
    scope,
    releaseTimeoutMs: 20,
    schedule: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    cancel: () => {},
  });
  speech.start();
  const active = FakeRecognition.instances.at(-1);
  active.onstart();

  speech.stop();
  assert.equal(active.stopped, true);
  assert.equal(active.aborted, false, '先给浏览器机会正常收尾');

  timers.at(-1).fn();          // onend 始终没来, 兜底定时器到点
  assert.equal(active.aborted, true, '兜底必须真正释放');
  assert.equal(speech.active, false);
});

test('a stop that does get its onend cancels the fallback', () => {
  FakeRecognition.instances.length = 0;
  let cancelled = 0;
  const speech = createSpeechInput({
    scope: fakeScope(),
    releaseTimeoutMs: 20,
    schedule: () => 1,
    cancel: () => { cancelled += 1; },
  });
  speech.start();
  const active = FakeRecognition.instances.at(-1);
  active.onstart();
  speech.stop();
  active.onend();

  assert.equal(active.aborted, true);
  assert.ok(cancelled >= 1, '正常收尾后不该留着定时器');
});
