import { createHash } from 'node:crypto';

// This is a local TUI menu, not an app-server requestUserInput. Recognize only
// the complete rate-limit switch menu; quoted history must not authorize input.
export function parseCodexQuestion(screen) {
  const lines = String(screen || '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split('\n')
    .map(line => line.trim()).filter(Boolean);
  const start = lines.lastIndexOf('Approaching rate limits');
  if (start < 0) return null;
  const footer = lines.findIndex((line, index) => index > start && line.startsWith('Press enter to '));
  if (footer < 0 || !/^Press enter to confirm or esc to (?:go back|cancel)\.?$/u.test(lines.slice(footer).join(' '))) return null;
  const options = [];
  let first = -1;
  for (let i = start + 1; i < footer; i++) {
    const match = /^([›>❯])?\s*(\d+)\.\s+(.+)$/u.exec(lines[i]);
    if (match) {
      if (Number(match[2]) !== options.length + 1) return null;
      if (first < 0) first = i;
      options.push({ text: match[3], cursor: Boolean(match[1]) });
    } else if (options.length) options.at(-1).text += ` ${lines[i]}`;
  }
  if (options.length !== 3 || options.filter(option => option.cursor).length !== 1) return null;
  const patterns = [/^(Switch to .+?)(?:\s+Uses fewer credits for upcoming turns)?$/u,
    /^(Keep current model)$/u,
    /^(Keep current model \(never show again\))(?:\s+Hide future rate limit reminders about switching models)?$/u];
  const parsed = options.map((option, index) => patterns[index].exec(option.text));
  if (parsed.some(match => !match) || options.some(option => /[›❯]|```/u.test(option.text))) return null;
  const choices = parsed.map((match, index) => ({ label: match[1], description: options[index].text.slice(match[1].length).trim() }));
  const question = lines.slice(start, first).join('\n');
  const fingerprint = createHash('sha256').update(JSON.stringify([question, choices])).digest('hex');
  return { question, options: choices, cursor: options.findIndex(option => option.cursor), fingerprint };
}
