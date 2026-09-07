import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const source = fs.readFileSync(new URL('../public/remote.js', import.meta.url), 'utf8');

function load(context, name) {
  const start = source.search(new RegExp(`^function ${name}\\(`, 'm'));
  vm.runInContext(source.slice(start, start + source.slice(start).search(/^}$/m) + 1), context);
}

function node(tag, className = '', text = '') {
  return {
    tag, className, textContent: text, children: [], dataset: {}, attributes: {},
    hidden: false, isConnected: false,
    append(...children) { this.children.push(...children); },
    setAttribute(name, value) { this.attributes[name] = value; },
  };
}

function fixture(thread) {
  const context = vm.createContext({
    state: { thread },
    element: node,
    agentActivityText: () => '正在生成 · 20分08秒',
    requestAnimationFrame() {},
  });
  for (const name of ['terminalActivityKey', 'terminalActivityNode', 'terminalActivityContent']) load(context, name);
  return context;
}

test('Agent pane fallback uses the same message surface and order as final output', () => {
  const context = fixture({
    provider: 'qodercli', liveOutput: '当前回复\n- 第一项',
    tmux: { status: 'working', available: true },
  });
  const content = context.terminalActivityContent();
  const activity = context.terminalActivityNode(content);
  const [output, foot] = activity.children;

  assert.equal(content.presentation, 'assistant');
  assert.match(activity.className, /agent-live-activity/);
  assert.equal(output.tag, 'div');
  assert.match(output.className, /assistant-message/);
  assert.match(output.className, /streaming/);
  assert.doesNotMatch(output.className, /terminal-live-output/);
  assert.equal(output.textContent, '当前回复\n- 第一项');
  assert.match(foot.className, /turn-foot/);
});

test('Shell pane fallback remains a bounded terminal surface', () => {
  const context = fixture({
    provider: 'shell', liveOutput: '$ npm test\n830 tests passed',
    tmux: { status: 'done', available: true },
  });
  const content = context.terminalActivityContent();
  const activity = context.terminalActivityNode(content);

  assert.equal(content.presentation, 'terminal');
  assert.doesNotMatch(activity.className, /agent-live-activity/);
  assert.equal(activity.children[1].tag, 'pre');
  assert.match(activity.children[1].className, /terminal-live-output/);
});
