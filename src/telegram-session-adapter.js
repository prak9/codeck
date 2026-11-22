import { sessionTarget } from './telegram-sessions.js';
import { sessionRpc } from './session-rpc.js';

export function createTelegramSessionAdapter({ connection, list, read, pendingRequests, create, rpc = sessionRpc }) {
  async function validate(target) {
    const sessions = await list();
    const current = sessionTarget(sessions, target.tmuxSession);
    if (current.provider !== target.provider || current.threadId !== target.threadId ||
      (target.createdAt != null && sessions.find(s => s.name === target.tmuxSession)?.createdAt !== target.createdAt)) throw new Error('会话身份已变化');
  }
  function interactionsFor(session, requests) {
    const target = { session: session.name, createdAt: session.createdAt, provider: session.agent.kind, threadId: session.agent.id };
    const interactions = [];

    const q = session?.agent?.question;
    if (q) {
      const label = q.prompt || q.question || '请选择';
      const options = (q.options || []).map(o => typeof o === 'string' ? o : o.label || o.text);
      interactions.push({ kind: 'question', id: q.id, native: true, label, options,
        text: `${label}\n${options.join('\n')}\n直接回复此消息：/answer 选项文字` });
    }
    for (const { provider, request } of requests) {
      if (provider !== target.provider || request.params?.threadId !== target.threadId) continue;
      if (/requestApproval$|^(execCommandApproval|applyPatchApproval)$/.test(request.method)) {
        interactions.push({ kind: 'approval', id: request.id, label: request.params?.reason || request.params?.command || 'Agent 请求权限审批',
          text: `${request.params?.reason || request.params?.command || 'Agent 请求权限审批'}\n直接回复此消息：/approve 同意，/deny 拒绝。` });
      } else if (request.method === 'item/tool/requestUserInput') {
        const questions = request.params?.questions || [];
        interactions.push({ kind: 'question', id: request.id, native: false, label: questions.map(q => q.question).join('\n'),
          options: questions.length === 1 ? (questions[0].options || []).map(o => o.label) : [],
          questionId: questions.length === 1 ? questions[0].id : null,
          text: `${questions.map(q => `${q.question}\n${(q.options || []).map(o => o.label).join(' / ')}`).join('\n')}\n${questions.length === 1 ? '直接回复此消息：/answer 答案' : '多项问题请在网页回答。'}` });
      }
    }
    return interactions.map(item => ({ ...item, target, actionable: item.kind === 'approval' || Boolean(item.native || item.questionId),
      key: JSON.stringify([target.session, target.createdAt, target.provider, target.threadId, item.kind, Boolean(item.native), item.id]),
    }));
  }
  async function snapshot(target) {
    await validate(target);
    const value = await read(target);
    const session = (await list()).find(s => s.name === target.tmuxSession && s.agent?.kind === target.provider && s.agent?.id === target.threadId);
    return { ...value, interactions: session ? interactionsFor(session, pendingRequests()) : [] };
  }
  return { list, read: snapshot,
    async pending() {
      const requests = pendingRequests();
      return (await list()).filter(s => ['codex', 'qodercli', 'claude'].includes(s.agent?.kind) && s.agent.id)
        .flatMap(s => interactionsFor(s, requests));
    },
    async create(task) {
      if (!create) throw new Error('当前服务不支持新建任务');
      if ((await list()).some(s => s.name === task.name)) throw Object.assign(new Error('会话名已存在，不会重复创建或覆盖'), { notStarted: true });
      return create(task);
    },
    async act(kind, target, args) {
      await validate(target);
      if (kind === 'send') return rpc(connection, { type: 'sendSessionMessage', ...target, text: args.text, commandId: args.commandId });
      if (kind === 'stop') return rpc(connection, { type: 'interruptSession', ...target, scope: 'foreground', commandId: args.commandId });
      const session = (await list()).find(s => s.name === target.tmuxSession && s.agent?.kind === target.provider && s.agent.id === target.threadId);
      const live = session && interactionsFor(session, pendingRequests()).find(i => i.kind === (kind === 'approve' ? 'approval' : 'question')
        && String(i.id) === String(args.id) && (args.key == null || i.key === args.key));
      if (!live) throw new Error('询问已过期，不会回答另一个请求');
      if (kind === 'approve') return rpc(connection, { type: 'resolveApproval', ...target, requestId: live.id, decision: args.decision });
      if (kind !== 'answer') throw new Error('未知操作');
      if (live.native) return rpc(connection, { type: 'answerSessionQuestion', ...target, questionId: live.id, answer: args.answer }, { subscribe: true });
      if (!live.questionId) throw new Error('多项问题请在网页回答');
      return rpc(connection, { type: 'resolveInteraction', ...target, requestId: live.id, answers: { [live.questionId]: [args.answer] } });
    },
  };
}
