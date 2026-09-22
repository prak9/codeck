export function safeImageSource(value, origin) {
  if (typeof value !== 'string') return null;
  if (/^\/api\/agent-images\/[\w-]+\.[\w-]+$/u.test(value)) return { url: value, local: true };
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    // Never turn arbitrary same-origin URLs into authenticated image requests.
    if (url.origin === origin || !/\.(?:png|jpe?g|gif|webp)$/iu.test(url.pathname)) return null;
    return { url: url.href, local: false };
  } catch { return null; }
}

export function createRemoteImages({ root, getToken }) {
  const tracked = new Map();
  const queue = [];
  const turnCache = new Map();
  let running = 0;
  let previewOwner;
  const make = (tag, className, text) => {
    const node = document.createElement(tag);
    node.className = className;
    if (text) node.textContent = text;
    return node;
  };
  const dialog = make('dialog', 'sheet remote-image-dialog');
  const head = make('div', 'sheet-head');
  const title = make('h2', '', '图片预览');
  const close = make('button', 'close-button', '×');
  close.type = 'button'; close.setAttribute('aria-label', '关闭图片预览');
  close.addEventListener('click', () => dialog.close());
  const fullImage = make('img', 'remote-image-full');
  const download = make('a', 'remote-image-download', '打开原图 / 保存图片');
  download.target = '_blank'; download.rel = 'noopener noreferrer';
  head.append(title, close); dialog.append(head, fullImage, download);
  document.body.append(dialog);
  dialog.addEventListener('close', () => { fullImage.removeAttribute('src'); download.removeAttribute('href'); previewOwner = null; });

  const changeLayout = change => {
    const bottom = root.scrollHeight - root.clientHeight - root.scrollTop < 64;
    const edge = root.getBoundingClientRect().top;
    const anchor = [...root.querySelectorAll('.turn')].find(node => node.getBoundingClientRect().bottom > edge);
    const top = anchor?.getBoundingClientRect().top;
    change();
    if (bottom) root.scrollTop = root.scrollHeight;
    else if (anchor?.isConnected) root.scrollTop += anchor.getBoundingClientRect().top - top;
  };
  const pump = () => {
    while (running < 2 && queue.length) {
      const job = queue.shift();
      job.queued = false;
      if (!job.node.isConnected || !job.visible || job.done || job.controller) continue;
      running += 1;
      const controller = new AbortController();
      job.controller = controller;
      Promise.resolve().then(() => job.load(controller.signal)).catch(() => {}).finally(() => {
        if (job.controller === controller) job.controller = null;
        running -= 1;
        if (controller.signal.aborted && job.visible && job.node.isConnected) enqueue(job);
        pump();
      });
    }
  };
  const enqueue = job => {
    if (job.queued || job.controller || job.done) return;
    job.queued = true; queue.push(job); pump();
  };
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const job = tracked.get(entry.target);
      if (!job) continue;
      job.visible = entry.isIntersecting;
      clearTimeout(job.visibilityTimer);
      if (job.visible) {
        // Opening a thread scrolls to its tail on the next frame. Do not fetch
        // historical images that pass through the viewport during that jump.
        job.visibilityTimer = setTimeout(() => {
          const box = job.node.getBoundingClientRect();
          const viewport = root.getBoundingClientRect();
          if (job.visible && box.bottom >= viewport.top - 240 && box.top <= viewport.bottom + 240) enqueue(job);
        }, 120);
      } else if (job.release && previewOwner !== job.node) job.release();
    }
  }, { root, rootMargin: '240px' });
  const track = job => { tracked.set(job.node, job); observer.observe(job.node); };
  const authFetch = (url, signal) => fetch(url, {
    headers: { Authorization: `Bearer ${getToken()}` },
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    cache: 'no-store',
  });

  const figure = ref => {
    const source = safeImageSource(ref.url, location.origin);
    if (!source) return document.createTextNode(ref.alt || '图片地址不可用');
    const node = make('figure', 'remote-image');
    const button = make('button', 'remote-image-stage');
    button.type = 'button'; button.setAttribute('aria-label', `放大图片：${ref.alt || '图片'}`);
    const image = make('img', '');
    image.alt = ref.alt || '会话图片'; image.decoding = 'async'; image.referrerPolicy = 'no-referrer';
    image.hidden = true;
    const status = make('span', 'remote-image-status', '图片按需加载');
    status.setAttribute('role', 'status');
    const caption = make('figcaption', '', ref.alt || '图片');
    button.append(image, status); node.append(button, caption);
    let objectUrl;
    const job = { node, done: false, visible: false, controller: null };
    job.release = () => {
      job.controller?.abort();
      image.removeAttribute('src'); image.hidden = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = null; job.done = false;
      status.hidden = false; status.textContent = '图片按需加载';
    };
    job.load = async signal => {
      status.textContent = '正在加载图片…'; status.hidden = false;
      try {
        let src = source.url;
        if (source.local) {
          const response = await authFetch(source.url, signal);
          if (!response.ok) throw new Error('图片不存在、过大或无权访问');
          const blob = await response.blob();
          if (!/^image\/(?:png|jpeg|gif|webp)$/u.test(blob.type)) throw new Error('图片格式不支持');
          if (signal.aborted || !node.isConnected) return;
          objectUrl = URL.createObjectURL(blob); src = objectUrl;
        }
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => finish(new Error('图片加载超时')), 15_000);
          const aborted = () => finish(new DOMException('Aborted', 'AbortError'));
          const finish = error => {
            clearTimeout(timer); signal.removeEventListener('abort', aborted);
            image.onload = image.onerror = null;
            error ? reject(error) : resolve();
          };
          signal.addEventListener('abort', aborted, { once: true });
          image.onload = () => finish(); image.onerror = () => finish(new Error('图片加载失败'));
          if (signal.aborted) aborted(); else image.src = src;
        });
        await image.decode();
        if (signal.aborted || !node.isConnected) return;
        image.hidden = false; status.hidden = true; job.done = true;
      } catch (error) {
        if (signal.aborted) return;
        status.textContent = `${error.message}，点击重试`;
        job.done = true;
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        objectUrl = null; image.removeAttribute('src');
      }
    };
    button.addEventListener('click', () => {
      if (image.hidden) { job.done = false; job.visible = true; enqueue(job); return; }
      previewOwner = node; fullImage.src = image.src; fullImage.alt = image.alt;
      title.textContent = ref.alt || '图片预览'; download.href = image.src;
      dialog.showModal(); close.focus();
    });
    track(job);
    return node;
  };

  const renderMessage = (node, item, { inline = true } = {}) => {
    const refs = item.codeckImages || [];
    if (!refs.length) return;
    const text = node.textContent;
    const children = [];
    let offset = 0;
    for (const ref of refs) {
      if (!inline || !Number.isInteger(ref.start) || ref.start < offset || ref.end > text.length) continue;
      children.push(document.createTextNode(text.slice(offset, ref.start)), figure(ref));
      offset = ref.end;
    }
    children.push(document.createTextNode(text.slice(offset)));
    for (const ref of refs) if (!inline || !Number.isInteger(ref.start)) children.push(figure(ref));
    node.replaceChildren(...children);
  };

  const observeTurn = (node, { provider, threadId, turn }) => {
    if (provider !== 'codex' || !threadId || !turn.id || !['completed', 'interrupted', 'failed'].includes(turn.status) || turn.deliveryOnly) return;
    const key = JSON.stringify([provider, threadId, turn.id, turn.status, turn.completedAt || null, (turn.items || []).map(item => item.id)]);
    const known = new Set((turn.items || []).flatMap(item => (item.codeckImages || []).map(ref => ref.path)));
    const append = refs => {
      const fresh = refs.filter(ref => !known.has(ref.path));
      if (!fresh.length) return;
      const gallery = make('div', 'remote-image-supplement');
      for (const ref of fresh) gallery.append(figure(ref));
      const insert = () => node.insertBefore(gallery, node.querySelector('.turn-foot'));
      if (node.isConnected) changeLayout(insert); else insert();
    };
    if (turnCache.has(key)) { append(turnCache.get(key)); return; }
    const job = { node, visible: false, done: false, controller: null };
    job.load = async signal => {
      try {
        const response = await authFetch(`/api/agent-turn-images?${new URLSearchParams({ provider, threadId, turnId: turn.id })}`, signal);
        if (!response.ok) throw new Error('图片信息暂时无法读取');
        const result = await response.json();
        if (signal.aborted || !node.isConnected) return;
        const refs = Array.isArray(result.images) ? result.images : [];
        turnCache.set(key, refs);
        if (turnCache.size > 200) turnCache.delete(turnCache.keys().next().value);
        append(refs); job.done = true; observer.unobserve(node);
      } catch {
        if (signal.aborted || !node.isConnected) return;
        job.done = true;
        const retry = make('button', 'remote-image-retry', '图片信息未能加载，点击重试');
        retry.type = 'button';
        retry.addEventListener('click', () => { retry.remove(); job.done = false; enqueue(job); });
        changeLayout(() => node.append(retry));
      }
    };
    track(job);
  };
  const prune = () => {
    for (const [node, job] of tracked) {
      if (node.isConnected) continue;
      if (previewOwner === node) dialog.close();
      clearTimeout(job.visibilityTimer);
      job.controller?.abort(); job.release?.(); observer.unobserve(node); tracked.delete(node);
    }
  };
  return { renderMessage, observeTurn, prune };
}
