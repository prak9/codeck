import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

function functionSource(name) {
  const start = source.indexOf(`function ${name}(`);
  return start < 0 ? '' : source.slice(start, source.indexOf('\n}', start) + 2);
}

function fixture() {
  const calls = [];
  const listeners = new Map();
  const nodes = {
    '#newForm': { elements: { client: { value: 'codex' } }, addEventListener: (type, handler) => listeners.set(type, handler) },
    '#resumeSessionInput': { checked: false, disabled: false },
    '#resumeSessionOption': { hidden: false },
    '#nameInput': { value: 'work', select() {} },
    '#cwdInput': { value: '/data/project' },
    '#newError': { textContent: '' },
    '#createButton': { disabled: false, textContent: '创建会话' },
    '#newDialog': { open: true, showModal() { this.open = true; }, close() { this.open = false; } },
  };
  const $ = (selector) => nodes[selector];
  const context = vm.createContext({
    $, Date, state: { newDialogGeneration: 0 },
    FormData: function (form) {
      const entries = [
        ['name', $('#nameInput').value], ['cwd', $('#cwdInput').value], ['client', form.elements.client.value],
      ];
      const resume = $('#resumeSessionInput');
      if (resume.checked && !resume.disabled) entries.push(['mode', 'resume']);
      return new Map(entries);
    },
    api: async (path, options) => calls.push({ path, payload: JSON.parse(options.body) }),
    connect: (name) => calls.push({ connect: name }),
    refreshSessions: async () => calls.push({ refresh: true }),
  });
  for (const name of ['syncNewSessionMode', 'openNewDialog']) vm.runInContext(functionSource(name), context);
  const changeStart = source.indexOf("$('#newForm').addEventListener('change'");
  const submitStart = source.indexOf("$('#newForm').addEventListener('submit'");
  const end = source.indexOf("\n$('#killButton').addEventListener", submitStart);
  vm.runInContext(source.slice(changeStart < 0 ? submitStart : changeStart, end), context);
  const submit = (value = 'default') => {
    const event = { currentTarget: $('#newForm'), submitter: { value }, prevented: false, preventDefault() { this.prevented = true; } };
    return { event, pending: listeners.get('submit')(event) };
  };
  const selectClient = (value) => {
    $('#newForm').elements.client.value = value;
    listeners.get('change')?.({ target: { name: 'client' } });
  };
  return { $, calls, context, selectClient, submit };
}

test('normal creation keeps Shell and exposes an unchecked native resume control', () => {
  assert.match(html, /type="radio" name="client" value="shell"/);
  const resume = html.match(/<input[^>]+id="resumeSessionInput"[^>]*>/)?.[0];
  assert.ok(resume, 'the resume checkbox exists');
  assert.match(resume, /type="checkbox"/);
  assert.match(resume, /name="mode" value="resume"/);
  assert.doesNotMatch(resume, /\bchecked\b/);
});

for (const client of ['codex', 'claude', 'qodercli', 'shell']) {
  test(`normal ${client} creation defaults to new and preserves directory and attach order`, async () => {
    const f = fixture();
    f.selectClient(client);
    await f.submit().pending;
    assert.deepEqual(f.calls, [
      { path: '/api/sessions', payload: { name: 'work', cwd: '/data/project', client, mode: 'new' } },
      { connect: 'work' }, { refresh: true },
    ]);
  });
}

test('normal Agent resume sends the mode without changing name or directory handling', async () => {
  const f = fixture();
  f.$('#resumeSessionInput').checked = true;
  f.$('#cwdInput').value = '';
  await f.submit().pending;
  assert.deepEqual(f.calls[0].payload, { name: 'work', client: 'codex', mode: 'resume' });
});

test('switching through Shell hides and clears resume before returning to an Agent', async () => {
  const f = fixture();
  f.$('#resumeSessionInput').checked = true;
  f.selectClient('shell');
  assert.equal(f.$('#resumeSessionOption').hidden, true);
  assert.equal(f.$('#resumeSessionInput').disabled, true);
  assert.equal(f.$('#resumeSessionInput').checked, false);
  f.selectClient('claude');
  assert.equal(f.$('#resumeSessionOption').hidden, false);
  assert.equal(f.$('#resumeSessionInput').disabled, false);
  assert.equal(f.$('#resumeSessionInput').checked, false);
  await f.submit().pending;
  assert.equal(f.calls[0].payload.mode, 'new');
});

test('reopening normal creation resets resume while retaining the chosen client and directory', () => {
  const f = fixture();
  f.selectClient('claude');
  f.$('#resumeSessionInput').checked = true;
  f.context.openNewDialog();
  assert.equal(f.$('#resumeSessionInput').checked, false);
  assert.equal(f.$('#newForm').elements.client.value, 'claude');
  assert.equal(f.$('#cwdInput').value, '/data/project');
  assert.match(f.$('#nameInput').value, /^agent-/);
});

test('normal creation cancellation does not prevent native dialog closure or submit', async () => {
  const f = fixture();
  const { event, pending } = f.submit('cancel');
  await pending;
  assert.equal(event.prevented, false);
  assert.deepEqual(f.calls, []);
});

test('normal creation rejects duplicate submits while preserving retry after failure', async () => {
  const f = fixture();
  let reject;
  let requests = 0;
  f.context.api = () => { requests += 1; return new Promise((resolve, fail) => { reject = fail; }); };
  f.$('#resumeSessionInput').checked = true;
  const first = f.submit().pending;
  const second = f.submit();
  assert.equal(requests, 1);
  assert.equal(second.event.prevented, true);
  reject(new Error('创建失败'));
  await Promise.all([first, second.pending]);
  assert.equal(f.$('#newDialog').open, true);
  assert.equal(f.$('#newError').textContent, '创建失败');
  assert.equal(f.$('#resumeSessionInput').checked, true);
  assert.equal(f.$('#createButton').disabled, false);
});
