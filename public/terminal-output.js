const SHARED_CODEX_BACKGROUND_FOOTER = / · \d+ background terminals? running · \/ps to view · \/stop to close/g;

// A remote-control app-server reports unified-exec terminals across its threads. The
// TUI footer therefore can show another tmux session's count. Codeck's sidebar uses the
// process-owned thread id instead; blank only this misleading footer fragment while
// preserving its terminal width so subsequent cursor movement stays aligned.
export function hideSharedCodexBackgroundFooter(output) {
  if (typeof output !== 'string') return output;
  return output.replace(SHARED_CODEX_BACKGROUND_FOOTER, (match) => ' '.repeat(match.length));
}
