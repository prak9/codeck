// Isolated terminal simulator, not a real Agent. Model a delayed paste handler
// and Qoder's folded composer while recording every submitted byte for the test.
import fs from 'node:fs';
const receipt = process.argv[2];
let input = '', draft = '', paste = false, ready = false;
const draw = () => process.stdout.write('\x1b[2J\x1b[H' + [
  '─'.repeat(37), ' Shift+Tab to Auto Mode', '─'.repeat(37),
  ` > ${ready ? `[Pasted Text: ${draft.split('\n').length} lines]` : ''}`,
  '─'.repeat(37), ' Ultimate Model', '',
].join('\r\n'));
process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdout.write('\x1b[?2004h');
draw();
process.stdin.on('data', chunk => {
  input += chunk.toString();
  while (input) {
    if (input.startsWith('\x1b[200~')) { paste = true; input = input.slice(6); }
    if (paste) {
      const end = input.indexOf('\x1b[201~');
      if (end < 0) return;
      draft = input.slice(0, end).replace(/\r\n?/gu, '\n'); input = input.slice(end + 6); paste = false;
      setTimeout(() => { ready = true; draw(); }, 650);
    } else if (input.startsWith('\r')) {
      fs.writeFileSync(receipt, JSON.stringify({ ready, text: draft }));
      input = input.slice(1); ready = false; draft = ''; draw();
    } else if (input.startsWith('\x1b')) return;
    else {
      fs.appendFileSync(`${receipt}.raw`, input[0]);
      input = input.slice(1);
    }
  }
});
