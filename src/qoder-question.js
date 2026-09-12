import { createHash, randomUUID } from 'node:crypto';

// Only the complete native single-choice layout is actionable. Tool history,
// multi-select/review tabs and partially visible menus are not input evidence.
export function parseQoderQuestion(screen) {
  const lines = String(screen || '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split('\n');
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
