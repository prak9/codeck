import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ownFile = fileURLToPath(import.meta.url);
const fields = ['status', 'goal', 'summary', 'next', 'evidence', 'version', 'verification', 'cleanup'];
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

export function cleanupInstructions(file) {
  const command = `${quote(process.execPath)} ${quote(ownFile)} --receipt ${quote(file)}`;
  return `本轮只做退出清理，不执行原任务、不创建或恢复 goal。清理能够确认属于本任务的后台进程、子 Agent、临时文件和连接，保留成果、证据和用户原有资源。逐项核验清理结果；归属不明或清理失败时如实报告，不能声称清理完成。
全部清理核验完成后执行：${command} --status stopped --summary '具体清理结果' --evidence '资源与核验结果' --next '无需后续清理'
仍有未清理资源时执行：${command} --status error --summary '未清理资源及原因' --next '恢复动作'
请替换占位文字，只写这份清理回执，不写旧回执。然后只总结当前目标、进展、结果、验证证据、未完成事项和下一步，不要续跑。`;
}

export function observedStatusInstructions(startFile, endFile, planFile) {
  const command = `${quote(process.execPath)} ${quote(ownFile)} --receipt`;
  return `以下静默回执只更新按钮状态，不启动续跑，不改变权限。不要向用户展示协议或命令。
${planFile ? `整理好具体计划后、最终答复前，记录规划就绪（不代表开始执行）：\n${command} ${quote(planFile)} --status planned --goal '计划的具体目标' --summary '计划与验收概要'\n` : ''}
规划和等待确认时不要写 started。仅在用户明确确认后、开始执行前调用：
${command} ${quote(startFile)} --status started --goal '用户确认的具体目标' --summary '已确认，开始执行'
结束前先清理本任务创建且能够确认归属的后台进程、子 Agent 和临时资源，保留用户已有资源、成果与验证证据；清理失败或归属不明的资源写入交接。原生 goal 仅在目标确实完成时标记完成，其他结束原因如实保留，由 Codeck 在最终答复结束后清除。随后整理正式总结，再调用一次结束回执。summary 须写清实际完成的成果、重要结论和未完成事项，不得只写“已完成”；evidence、version、verification 和 next 如实填写。Codeck 会据此单独展示总结。调用后仍须在当前对话中输出一版标题为“自主任务总结”的自然语言最终答复，包含目标与结束原因、成果、版本与验证证据、未完成事项和下一步；预算有记录时报告使用情况，未知时明确说明，不编造。不要只写回执或以变绿代替最终答复：
${command} ${quote(endFile)} --status completed --summary '已验证的具体成果' --evidence '验证证据位置与结果' --version '对应代码版本或资料标识' --verification '实际验证方法和结果' --cleanup '已清理的任务资源及核验结果' --next '下一步或无需后续工作'
只有全部任务资源清理核验完成才能填写 cleanup；若未创建任何资源，也须明确说明。存在遗留资源时省略 cleanup，并在 summary 和 next 中列明，Codeck 将保留退出失败状态，等待重试清理。
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
  for (const key of ['goal', 'next', 'evidence', 'cleanup']) if (values[key] != null) record[key] = values[key];
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
