import { createHash, randomUUID } from 'node:crypto';
import { parseQoderEmptyPlan, parseQoderPermission } from './qoder-permission.js';

// ExitPlanMode has its own layout, not the Asking User footer. Keep the exact
// native option order: the feedback editor occupies index 2 but cannot be
// submitted as a plain choice. Include the visible plan in the approval identity.
function parseQoderPlan(lines) {
  const header = lines.findLastIndex(line => line.trim() === "Here is Qoder's plan:");
  const start = Math.max(0, header);
  const prompt = lines.findIndex((line, index) => index > start && /^\s*Qoder has written up a plan/u.test(line));
  const first = lines.findIndex((line, index) => index > prompt && /^\s*[❯›>]?\s*1\. /u.test(line));
  if (prompt < 0 || first < 0 || lines.slice(prompt, first).join(' ').trim().replace(/\s+/gu, ' ')
    !== 'Qoder has written up a plan and is ready to execute. Would you like to proceed?') return null;
  const plan = lines.slice(header < 0 ? start : start + 1, prompt).map(line => line.trim()).filter(Boolean);
  if (plan.length < 2 || !/^[─━-]{4,}$/u.test(plan.at(-1))
    || (header >= 0 && (plan.length < 3 || !/^[─━-]{4,}$/u.test(plan[0])))) return null;
  const labels = ['Yes, start executing', 'Yes, execute as Goal', 'Refuse and say something', 'Reject plan'];
  const rows = [];
  let last = -1;
  for (let index = first; index < lines.length; index += 1) {
    const row = /^\s*(❯|›|>)?\s*(\d+)\.\s+(.+?)\s*$/u.exec(lines[index]);
    if (row) {
      if (Number(row[2]) !== rows.length + 1 || row[3] !== labels[rows.length]) return null;
      rows.push({ label: row[3], description: '', cursor: Boolean(row[1]) });
      if (rows.length === 4) { last = index; break; }
    } else if (rows.length && lines[index].trim()) {
      rows.at(-1).description += `${rows.at(-1).description ? '\n' : ''}${lines[index].trim()}`;
    }
  }
  if (last < 0 || rows.filter(row => row.cursor).length !== 1) return null;
  const tail = lines.slice(last + 1).map(line => line.trim()).filter(Boolean);
  const description = tail.shift() || '';
  if (!description || !'Reject this plan without providing feedback.'.startsWith(description.replace(/…$/u, ''))) return null;
  rows[3].description = description;
  const footer = tail.filter(line => !/^(?:Plan|YOLO) mode$/u.test(line)).join(' ');
  if ((header < 0 || footer) && !/^(?:ctrl[+-][a-z]|⌃[a-z]) to edit plan$/iu.test(footer)) return null;
  const cursor = rows.findIndex(row => row.cursor);
  if (cursor === 2) return null; // Numeric keys belong to the native feedback editor.
  const options = rows.flatMap(({ label, description }, index) => index === 2 ? [] : [{ label, description, index }]);
  const question = `${header < 0 ? '以下为终端可见计划片段，请在普通终端核对完整计划。\n\n' : ''}${lines.slice(start, first).map(line => line.trim()).join('\n').trim()}\n\n文字反馈请使用普通终端。`;
  const fingerprint = createHash('sha256').update(JSON.stringify(['plan', question, options])).digest('hex');
  return { question, options, cursor, fingerprint, selectByNumber: true };
}

// Only the complete native single-choice layout is actionable. Tool history,
// multi-select/review tabs and partially visible menus are not input evidence.
export function parseQoderQuestion(screen) {
  const lines = String(screen || '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split('\n');
  const approval = parseQoderPermission(lines) || parseQoderEmptyPlan(lines);
  if (approval) return approval;
  const plan = parseQoderPlan(lines);
  if (plan) return plan;
  const start = lines.findLastIndex(line => line.trim() === 'Asking User');
  const divider = lines.findIndex((line, index) => index > start && line.trim());
  if (start < 0 || !/^\s*[─━-]{4,}\s*$/u.test(lines[divider] || '')) return null;
  const footer = lines.findIndex((line, index) => index > divider && /^\s*↑↓ navigate/u.test(line));
  let footerEnd = -1;
  for (let end = footer; footer >= 0 && end < Math.min(lines.length, footer + 4); end += 1) {
    if (/^\s*↑↓ navigate\s*·\s*Enter\s+select\s*·\s*Esc\s+back\s*$/u.test(lines.slice(footer, end + 1).join(' '))) {
      footerEnd = end;
      break;
    }
  }
  if (footerEnd < 0 || lines.slice(footerEnd + 1).filter(line => line.trim()).length > 5
    || lines.slice(footerEnd + 1).some(line => /^\s*[>❯]\s|User answered:|Generating\.\.\./u.test(line))) return null;
  const rows = [];
  let first = -1;
  for (let index = divider + 1; index < footer; index += 1) {
    const row = /^\s*(❯|›|>)?\s*(\d+)\.\s+(.+?)\s*$/u.exec(lines[index]);
    if (row) {
      if (first < 0) first = index;
      if (Number(row[2]) !== rows.length + 1) return null;
      rows.push({ label: row[3], description: '', cursor: Boolean(row[1]) });
    } else if (rows.length && lines[index].trim()) {
      const previous = rows.at(-1);
      previous.description += `${previous.description ? '\n' : ''}${lines[index].trim()}`;
    }
  }
  if (rows.length < 2 || rows.length > 9 || rows.at(-1).label !== 'Type Something'
    || rows.at(-1).description || rows.filter(row => row.cursor).length !== 1) return null;
  const question = lines.slice(divider + 1, first).map(line => line.trim()).filter(Boolean).join('\n');
  if (!question || /```|User answered:|\bSubmit\b/u.test(question)) return null;
  const cursor = rows.findIndex(row => row.cursor);
  if (cursor === rows.length - 1) return null; // Native free-text editor owns input.
  const options = rows.slice(0, -1).map(({ label, description }) => ({ label, description }));
  if (new Set(options.map(option => option.label)).size !== options.length) return null;
  const fingerprint = createHash('sha256').update(JSON.stringify([question, options])).digest('hex');
  return { question, options, cursor, fingerprint };
}

export class QoderQuestionTracker {
  constructor() { this.entries = new Map(); }

  observe(sessionName, agent, screen) {
    const question = agent?.kind === 'qodercli' && agent.id && agent.paneId ? parseQoderQuestion(screen) : null;
    if (!question) { this.entries.delete(sessionName); return null; }
    const identity = `${agent.id}:${agent.paneId}:${question.fingerprint}`;
    let entry = this.entries.get(sessionName);
    if (entry?.identity !== identity) {
      entry = { identity, id: randomUUID(), consumed: false };
      this.entries.delete(sessionName);
      this.entries.set(sessionName, entry);
      if (this.entries.size > 128) this.entries.delete(this.entries.keys().next().value);
    }
    if (entry.consumed) return null;
    return { id: entry.id, question: question.question, options: question.options };
  }

  consume(sessionName, id) {
    const entry = this.entries.get(sessionName);
    if (!entry || entry.id !== id || entry.consumed) throw new Error('询问已变化或已回答，请等待刷新');
    entry.consumed = true;
  }
}
