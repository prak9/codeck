import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { findTranscriptFile } from '../src/transcript-watch.js';

test('locates a Claude transcript by thread id under any project folder', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeck-tw-'));
  const id = '891b9333-925d-4923-9666-fee54f76fe23';
  const project = path.join(root, 'claude', 'projects', '-data-code-skills');
  fs.mkdirSync(project, { recursive: true });
  const file = path.join(project, `${id}.jsonl`);
  fs.writeFileSync(file, '{}\n');

  assert.equal(findTranscriptFile('claude', id, { claudeHome: path.join(root, 'claude') }), file);
});

test('locates a Codex rollout by thread id under its dated folder', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeck-tw-'));
  const id = '01a028e3-8058-73e0-bfc7-e7643f298b0f';
  const day = path.join(root, 'codex', 'sessions', '2026', '08', '22');
  fs.mkdirSync(day, { recursive: true });
  const file = path.join(day, `rollout-2026-08-22T17-53-13-${id}.jsonl`);
  fs.writeFileSync(file, '{}\n');

  assert.equal(findTranscriptFile('codex', id, { codexHome: path.join(root, 'codex') }), file);
});

test('an unknown thread resolves to nothing so polling stays as it is', () => {
  // 找不到就必须原样退回轮询, 不能因为监听失败反而变慢。
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeck-tw-'));
  assert.equal(findTranscriptFile('codex', '01a00000-0000-7000-8000-000000000000', { codexHome: root }), null);
  assert.equal(findTranscriptFile('shell', 'anything', { codexHome: root }), null);
  assert.equal(findTranscriptFile('claude', 'not-a-uuid', { claudeHome: root }), null);
});
