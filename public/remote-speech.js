export function speechRecognitionConstructor(scope = globalThis) {
  return scope?.SpeechRecognition || scope?.webkitSpeechRecognition || null;
}

export function mergeSpeechDraft(draft, transcript) {
  const base = String(draft || '');
  const spoken = String(transcript || '').trim();
  if (!spoken) return base;
  if (!base || /\s$/u.test(base)) return `${base}${spoken}`;
  const separator = /[a-z0-9]$/iu.test(base) && /^[a-z0-9]/iu.test(spoken) ? ' ' : '';
  return `${base}${separator}${spoken}`;
}

export function speechDraftForTerminal(draft) {
  return String(draft || '').replace(/[\r\n]+/gu, ' ').trim();
}

export function speechRecognitionError(error) {
  const code = typeof error === 'string' ? error : error?.error || error?.name;
  if (code === 'not-allowed' || code === 'service-not-allowed' || code === 'NotAllowedError') {
    return '麦克风权限被拒绝，请在浏览器设置中允许。';
  }
  if (code === 'audio-capture' || code === 'NotFoundError') return '未检测到可用的麦克风。';
  if (code === 'network') return '语音识别网络不可用，请稍后重试。';
  if (code === 'no-speech') return '没有听清，请再试一次。';
  if (code === 'language-not-supported') return '当前语言不支持语音识别。';
  return '语音识别失败，请重试。';
}

export function createSpeechInput({
  scope = globalThis,
  lang = 'zh-CN',
  onTranscript = () => {},
  onListeningChange = () => {},
  onStatus = () => {},
  onError = () => {},
} = {}) {
  const Recognition = speechRecognitionConstructor(scope);
  let recognition = null;
  let listening = false;
  let started = false;

  function setListening(next) {
    if (listening === next) return;
    listening = next;
    onListeningChange(listening);
  }

  // stop() 与 onend 只结束"这一次识别"; 部分浏览器 (iOS Safari 尤其) 要等到
  // abort() 才真正放开麦克风, 否则状态栏/刘海屏的话筒图标会一直亮着。同时摘掉
  // 回调, 避免已经作废的识别对象被闭包留住。
  function release(active) {
    active.onstart = null;
    active.onresult = null;
    active.onerror = null;
    active.onend = null;
    try { active.abort(); } catch { /* It may have already finished. */ }
  }

  function finish(active) {
    if (recognition !== active) return;
    recognition = null;
    started = false;
    setListening(false);
    release(active);
  }

  function begin(active) {
    if (recognition !== active) return false;
    try {
      started = true;
      active.start();
      return true;
    } catch (error) {
      finish(active);
      onError(speechRecognitionError(error));
      return false;
    }
  }

  async function beginWithLocalRecognition(active, availability) {
    let local = false;
    try {
      const result = await availability;
      if (recognition !== active) return;
      local = result === 'available';
      if (!local && (result === 'downloadable' || result === 'downloading') && typeof Recognition.install === 'function') {
        onStatus('正在下载本地语音识别语言包…');
        local = await Recognition.install({ langs: [lang], processLocally: true, quality: 'dictation' });
      }
    } catch { /* Fall back to the browser's online recognizer. */ }
    if (recognition !== active) return;
    if (local) {
      try { active.processLocally = true; }
      catch { local = false; }
    }
    if (!local) onStatus('本地识别不可用，正在使用浏览器在线识别…');
    begin(active);
  }

  function start() {
    if (!Recognition || recognition) return false;
    const active = new Recognition();
    active.lang = lang;
    active.continuous = false;
    active.interimResults = true;
    active.maxAlternatives = 1;
    active.onstart = () => recognition === active && setListening(true);
    active.onresult = (event) => {
      if (recognition !== active) return;
      let transcript = '';
      let finalized = Boolean(event.results?.length);
      for (let index = 0; index < (event.results?.length || 0); index += 1) {
        const result = event.results[index];
        transcript += result?.[0]?.transcript || '';
        if (!result?.isFinal) finalized = false;
      }
      onTranscript({ transcript: transcript.trim(), finalized });
    };
    active.onerror = (event) => {
      if (recognition !== active) return;
      finish(active);
      if (event?.error !== 'aborted') onError(speechRecognitionError(event));
    };
    active.onend = () => finish(active);
    recognition = active;
    if (typeof Recognition.available === 'function') {
      onStatus('正在检查本地语音识别…');
      let availability;
      try {
        availability = Recognition.available({ langs: [lang], processLocally: true, quality: 'dictation' });
      } catch {
        return begin(active);
      }
      beginWithLocalRecognition(active, availability);
      return true;
    }
    return begin(active);
  }

  function stop() {
    if (!recognition) return false;
    if (!started) return abort();
    try { recognition.stop(); }
    catch (error) {
      const active = recognition;
      finish(active);
      onError(speechRecognitionError(error));
    }
    return true;
  }

  function abort() {
    if (!recognition) return false;
    const active = recognition;
    recognition = null;
    started = false;
    setListening(false);
    release(active);
    return true;
  }

  // 手机切后台或锁屏时页面并不卸载, 识别对象会继续持有麦克风。
  const releaseOnHide = () => {
    if (scope?.document?.visibilityState === 'hidden') abort();
  };
  scope?.addEventListener?.('pagehide', abort);
  scope?.document?.addEventListener?.('visibilitychange', releaseOnHide);

  function dispose() {
    abort();
    scope?.removeEventListener?.('pagehide', abort);
    scope?.document?.removeEventListener?.('visibilitychange', releaseOnHide);
  }

  return {
    supported: Boolean(Recognition),
    start,
    stop,
    abort,
    dispose,
    get active() { return Boolean(recognition); },
    get listening() { return listening; },
  };
}
