import { AutonomyController } from '../src/autonomy.js';
import { writeReceipt } from '../src/autonomy-receipt.js';

export const answers = (budget = '') => Object.fromEntries(Object.entries({ goal: '修复输入丢失', strategy: '先复现再最小修复',
  acceptance: '回归通过并保留证据', budget, constraints: '不部署' }).map(([key, value]) => [key, [value]]));

export function fixture(provider = 'codex', file) {
  const target = { provider, threadId: 'thread', tmuxSession: 'work' };
  const f = { target, now: 1000, sent: [], stops: [], turns: [],
    session: { name: 'work', agent: { kind: provider, id: 'thread', paneId: '%1' } } };
  const options = { file, now: () => f.now, schedule: () => 1, cancel() {},
    readSession: async () => f.session, readThread: async () => ({ thread: { id: 'thread', turns: f.turns } }),
    suggestDefinition: async () => ({ fieldsVersion: 5, goal: '模型提炼目标', strategy: '模型策略', acceptance: '模型验收', budget: '', constraints: '' }),
    stop: async (_target, guard, scope) => { if (!guard()) return; f.stops.push(scope); f.session.hasRunningProcess = false;
      if (scope?.stopBackground !== false) f.session.agent.hasBackgroundProcess = false; },
    send: async (_target, text, guard) => { if (!guard()) return; f.sent.push(text);
      f.turns.push({ status: 'inProgress', items: [{ type: 'userMessage', content: text }] }); return { submissionStatus: 'attempted' }; },
  };
  f.manager = new AutonomyController(options);
  f.state = () => f.manager.snapshot(target);
  f.run = () => f.manager.runs.values().next().value;
  f.approve = async (budget = '') => f.manager.respond(target, { requestId: f.state().requestId, answers: answers(budget) });
  f.start = async (budget = '') => { await f.manager.start(target); await f.approve(budget); await f.manager.tick(); };
  f.reply = (status = 'continue', extra = {}) => {
    const record = { summary: '本轮回归通过', next: '验证下一项边界', progress: true,
      baseline: '原有失败', version: 'abc123', verification: '回归通过', current: '边界待验证', ...extra };
    const args = ['--receipt', f.run().exchange.receiptFile, '--status', status];
    for (const [key, value] of Object.entries(record)) args.push(`--${key}`, String(value));
    if (status === 'complete' && !extra.evidence) args.push('--evidence', '测试日志');
    writeReceipt(args);
    const turn = f.turns.at(-1); turn.status = 'completed'; turn.items.push({ type: 'agentMessage', text: `${record.summary}。下一步：${record.next}` });
  };
  f.restart = () => { f.manager.close(); f.manager = new AutonomyController(options); };
  return f;
}
