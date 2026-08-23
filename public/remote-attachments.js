export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export function validateAttachmentSelection(files, currentCount = 0) {
  const accepted = [];
  const rejected = [];
  for (const file of Array.from(files || [])) {
    if (Number(file?.size || 0) > MAX_ATTACHMENT_BYTES) {
      rejected.push({ file, message: `${file?.name || '文件'} 超过 100 MB` });
      continue;
    }
    if (currentCount + accepted.length >= MAX_ATTACHMENTS) {
      rejected.push({ file, message: `最多添加 ${MAX_ATTACHMENTS} 个附件` });
      continue;
    }
    accepted.push(file);
  }
  return { accepted, rejected };
}

export function attachmentMessage({ provider, text, paths }) {
  const prompt = String(text || '').trim();
  const uploadedPaths = Array.from(paths || []).filter(Boolean);
  if (!uploadedPaths.length) return prompt;
  if (provider === 'shell') {
    if (!prompt) return '';
    return `${prompt} ${uploadedPaths.map(shellQuote).join(' ')}`;
  }
  return [
    prompt || '请查看并处理以下附件。',
    '',
    '附件（已上传到服务器，请读取以下路径）：',
    ...uploadedPaths.map((path) => `- ${path}`),
  ].join('\n');
}
