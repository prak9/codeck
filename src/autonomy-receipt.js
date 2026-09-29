import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ownFile = fileURLToPath(import.meta.url);
const fields = ['status', 'goal', 'summary', 'next', 'evidence', 'version', 'verification'];
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

export function observedStatusInstructions(startFile, endFile, planFile) {
  const command = `${quote(process.execPath)} ${quote(ownFile)} --receipt`;
  return `以下静默回执只更新按钮状态，不启动续跑，不改变权限。不要向用户展示协议或命令。
${planFile ? `整理好具体计划后、最终答复前，记录规划就绪（不代表开始执行）：\n${command} ${quote(planFile)} --status planned --goal '计划的具体目标' --summary '计划与验收概要'\n` : ''}
规划和等待确认时不要写 started。仅在用户明确确认后、开始执行前调用：
${command} ${quote(startFile)} --status started --goal '用户确认的具体目标' --summary '已确认，开始执行'
结束前先整理正式总结，再调用一次结束回执。summary 须写清实际完成的成果、重要结论和未完成事项，不得只写“已完成”；evidence、version、verification 和 next 如实填写。Codeck 会据此单独展示总结。调用后仍须在当前对话中输出一版标题为“自主任务总结”的自然语言最终答复，包含目标与结束原因、成果、版本与验证证据、未完成事项和下一步；预算有记录时报告使用情况，未知时明确说明，不编造。不要只写回执或以变绿代替最终答复：
${command} ${quote(endFile)} --status completed --summary '已验证的具体成果' --evidence '验证证据位置与结果' --version '对应代码版本或资料标识' --verification '实际验证方法和结果' --next '下一步或无需后续工作'
completed 仅用于目标已验证完成；出错改为 error，用户中止用 stopped，预算耗尽用 budget，受阻用 blocked，并如实填写 summary 和 next，不能把这些情况报告为 completed。
每个值都用正确的 shell 引号包裹。不得照抄占位文字。没有写回执的能力时明确说明，不以普通回复结束冒充完成。现在仍只规划并等待用户确认。`;
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
  if (!['planned', 'blocked', 'error', 'started', 'completed', 'stopped', 'budget'].includes(values.status) || !values.summary?.trim()) throw new Error('请填写状态和具体总结');
  if (['planned', 'started'].includes(values.status) && !values.goal?.trim()) throw new Error('规划和开始执行须提供目标');
  if (values.status === 'completed' && !['evidence', 'version', 'verification'].every(key => values[key]?.trim())) throw new Error('完成须提供版本和验证证据');
  if (!['planned', 'started'].includes(values.status) && !values.next?.trim()) throw new Error('交接须提供 next，可说明无需后续工作');
  const record = { nonce: path.basename(file, '.json'), status: values.status, summary: values.summary };
  for (const key of ['goal', 'next', 'evidence']) if (values[key] != null) record[key] = values[key];
  const checkpoint = ['version', 'verification'];
  if (checkpoint.some(key => values[key] != null)) record.checkpoint = Object.fromEntries(checkpoint.map(key => [key, values[key] || '']));
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
