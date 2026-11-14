import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/remote.js', import.meta.url), 'utf8');
const start = source.indexOf('function threadRow(');
const rowSource = source.slice(start, source.indexOf('\nfunction sessionFolderIcon(', start));
function fixture() {
  let opened = 0, shown = 0;
  const thread = { id: 'thread', provider: 'codex', tmux: { name: 'research', checkpoint: { text: '已建立基线' } } };
  const dialog = { open: false, showModal() { shown++; this.open = true; } };
  const details = { open: false };
  const context = vm.createContext({
    state: { provider: 'codex', thread, sessionClosePending: false },
    isThreadActive: () => true, providerDetails: () => ({ glyph: 'C' }),
    threadExecutionState: () => 'idle', executionLabel: () => '已就绪', timeAgo: () => '',
    checkpointLabel: record => record?.text || '',
    element(tag, className, text) { return { tag, className, text, dataset: {}, children: [], events: {},
      append(...nodes) { this.children.push(...nodes); }, setAttribute() {},
      addEventListener(type, fn) { this.events[type] = fn; } }; },
    openListedThread: async () => { opened++; }, setLiveMessage() {},
    $: selector => selector === '#progressDialog' ? dialog : details,
  });
  vm.runInContext(rowSource, context);
  const root = context.threadRow(thread, 0);
  const nodes = [];
  const visit = node => { nodes.push(node); node.children.forEach(visit); }; visit(root);
  return { nodes, get opened() { return opened; }, get shown() { return shown; } };
}

test('opening the active session with keyboard or its summary never opens the note', async () => {
  const f = fixture();
  const row = f.nodes.find(node => node.className?.split(' ').includes('thread-row'));
  row.events.click({ detail: 0, target: { closest: () => null } });
  await new Promise(setImmediate);
  assert.equal(f.opened, 1); assert.equal(f.shown, 0);
});

test('the note has its own sibling button rather than a clickable text area inside the session button', async () => {
  const f = fixture();
  const row = f.nodes.find(node => node.className?.split(' ').includes('thread-row'));
  const button = f.nodes.find(node => node.className === 'thread-progress-button');
  assert.ok(button, 'a dedicated note button is required');
  assert.equal(button.tag, 'button'); assert.equal(row.children.includes(button), false);
  button.events.click(); await new Promise(setImmediate);
  assert.equal(f.opened, 1); assert.equal(f.shown, 1);
});
