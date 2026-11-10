import test from 'node:test';
import assert from 'node:assert/strict';
import { renderSessionProgress } from '../public/session-progress.js';

function node(tag) {
  return { tag, textContent: '', children: [], dataset: {}, hidden: false, open: false,
    append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; },
    querySelector(selector) { return this.children.find(item => item.tag === selector) || this.children.map(item => item.querySelector(selector)).find(Boolean); } };
}

test('progress survives empty-session switches, preserves expansion only for its task, and keeps unsafe links inert', () => {
  const original = globalThis.document; globalThis.document = { createElement: node };
  try {
    const host = node('div'); let responses = 0;
    const record = { text: '<script>not markup</script>', updatedAt: '2026-11-10T10:00:00Z', progress: {
      goal: '修复输入', needsUser: '确认验收标准', evidence: [{ label: 'safe', url: '/pages/example' }, { label: 'unsafe', url: 'javascript:alert(1)' }] } };
    const options = { key: 'task', onRespond: () => responses++ };
    renderSessionProgress(host, record, options);
    host.querySelector('details').open = true;
    host.querySelector('details').querySelector('div').querySelector('section').querySelector('button').onclick();
    assert.equal(responses, 1);
    renderSessionProgress(host, { ...record, text: '有新进展' }, options);
    assert.equal(host.querySelector('details').open, true);
    renderSessionProgress(host, null, options); assert.equal(host.hidden, true);
    renderSessionProgress(host, { ...record, text: '有新进展' }, options);
    assert.equal(host.hidden, false, 'returning to a task must restore a previously identical record');
    assert.equal(host.querySelector('details').open, false);
    const body = host.querySelector('details').querySelector('div');
    assert.equal(body.children.find(item => item.className === 'progress-links').children.length, 1);
    renderSessionProgress(host, { ...record, stale: true }, options);
    const stale = host.querySelector('details');
    assert.match(stale.querySelector('summary').children[0].textContent, /历史进度/);
    assert.equal(stale.querySelector('div').querySelector('section').querySelector('button'), undefined);
  } finally { globalThis.document = original; }
});
