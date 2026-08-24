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
  onError = () => {},
} = {}) {
  const Recognition = speechRecognitionConstructor(scope);
  let recognition = null;
  let listening = false;

  function setListening(next) {
    if (listening === next) return;
    listening = next;
    onListeningChange(listening);
  }

  function finish(active) {
    if (recognition !== active) return;
    recognition = null;
    setListening(false);
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
    try {
      active.start();
      return true;
    } catch (error) {
      finish(active);
      onError(speechRecognitionError(error));
      return false;
    }
  }

  function stop() {
    if (!recognition) return false;
    recognition.stop();
    return true;
  }

  function abort() {
    if (!recognition) return false;
    const active = recognition;
    recognition = null;
    setListening(false);
    active.abort();
    return true;
  }

  return {
    supported: Boolean(Recognition),
    start,
    stop,
    abort,
    get active() { return Boolean(recognition); },
    get listening() { return listening; },
  };
}
