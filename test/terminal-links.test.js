import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { enableTerminalLinks } from '../public/terminal-links.js';

test('terminal links open without modifiers but never open a drag selection or right click', () => {
  const previousAddon = globalThis.WebLinksAddon;
  const previousWindow = globalThis.window;
  let activate;
  let selected = false;
  const opened = [];
  const previews = [];
  globalThis.WebLinksAddon = { WebLinksAddon: class {
    constructor(handler) { activate = handler; }
  } };
  globalThis.window = { open: (...args) => opened.push(args) };
  try {
    enableTerminalLinks({ loadAddon() {}, hasSelection: () => selected }, {
      previewImage: uri => { previews.push(uri); return uri.endsWith('.png'); },
    });
    const url = 'https://example.com/path?q=1&lang=zh#details';
    activate({ button: 0, ctrlKey: false }, url);
    assert.deepEqual(opened, [[url, '_blank', 'noopener,noreferrer']]);
    selected = true;
    activate({ button: 0 }, url);
    selected = false;
    activate({ button: 2 }, url);
    assert.equal(opened.length, 1);
    assert.deepEqual(previews, [url], 'selection and right click must not preview');
    activate({ button: 0 }, 'https://example.com/a.png');
    assert.equal(opened.length, 1, 'preview consumes image click');
    activate({ button: 0, ctrlKey: true }, 'https://example.com/a.png');
    assert.equal(opened.length, 2, 'modified image click opens original');
  } finally {
    if (previousAddon === undefined) delete globalThis.WebLinksAddon;
    else globalThis.WebLinksAddon = previousAddon;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test('ordinary terminal serves and loads the official web links addon before app initialization', async () => {
  const read = name => readFile(new URL(`../${name}`, import.meta.url), 'utf8');
  const [html, app, server] = await Promise.all(['public/index.html', 'public/app.js', 'src/server.js'].map(read));
  assert.ok(html.indexOf('/vendor/web-links/addon-web-links.js') < html.indexOf('/app.js?'));
  assert.match(server, /app\.use\('\/vendor\/web-links', express\.static\(path\.join\(dirname, '\.\.\/node_modules\/@xterm\/addon-web-links\/lib'\)\)\)/);
  assert.match(app, /enableTerminalLinks\(terminal, \{/);
});

test('history links reuse a viewport read, reject stale frames/sessions, and suppress truncated destinations', async () => {
  const previousAddon = globalThis.WebLinksAddon, previousWindow = globalThis.window;
  let fallback, provider, written, resized, session = 'one';
  const requests = [], opened = [];
  const url = 'https://example.com/path?q=1#end';
  const text = url;
  const terminal = {
    rows: 1, cols: 100, loadAddon() {}, hasSelection: () => false,
    onWriteParsed: fn => { written = fn; }, onResize: fn => { resized = fn; },
    registerLinkProvider: value => { provider = value; },
    buffer: { active: { viewportY: 0, getLine: () => ({
      translateToString: () => text,
      getCell: col => ({ getWidth: () => 1, getChars: () => text[col] || '' }),
    }) } },
  };
  globalThis.WebLinksAddon = { WebLinksAddon: class { constructor(handler) { fallback = handler; } } };
  globalThis.window = { open: (...args) => opened.push(args) };
  const links = () => new Promise(resolve => provider.provideLinks(1, resolve));
  try {
    enableTerminalLinks(terminal, {
      getContext: () => ({ session }),
      readHistoryLinks: () => new Promise((resolve, reject) => requests.push({ resolve, reject })),
    });
    const a = links(), b = links();
    await Promise.resolve();
    assert.equal(requests.length, 1);
    requests[0].resolve({ urls: [url] });
    const [link] = await a;
    assert.equal((await b)[0].text, url);
    fallback({ button: 0 }, 'https://example.com/');
    assert.equal(opened.length, 0, 'a historical URL prefix must not open');
    link.activate({ button: 0 }, url);
    assert.equal(opened.length, 1);
    written();
    link.activate({ button: 0 }, url);
    assert.equal(opened.length, 1, 'render invalidates old links');
    const stale = links();
    await Promise.resolve();
    session = 'two';
    requests[1].resolve({ urls: [url] });
    assert.deepEqual(await stale, []);
    const resize = links();
    await Promise.resolve();
    resized();
    requests[2].resolve({ urls: [url] });
    assert.deepEqual(await resize, []);
    const failed = links();
    await Promise.resolve();
    requests[3].reject(new Error('offline'));
    assert.deepEqual(await failed, []);
    fallback({ button: 0 }, url);
    assert.equal(opened.length, 2, 'ordinary visible URLs remain usable after a failed history read');
  } finally {
    if (previousAddon === undefined) delete globalThis.WebLinksAddon; else globalThis.WebLinksAddon = previousAddon;
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
  }
});

test('history URL endpoint enforces owner/share session scope and disables response caching', async () => {
  const server = await readFile(new URL('../src/server.js', import.meta.url), 'utf8');
  const handlerSource = server.match(/app\.get\('\/api\/sessions\/:name\/terminal-links',[\s\S]*?\n\}\);/)[0];
  let handler, reads = 0;
  vm.runInNewContext(handlerSource, {
    app: { get: (_path, fn) => { handler = fn; } },
    terminalHistoryLinks: async () => { reads += 1; return { urls: ['https://example.com/'] }; },
  });
  for (const [auth, name, allowed] of [
    [{ owner: true }, 'other', true],
    [{ owner: false, session: 'shared' }, 'shared', true],
    [{ owner: false, session: 'shared' }, 'other', false],
  ]) {
    let status, body, cache;
    const before = reads;
    await handler({ auth, params: { name } }, {
      sendStatus: value => { status = value; }, json: value => { body = value; },
      set: (_key, value) => { cache = value; },
    }, error => { throw error; });
    assert.equal(reads - before, allowed ? 1 : 0);
    if (allowed) { assert.equal(cache, 'no-store'); assert.equal(body.urls.length, 1); }
    else assert.equal(status, 403);
  }
});
