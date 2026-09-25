import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ownFile = fileURLToPath(import.meta.url);
const fields = ['status', 'summary', 'next', 'evidence', 'progress', 'baseline', 'version', 'verification', 'current', 'best-version', 'best-evidence', 'best-artifact'];
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

export function receiptInstructions(file, summary = false) {
  return `不要在对话中输出协议 JSON。结束本轮前，用命令工具调用以下静默回执程序，之后只向用户输出自然语言${summary ? '交接总结' : '进展或交接总结'}：
${quote(process.execPath)} ${quote(ownFile)} --receipt ${quote(file)} --status ${summary ? 'summary' : 'continue'} --summary '本轮具体进展、结果或结束原因' --next '下一步或恢复建议'
${summary ? '本次只允许 summary，不开始新工作。' : 'status 选择 continue、complete、wait、blocked、error；continue/wait 加 --progress true 或 false，complete 加 --evidence。continue/wait/complete 加 --baseline、--version、--verification、--current（未完成尝试，完成可为空）。有新的可靠成果时加 --best-version、--best-evidence、--best-artifact。'}
每个参数值用正确的 shell 引号包裹。参数必须如实填写，不使用示例占位文字。程序成功时没有输出；若失败，只修复回执参数或报告原因，不重做本轮工作，不将 JSON 粘贴到回复中。`;
}

export function readReceipt(file, nonce) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 100_000) throw new Error('自主回执文件无效');
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (record.nonce !== nonce) throw new Error('自主回执身份不匹配');
    return record;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function writeReceipt(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]?.replace(/^--/u, '');
    if (!args[index]?.startsWith('--') || !['receipt', ...fields].includes(key) || Object.hasOwn(values, key)
      || typeof args[index + 1] !== 'string' || args[index + 1].length > 4000) throw new Error('回执参数无效');
    values[key] = args[index + 1];
  }
  const file = values.receipt;
  if (!file || !path.isAbsolute(file) || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}\.json$/u.test(path.basename(file))) throw new Error('回执路径无效');
  if (!['continue', 'complete', 'wait', 'blocked', 'error', 'summary'].includes(values.status) || !values.summary?.trim()) throw new Error('请填写状态和具体总结');
  if (values.progress != null && !['true', 'false'].includes(values.progress)) throw new Error('progress 必须为 true 或 false');
  if (['continue', 'wait'].includes(values.status) && (!values.next?.trim() || values.progress == null)) throw new Error('继续执行须提供 next 和 progress');
  if (values.status === 'complete' && !values.evidence?.trim()) throw new Error('完成须提供 evidence');
  if (['summary', 'complete', 'blocked', 'error'].includes(values.status) && !values.next?.trim()) throw new Error('交接须提供 next，可说明无需后续工作');
  if (['continue', 'wait', 'complete'].includes(values.status) && (!['baseline', 'version', 'verification'].every(key => values[key]?.trim())
    || values.current == null)) throw new Error('请填写 baseline、version、verification 和 current');
  if (['best-version', 'best-evidence', 'best-artifact'].some(key => values[key] != null)
    && !['best-version', 'best-evidence', 'best-artifact'].every(key => values[key]?.trim())) throw new Error('最佳成果须包含版本、证据和位置');
  const record = { nonce: path.basename(file, '.json'), status: values.status, summary: values.summary };
  for (const key of ['next', 'evidence']) if (values[key] != null) record[key] = values[key];
  if (values.progress != null) record.progress = values.progress === 'true';
  const checkpoint = ['baseline', 'version', 'verification', 'current'];
  if (checkpoint.some(key => values[key] != null)) record.checkpoint = Object.fromEntries(checkpoint.map(key => [key, values[key] || '']));
  if (fields.some(key => key.startsWith('best-') && values[key] != null)) record.best = Object.fromEntries(['version', 'evidence', 'artifact'].map(key => [key, values[`best-${key}`] || '']));
  const encoded = JSON.stringify(record);
  const existing = readReceipt(file, record.nonce);
  if (existing) {
    if (JSON.stringify(existing) !== encoded) throw new Error('本轮已有回执，不允许覆盖');
    return;
  }
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, encoded, { flag: 'wx', mode: 0o600 });
  try { fs.linkSync(temporary, file); }
  catch (error) {
    if (error.code !== 'EEXIST' || JSON.stringify(readReceipt(file, record.nonce)) !== encoded) throw error;
  } finally { fs.unlinkSync(temporary); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === ownFile) {
  try { writeReceipt(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
