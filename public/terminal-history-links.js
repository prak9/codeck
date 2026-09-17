// Same HTTP(S) boundaries as @xterm/addon-web-links (MIT).
export const HTTP_URL_PATTERN = /(https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\\^<>`]*[^\s"':,.!?{}|\\\^~\[\]`()<>]/g;

// Only complete URLs obtained from tmux's logical lines may bridge hard screen rows.
// Every displayed character is checked: adjacent terminal lines alone are not proof.
export function matchTerminalHistoryLinks(terminal, urls, activate) {
  if (!urls.length) return [];
  const buffer = terminal.buffer.active;
  const points = [];
  let screen = '';
  for (let row = 0; row < terminal.rows; row += 1) {
    const line = buffer.getLine(buffer.viewportY + row);
    if (!line) break;
    const text = line.translateToString(true);
    let offset = 0;
    for (let col = 0; col < terminal.cols && offset < text.length; col += 1) {
      const cell = line.getCell(col);
      if (!cell || cell.getWidth() === 0) continue;
      const chars = cell.getChars() || ' ';
      for (let i = 0; i < chars.length; i += 1) {
        points.push({ x: col + 1, y: buffer.viewportY + row + 1, width: cell.getWidth() });
      }
      offset += chars.length;
      screen += chars;
    }
    // Only a full screen row can be a lost automatic wrap. Do not bridge short
    // lines or blank paragraphs just because their concatenation resembles a URL.
    const last = line.getCell(terminal.cols - 1);
    const next = buffer.getLine(buffer.viewportY + row + 1);
    const earlyWideWrap = next?.getCell(0)?.getWidth() === 2
      && line.getCell(terminal.cols - 2)?.getChars();
    if (!last?.getChars() && last?.getWidth() !== 0 && !earlyWideWrap) {
      screen += '\n';
      points.push(null);
    }
  }
  const links = [];
  const known = new Set(urls);
  for (const match of screen.matchAll(HTTP_URL_PATTERN)) {
    const url = match[0];
    if (!known.has(url)) continue;
    const start = points[match.index], end = points[match.index + url.length - 1];
    if (!start || !end) continue;
    links.push({ text: url, range: { start: { x: start.x, y: start.y }, end: { x: end.x + end.width - 1, y: end.y } }, activate });
  }
  return links;
}
