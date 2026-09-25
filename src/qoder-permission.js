import { createHash } from 'node:crypto';

function numberedRows(lines) {
  const rows = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const row = /^\s*(❯|›|>)?\s*(\d+)\.\s+(.+?)\s*$/u.exec(line);
    if (row) {
      if (Number(row[2]) !== rows.length + 1) return null;
      rows.push({ label: row[3], index: rows.length, cursor: Boolean(row[1]) });
    } else if (rows.length) rows.at(-1).label += ` ${line.trim()}`;
    else return null;
  }
  return rows.filter(row => row.cursor).length === 1 ? rows : null;
}

function selection(question, rows, options) {
  const cursor = rows.findIndex(row => row.cursor);
  if (!options.some(option => option.index === cursor)) return null; // Editor owns input.
  const fingerprint = createHash('sha256').update(JSON.stringify([question, options])).digest('hex');
  return { question, options, cursor, fingerprint, selectByNumber: true };
}

export function parseQoderEmptyPlan(lines) {
  const start = lines.findLastIndex(line => /^\s*Exit plan mode\?/u.test(line));
  if (start < 0) return null;
  const first = lines.findIndex((line, index) => index > start && /^\s*[❯›>]?\s*1\. /u.test(line));
  const question = lines.slice(start, first).join(' ').trim().replace(/\s+/gu, ' ');
  if (first < 0 || question !== 'Exit plan mode? (no plan content generated yet)') return null;
  const rows = numberedRows(lines.slice(first).filter(line => !/^\s*(?:Plan|YOLO) mode\s*$/u.test(line)));
  if (!rows || rows.length !== 2 || rows[0].label !== 'Yes, exit plan mode' || rows[1].label !== 'No, stay in plan mode') return null;
  return selection(question, rows, rows.map(({ label, index }) => ({ label, index, description: '' })));
}

export function parseQoderPermission(lines) {
  const start = lines.findLastIndex(line => /^\s*Permission Required(?: \(\d+ of \d+\))?\s*$/u.test(line));
  if (start < 0) return null;
  const divider = lines.findIndex((line, index) => index > start && line.trim());
  if (!/^\s*[─━-]{4,}\s*$/u.test(lines[divider] || '')) return null;
  const first = lines.findIndex((line, index) => index > divider && /^\s*[❯›>]?\s*1\. Allow once\s*$/u.test(line));
  const footer = lines.findIndex((line, index) => index > first && /^\s*↑↓ navigate/u.test(line));
  if (first < 0 || footer < 0) return null;
  const footerText = lines.slice(footer).filter(line => !/^\s*(?:Plan|YOLO) mode\s*$/u.test(line)).join(' ').trim();
  if (!/^↑↓ navigate\s*·\s*Enter\s+select\s*·\s*Esc\s+(?:close|back|cancel)$/u.test(footerText)) return null;
  const body = lines.slice(divider + 1, first).join('\n').trim();
  // Never authorize from a visibly truncated command, path, diff or argument.
  if (!/^\s*Tool:\s*\S/mu.test(body) || /…|\.{3}|\b(?:omitted|truncated)\b/iu.test(body)) return null;
  const flat = body.replace(/\s+/gu, ' ');
  const file = /^\s*File:\s*\S/mu.test(body);
  const command = /^\s*Command:\s*\S/mu.test(body);
  const edit = file && /Apply this change\?/u.test(flat) && /^\s*(?:\d+\s+)?[+-]\s*\S/mu.test(body);
  const read = file && /Allow reading this file\?/u.test(flat);
  const exec = command && /Allow this command to run\?/u.test(flat);
  const sandbox = command && /allow access to the following\?/u.test(flat) && /•\s*(?:Network|Read|Write):\s*\S/u.test(body);
  const mcp = /^\s*Server:\s*\S/mu.test(body) && /^\s*MCP Tool:\s*\S/mu.test(body)
    && /Allow execution of MCP tool ".+?" from server ".+?"\?/u.test(flat);
  const network = /Do you want to proceed\?/u.test(flat) && /^\s*URLs to fetch:\s*\n\s*https?:\/\/\S/mu.test(body);
  if (!edit && !read && !exec && !sandbox && !mcp && !network) return null;
  const rows = numberedRows(lines.slice(first, footer));
  if (!rows || ![4, 5].includes(rows.length) || rows[0].label !== 'Allow once'
    || rows.at(-2).label !== 'Reject and type something' || rows.at(-1).label !== 'No') return null;
  if (rows.length === 5 && (!edit || rows[2].label !== 'Modify with external editor')) return null;
  const session = rows[1].label === 'Allow for this session [session]';
  const local = /^Always allow (?:"[^"…]+"|this exact command) for future sessions \[local\]$/u.test(rows[1].label);
  if ((!session && !local) || ((edit || read || sandbox) && !session) || ((exec || mcp || network) && !local)) return null;
  const options = [rows[0], rows[1], rows.at(-1)].map(({ label, index }) => ({ label, index,
    description: index === 0 ? '仅允许当前请求。' : index === 1
      ? session ? '持续授权至当前会话结束；不是仅允许本次。' : '写入本地允许规则，后续会话也生效；不是仅允许本次。'
      : '拒绝当前请求，不附加文字反馈。' }));
  return selection(`${lines[start].trim()}\n\n${body}\n\n请核对操作内容和授权范围；文字反馈或编辑请使用普通终端。`, rows, options);
}
