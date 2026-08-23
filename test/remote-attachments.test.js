import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  attachmentMessage,
  validateAttachmentSelection,
} from '../public/remote-attachments.js';

function file(name, size = 1024, type = 'application/octet-stream') {
  return { name, size, type };
}

test('builds an Agent prompt from text and uploaded server paths', () => {
  assert.equal(attachmentMessage({
    provider: 'codex',
    text: '分析这张图',
    paths: ['/home/x/.codeck/uploads/chart.png', '/home/x/.codeck/uploads/notes.txt'],
  }), [
    '分析这张图',
    '',
    '附件（已上传到服务器，请读取以下路径）：',
    '- /home/x/.codeck/uploads/chart.png',
    '- /home/x/.codeck/uploads/notes.txt',
  ].join('\n'));
});

test('supports an attachment-only Agent turn without turning it into an interrupt', () => {
  assert.equal(attachmentMessage({
    provider: 'claude',
    text: '',
    paths: ['/home/x/.codeck/uploads/screenshot.jpg'],
  }), [
    '请查看并处理以下附件。',
    '',
    '附件（已上传到服务器，请读取以下路径）：',
    '- /home/x/.codeck/uploads/screenshot.jpg',
  ].join('\n'));
});

test('requires an explicit Shell command before appending safely quoted paths', () => {
  const path = "/home/x/.codeck/uploads/a user's file.txt";
  assert.equal(attachmentMessage({ provider: 'shell', text: '', paths: [path] }), '');
  assert.equal(
    attachmentMessage({ provider: 'shell', text: 'python inspect.py', paths: [path] }),
    "python inspect.py '/home/x/.codeck/uploads/a user'\\''s file.txt'",
  );
});

test('limits attachment count and rejects files larger than the upload route', () => {
  const files = [
    ...Array.from({ length: MAX_ATTACHMENTS }, (_, index) => file(`${index}.txt`)),
    file('too-many.txt'),
    file('too-large.bin', MAX_ATTACHMENT_BYTES + 1),
  ];
  const result = validateAttachmentSelection(files, 0);

  assert.equal(result.accepted.length, MAX_ATTACHMENTS);
  assert.equal(result.rejected.length, 2);
  assert.match(result.rejected[0].message, /最多添加/);
  assert.match(result.rejected[1].message, /100 MB/);
});
