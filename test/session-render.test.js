import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionsRenderSignature } from '../public/session-render.js';

const status = (s) => s?.status || 'done';
const timeLabel = (t) => (Date.now() - t < 60_000 ? '刚刚' : `${Math.round((Date.now() - t) / 60_000)}分钟前`);
const sign = (sessions, opts = {}) => sessionsRenderSignature(sessions, { status, timeLabel, ...opts });

test('a sub-second activity tick does not change what the sidebar renders', () => {
  // 这正是每 750ms 一次全量重建的来源: activityAt 每秒都在跳, 但相对时间是分桶的。
  const now = Date.now();
  const a = [{ name: 'skills', status: 'working', activityAt: now - 1_000, agent: { kind: 'codex' } }];
  const b = [{ name: 'skills', status: 'working', activityAt: now - 2_000, agent: { kind: 'codex' } }];
  assert.equal(sign(a), sign(b));
});

test('a status change does change the signature', () => {
  const now = Date.now();
  const a = [{ name: 'skills', status: 'working', activityAt: now, agent: { kind: 'codex' } }];
  const b = [{ name: 'skills', status: 'done', activityAt: now, agent: { kind: 'codex' } }];
  assert.notEqual(sign(a), sign(b));
});

test('renaming, reordering, adding and removing all change the signature', () => {
  const now = Date.now();
  const one = { name: 'a', status: 'done', activityAt: now, agent: null };
  const two = { name: 'b', status: 'done', activityAt: now, agent: null };
  assert.notEqual(sign([one]), sign([{ ...one, name: 'renamed' }]));
  assert.notEqual(sign([one, two]), sign([two, one]));
  assert.notEqual(sign([one]), sign([one, two]));
  assert.notEqual(sign([one, two]), sign([one]));
});

test('the active session, manage rights and folder state are part of the signature', () => {
  const now = Date.now();
  const rows = [{ name: 'a', status: 'done', activityAt: now, agent: null }];
  assert.notEqual(sign(rows, { active: 'a' }), sign(rows, { active: 'b' }));
  assert.notEqual(sign(rows, { canManage: true }), sign(rows, { canManage: false }));
  assert.notEqual(sign(rows, { extra: 'folders:x' }), sign(rows, { extra: 'folders:y' }));
});

test('crossing a relative-time bucket changes the signature', () => {
  const now = Date.now();
  const a = [{ name: 'a', status: 'done', activityAt: now - 30_000, agent: null }];
  const b = [{ name: 'a', status: 'done', activityAt: now - 300_000, agent: null }];
  assert.notEqual(sign(a), sign(b));
});

test('an agent kind change changes the icon and so the signature', () => {
  const now = Date.now();
  const a = [{ name: 'a', status: 'done', activityAt: now, agent: { kind: 'codex' } }];
  const b = [{ name: 'a', status: 'done', activityAt: now, agent: { kind: 'claude' } }];
  assert.notEqual(sign(a), sign(b));
});
