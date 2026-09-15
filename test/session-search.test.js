import test from 'node:test';
import assert from 'node:assert/strict';
import { filterSessionNames } from '../public/session-search.js';

test('search is case-insensitive, literal, trimmed and preserves order and identity', () => {
  const sessions = [{ name: 'Report-A' }, { name: '研究' }, { name: 'report-B' }, { name: '[tmp]' }];
  assert.deepEqual(filterSessionNames(sessions, ' REPORT '), [sessions[0], sessions[2]]);
  assert.deepEqual(filterSessionNames(sessions, '研究'), [sessions[1]]);
  assert.deepEqual(filterSessionNames(sessions, '['), [sessions[3]]);
  assert.deepEqual(filterSessionNames(sessions, 'none'), []);
  assert.equal(filterSessionNames(sessions, '  '), sessions);
});

test('Remote uses the displayed tmux name and filtering cannot reintroduce hidden sessions', () => {
  const threads = [{ name: 'unrelated', tmux: { name: 'skills' } }, { name: 'fallback' }];
  const name = thread => thread.tmux?.name || thread.name;
  assert.deepEqual(filterSessionNames(threads, 'SKILL', name), [threads[0]]);
  assert.deepEqual(filterSessionNames(threads, 'unrelated', name), []);
  assert.deepEqual(filterSessionNames([], 'hidden', name), []);
});
