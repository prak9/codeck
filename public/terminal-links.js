import { matchTerminalHistoryLinks } from './terminal-history-links.js?v=1';

// Let xterm own hover/click hit testing so dragging still selects terminal text.
export function enableTerminalLinks(terminal, { getContext = () => null, readHistoryLinks, previewImage } = {}) {
  let revision = 0;
  let cache;
  const key = () => `${revision}:${terminal.buffer?.active.viewportY || 0}:${JSON.stringify(getContext())}`;
  const open = (event, uri) => {
    // xterm 5.5 also activates on mouseup after dragging within the same link.
    if (event.button !== 0 || terminal.hasSelection()) return;
    if (!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && previewImage?.(uri)) return;
    window.open(uri, '_blank', 'noopener,noreferrer');
  };
  if (readHistoryLinks) {
    terminal.onWriteParsed(() => { revision += 1; cache = null; });
    terminal.onResize(() => { revision += 1; cache = null; });
    terminal.registerLinkProvider({
      provideLinks(row, callback) {
        const context = getContext(), requestKey = key();
        if (!context?.session) return callback([]);
        const buffer = terminal.buffer.active;
        const visible = Array.from({ length: terminal.rows }, (_, y) => (
          buffer.getLine(buffer.viewportY + y)?.translateToString(true) || ''
        )).join('');
        if (!/https?:\/\//i.test(visible)) return callback([]);
        // One bounded read for a stable viewport, shared by all hovered rows.
        if (!cache || cache.key !== requestKey || cache.retryAt < Date.now()) {
          const entry = { key: requestKey, urls: [], retryAt: Infinity };
          cache = entry;
          entry.promise = Promise.resolve().then(() => readHistoryLinks(context)).then(result => {
            entry.urls = Array.isArray(result?.urls) ? result.urls : [];
            return entry.urls;
          }).catch(() => { entry.retryAt = Date.now() + 1000; return []; });
        }
        const entry = cache;
        entry.promise.then(urls => {
          if (key() !== requestKey) return callback([]);
          entry.links ||= matchTerminalHistoryLinks(terminal, urls, (event, uri) => {
            if (key() === requestKey) open(event, uri);
          });
          callback(entry.links.filter(link => link.range.start.y <= row && link.range.end.y >= row));
        });
      },
    });
  }
  terminal.loadAddon(new globalThis.WebLinksAddon.WebLinksAddon((event, uri) => {
    // If tmux proved this is just the first visual row, never open that prefix.
    if (cache?.key === key() && cache.urls.some(url => url !== uri && url.startsWith(uri))) return;
    open(event, uri);
  }));
}
