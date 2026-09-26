import { AutonomyController } from '../src/autonomy.js';

export function fixture(provider = 'codex', file) {
  const target = { provider, threadId: 'thread', tmuxSession: 'work' };
  const f = { target, now: 1000, sent: [], stops: [], turns: [],
    session: { name: 'work', agent: { kind: provider, id: 'thread', paneId: '%1' } } };
  const options = { file, now: () => f.now, schedule: () => 1, cancel() {},
    readSession: async () => f.session,
    stop: async (_target, guard, scope) => { if (!guard()) return; f.stops.push(scope); f.session.hasRunningProcess = false;
      if (scope?.stopBackground !== false) f.session.agent.hasBackgroundProcess = false; },
    send: async (_target, text, guard) => { if (!guard()) return; f.sent.push(text);
      f.turns.push({ status: 'inProgress', items: [{ type: 'userMessage', content: text }] }); return { submissionStatus: 'attempted' }; },
  };
  f.manager = new AutonomyController(options);
  f.state = () => f.manager.snapshot(target);
  f.run = () => f.manager.runs.values().next().value;
  f.restart = () => { f.manager.close(); f.manager = new AutonomyController(options); };
  return f;
}
