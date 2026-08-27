import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SESSION_FOLDER_EXPANSION_STORAGE_KEY,
  SESSION_FOLDER_PREFIXES_STORAGE_KEY,
  SESSION_VISIBILITY_STORAGE_KEY,
  groupSessionsByPrefix,
  loadExpandedSessionFolders,
  isSessionVisible,
  loadHiddenSessionPrefixes,
  loadSessionFolderPrefixes,
  normalizeSessionPrefixes,
  parseSessionPrefixInput,
  partitionSessionsByPrefix,
  saveExpandedSessionFolders,
  saveHiddenSessionPrefixes,
  saveSessionFolderPrefixes,
  setSessionFolderExpanded,
} from '../public/session-visibility.js';

const appHtml = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const remoteHtml = fs.readFileSync(new URL('../public/remote.html', import.meta.url), 'utf8');
const appJs = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const remoteJs = fs.readFileSync(new URL('../public/remote.js', import.meta.url), 'utf8');
const appCss = fs.readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
const remoteCss = fs.readFileSync(new URL('../public/remote.css', import.meta.url), 'utf8');

function memoryStorage(entries = {}) {
  const values = new Map(Object.entries(entries));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

test('session prefix rules are trimmed, deduplicated and matched literally', () => {
  assert.deepEqual(normalizeSessionPrefixes([' tmp-', 'tmp-', '', 'Skills', null]), ['tmp-', 'Skills']);
  assert.deepEqual(parseSessionPrefixInput('tmp-\r\n\nSkills\ntmp-'), ['tmp-', 'Skills']);
  assert.equal(isSessionVisible('tmp-agent-1', ['tmp-']), false);
  assert.equal(isSessionVisible('TMP-agent-1', ['tmp-']), true);
  assert.equal(isSessionVisible('my-tmp-agent', ['tmp-']), true);
});

test('session prefix rules persist only in the supplied browser storage', () => {
  const storage = memoryStorage();
  assert.deepEqual(saveHiddenSessionPrefixes(storage, ['tmp-', 'archive-']), ['tmp-', 'archive-']);
  assert.deepEqual(loadHiddenSessionPrefixes(storage), ['tmp-', 'archive-']);

  saveHiddenSessionPrefixes(storage, []);
  assert.equal(storage.getItem(SESSION_VISIBILITY_STORAGE_KEY), null);
  assert.deepEqual(loadHiddenSessionPrefixes(storage), []);

  const corrupt = memoryStorage({ [SESSION_VISIBILITY_STORAGE_KEY]: '{broken' });
  assert.deepEqual(loadHiddenSessionPrefixes(corrupt), []);
});

test('normal sessions and remote tmux threads use the same prefix partition', () => {
  const sessions = [{ name: 'codeck' }, { name: 'tmp-debug' }, { name: 'skills' }];
  assert.deepEqual(partitionSessionsByPrefix(sessions, ['tmp-']), {
    visible: [sessions[0], sessions[2]],
    hidden: [sessions[1]],
  });

  const threads = [
    { id: 'one', tmux: { name: 'archive-old' } },
    { id: 'two', tmux: { name: 'research' } },
  ];
  assert.deepEqual(partitionSessionsByPrefix(threads, ['archive-'], (thread) => thread.tmux?.name), {
    visible: [threads[1]],
    hidden: [threads[0]],
  });
});

test('sessions use the longest matching folder prefix and preserve first-folder order', () => {
  const sessions = [
    { name: 'work-ui' },
    { name: 'work-api-auth' },
    { name: 'skills' },
    { name: 'work-docs' },
  ];
  assert.deepEqual(groupSessionsByPrefix(sessions, ['work-', 'work-api-']), [
    { type: 'folder', prefix: 'work-', items: [sessions[0], sessions[3]] },
    { type: 'folder', prefix: 'work-api-', items: [sessions[1]] },
    { type: 'session', item: sessions[2] },
  ]);

  const threads = [
    { id: 'one', tmux: { name: 'client-web' } },
    { id: 'two', tmux: { name: 'research' } },
  ];
  assert.deepEqual(groupSessionsByPrefix(threads, ['client-'], (thread) => thread.tmux?.name), [
    { type: 'folder', prefix: 'client-', items: [threads[0]] },
    { type: 'session', item: threads[1] },
  ]);
});

test('session folders are listed before ungrouped sessions', () => {
  const sessions = [
    { name: 'skills' },
    { name: 'work-ui' },
    { name: 'research' },
    { name: 'client-web' },
  ];

  assert.deepEqual(groupSessionsByPrefix(sessions, ['work-', 'client-']), [
    { type: 'folder', prefix: 'work-', items: [sessions[1]] },
    { type: 'folder', prefix: 'client-', items: [sessions[3]] },
    { type: 'session', item: sessions[0] },
    { type: 'session', item: sessions[2] },
  ]);
});

test('folder prefixes and expanded folders persist only in browser storage', () => {
  const storage = memoryStorage();
  assert.deepEqual(saveSessionFolderPrefixes(storage, ['work-', 'client-']), ['work-', 'client-']);
  assert.deepEqual(loadSessionFolderPrefixes(storage), ['work-', 'client-']);

  let expanded = setSessionFolderExpanded([], 'work-', true);
  assert.deepEqual(expanded, ['work-']);
  expanded = setSessionFolderExpanded(expanded, 'client-', true);
  expanded = setSessionFolderExpanded(expanded, 'work-', false);
  assert.deepEqual(expanded, ['client-']);
  assert.deepEqual(saveExpandedSessionFolders(storage, expanded), ['client-']);
  assert.deepEqual(loadExpandedSessionFolders(storage), ['client-']);

  saveSessionFolderPrefixes(storage, []);
  saveExpandedSessionFolders(storage, []);
  assert.equal(storage.getItem(SESSION_FOLDER_PREFIXES_STORAGE_KEY), null);
  assert.equal(storage.getItem(SESSION_FOLDER_EXPANSION_STORAGE_KEY), null);
});

test('both sidebars expose accessible browser-local visibility and folder controls', () => {
  for (const html of [appHtml, remoteHtml]) {
    assert.match(html, /id="sessionVisibilityButton"[^>]*aria-haspopup="dialog"[^>]*aria-controls="sessionVisibilityDialog"/);
    assert.match(html, /id="sessionVisibilityDialog"[^>]*aria-labelledby="sessionVisibilityTitle"/);
    assert.match(html, /<label for="folderSessionPrefixesInput">折叠为文件夹的 session 前缀<\/label>/);
    assert.match(html, /id="folderSessionPrefixesInput"[^>]*autocomplete="off"/);
    assert.match(html, /<label for="hiddenSessionPrefixesInput">隐藏的 session 前缀<\/label>/);
    assert.match(html, /id="sessionVisibilitySummary"[^>]*role="status"[^>]*aria-live="polite"/);
    assert.match(html, /id="showAllSessionsButton"[^>]*type="button"/);
  }
  for (const source of [appJs, remoteJs]) {
    assert.match(source, /loadHiddenSessionPrefixes/);
    assert.match(source, /loadSessionFolderPrefixes/);
    assert.match(source, /loadExpandedSessionFolders/);
    assert.match(source, /partitionSessionsByPrefix/);
    assert.match(source, /groupSessionsByPrefix/);
    assert.match(source, /setSessionFolderExpanded/);
    assert.match(source, /SESSION_FOLDER_PREFIXES_STORAGE_KEY/);
    assert.match(source, /SESSION_FOLDER_EXPANSION_STORAGE_KEY/);
  }
  for (const css of [appCss, remoteCss]) {
    assert.match(css, /\.sidebar-heading-actions\s*\{[^}]*display:\s*flex/s);
    assert.match(css, /\.session-visibility-button\s*\{[^}]*width:\s*44px;[^}]*height:\s*44px/s);
    assert.match(css, /\.session-prefix-input\s*\{[^}]*font-size:\s*16px/s);
    assert.match(css, /\.session-folder-summary\s*\{[^}]*min-height:\s*44px/s);
    assert.match(css, /\.session-folder-children\s*\{[^}]*border-left:/s);
  }
});
