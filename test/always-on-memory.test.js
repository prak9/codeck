import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMemoryStore, normalizeMemoryPath } from '../src/always-on-memory.js';

test('normalizeMemoryPath blocks traversal and invalid roots', () => {
  assert.equal(normalizeMemoryPath('instructions.md'), 'instructions.md');
  assert.equal(normalizeMemoryPath('notes/prefs.md'), 'notes/prefs.md');
  assert.equal(normalizeMemoryPath('/progress/task-1.md'), 'progress/task-1.md');
  assert.throws(() => normalizeMemoryPath('../secrets.txt'), /非法/);
  assert.throws(() => normalizeMemoryPath('notes/sub/a.md'), /仅允许/);
  assert.throws(() => normalizeMemoryPath('random.md'), /仅允许/);
});

test('MemoryStore maintains lean baseline, rebuilds index, deduplicates reported, and runs Dreaming safely', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codeck-memory-'));
  try {
    const store = createMemoryStore({ directory: dir, maxBaselineBytes: 8192 });
    const base = await store.readBaseline();
    assert.equal(base.withinBudget, true);
    assert.match(base.instructions, /个人长期指令/);

    // Write active + completed progress + locked completed progress + notes with duplicate bullets
    await store.writeFile('progress/active-task.md', '# 活跃任务\nstatus: active\n- pointer: page:p1\n');
    await store.writeFile('progress/done-task.md', '# 已完成任务\nstatus: done\n- pointer: commit:abc123\n');
    await store.writeFile('progress/locked-done.md', '<!-- locked -->\n# 锁定已完成\nstatus: done\n');
    await store.writeFile('notes/style.md', '# 偏好\n- 简洁输出\n- 简洁输出\n- 附带证据\n');
    await store.writeFile('notes/locked-note.md', '<!-- locked -->\n# 锁定笔记\n- 重复项\n- 重复项\n');

    // Append reported with dedupe
    const r1 = await store.appendReported({ title: '日报', summary: '测试全过', ref: '/pages/1' });
    const r2 = await store.appendReported({ title: '日报', summary: '测试全过', ref: '/pages/1' });
    assert.equal(r1.appended, true);
    assert.equal(r2.appended, false);

    // Run Dreaming
    const report = await store.runDreaming({ now: 123456 });
    assert.equal(report.archived.length, 1);
    assert.equal(report.archived[0].from, 'progress/done-task.md');
    assert.equal(report.archived[0].to, 'archive/done-task.md');
    assert.equal(report.dedupedNotes.length, 1);
    assert.equal(report.dedupedNotes[0].path, 'notes/style.md');
    assert.equal(report.dedupedNotes[0].removed, 1);

    // Locked files remain completely untouched
    const lockedProg = await store.readFile('progress/locked-done.md');
    assert.equal(lockedProg.locked, true);
    const lockedNote = await store.readFile('notes/locked-note.md');
    assert.equal(lockedNote.content.match(/- 重复项/g).length, 2);

    // Index reflects only remaining progress files
    const index = await store.readFile('index.md');
    assert.match(index.content, /progress\/active-task\.md/);
    assert.match(index.content, /progress\/locked-done\.md/);
    assert.doesNotMatch(index.content, /progress\/done-task\.md/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
