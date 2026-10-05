// Offline fullscreen peer: own 300 history lines while tmux has no scrollback.
// Unexpected bytes are recorded as draft input so protocol leakage fails the test.
import fs from 'node:fs';
const receipt = process.argv[2];
let offset = 0, input = '', draft = '';
const draw = () => {
  const height = process.stdout.rows || 24;
  process.stdout.write('\x1b[2J\x1b[H' + [
    ...Array.from({ length: height - 5 }, (_, n) => `history ${300 - offset - (height - 6) + n}`),
    '', `› ${draft}`, '', '  GPT-6-Astra · ~/fixture', draft ? '  tab to queue message' : '  ? for shortcuts',
  ].join('\r\n'));
  fs.writeFileSync(receipt, JSON.stringify({ offset, draft }));
};
process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdout.write('\x1b[?1049h');
draw();
process.stdin.on('data', chunk => {
  input += chunk;
  while (input) {
    const wheel = /^\x1b\[<(64|65);2;2M/.exec(input);
    if (wheel) {
      offset = Math.max(0, Math.min(270, offset + (wheel[1] === '64' ? 3 : -3)));
      input = input.slice(wheel[0].length);
    } else if (input.startsWith('\x1b') && input.length < 12) return;
    else { draft += input[0]; input = input.slice(1); }
  }
  draw();
});
