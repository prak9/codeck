// Classify only explicit raster image links. Do not probe ordinary URLs or expose
// arbitrary server paths; local files keep the existing authenticated download route.
export function terminalImageUrl(uri, origin) {
  try {
    const url = new URL(uri);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    const file = url.origin === origin && url.pathname === '/api/download'
      ? url.searchParams.get('path') || '' : decodeURIComponent(url.pathname);
    return /\.(?:png|jpe?g|gif|webp|avif|bmp)$/i.test(file) ? url.href : null;
  } catch { return null; }
}

export function createTerminalImagePreview() {
  const dialog = document.createElement('dialog');
  dialog.className = 'terminal-image-preview';
  dialog.setAttribute('aria-label', '图片预览');
  const head = document.createElement('div');
  head.className = 'terminal-image-head';
  const title = document.createElement('h2');
  title.textContent = '图片预览';
  const close = document.createElement('button');
  close.className = 'secondary-button';
  close.type = 'button';
  close.textContent = '关闭';
  close.autofocus = true;
  head.append(title, close);
  const stage = document.createElement('div');
  stage.className = 'terminal-image-stage';
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  const original = document.createElement('a');
  original.textContent = '在新标签页打开原图';
  original.target = '_blank';
  original.rel = 'noopener noreferrer';
  dialog.append(head, stage, status, original);
  document.body.append(dialog);
  let current, timer;
  const clear = () => {
    clearTimeout(timer);
    if (current) {
      current.onload = current.onerror = null;
      current.removeAttribute('src');
      current = null;
    }
    stage.replaceChildren();
    original.removeAttribute('href');
  };
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { if (!dialog.open) clear(); });
  return (uri) => {
    const url = terminalImageUrl(uri, window.location.origin);
    if (!url) return false;
    clear();
    status.textContent = '正在加载图片…';
    original.href = url;
    const image = document.createElement('img');
    current = image;
    image.alt = '终端链接图片';
    image.referrerPolicy = 'no-referrer';
    image.hidden = true;
    image.onload = () => {
      if (current !== image || !dialog.open) return;
      clearTimeout(timer);
      image.hidden = false;
      status.textContent = '';
    };
    image.onerror = () => {
      if (current !== image || !dialog.open) return;
      clearTimeout(timer);
      status.textContent = '图片无法加载，可在新标签页打开原图查看。';
    };
    stage.append(image);
    if (!dialog.open) dialog.showModal();
    timer = setTimeout(() => {
      if (current === image && dialog.open) status.textContent = '图片加载较慢，可继续等待或打开原图。';
    }, 15000);
    image.src = url;
    return true;
  };
}
