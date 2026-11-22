// Run the session journeys against local fixture servers only.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const flows = {
  remote: ['scripts/remote-browser-smoke.mjs', '--session-switch'],
  terminal: ['scripts/terminal-stream-browser-smoke.mjs', '--idle-input'],
  backend: ['--test', 'test/agents.test.js', 'test/codex-delivery-recovery.test.js'],
};
const args = process.argv.slice(2);
const usage = 'node scripts/verify-session.mjs [all|remote|terminal|backend] [--json] [--dry-run]\n' +
  '默认执行 all。在临时目录保存截图，使用隔离 HTTP/WebSocket 服务。\n' +
  '先准备 Playwright 及其 Chromium；可用 CODECK_PLAYWRIGHT_MODULE 和 CODECK_BROWSER_EXECUTABLE 指定已有安装。';
if (args.includes('--help')) { console.log(usage); process.exit(0); }
const names = args.filter(arg => !arg.startsWith('--'));
const choice = names[0] || 'all';
if (names.length > 1 || !['all', ...Object.keys(flows)].includes(choice)
  || args.some(arg => arg.startsWith('--') && !['--json', '--dry-run'].includes(arg))) {
  console.error(usage); process.exit(2);
}

const results = [];
for (const [flow, command] of Object.entries(flows)) {
  if (choice !== 'all' && choice !== flow) continue;
  if (args.includes('--dry-run')) { results.push({ flow, command, status: 'planned' }); continue; }
  const run = spawnSync(process.execPath, command, { cwd: root, encoding: 'utf8', timeout: 180_000 });
  if (run.stdout) process.stderr.write(run.stdout);
  if (run.stderr) process.stderr.write(run.stderr);
  const ok = run.status === 0;
  results.push({ flow, command, status: ok ? 'passed' : 'failed',
    artifacts: run.stdout?.match(/^(?:Browser artifacts|Artifacts): (.+)$/m)?.[1] || null });
  if (!ok) {
    console.error(run.error?.message || '验证未通过', '请查看上方首个错误。单独重跑：node scripts/verify-session.mjs ' + flow);
    process.exitCode = 1;
  }
}
const version = spawnSync('git', ['describe', '--always', '--dirty'], { cwd: root, encoding: 'utf8' }).stdout?.trim() || null;
if (args.includes('--json')) console.log(JSON.stringify({ version, results }));
else for (const row of results) console.log(row.flow, row.status, row.artifacts || row.command.join(' '));
