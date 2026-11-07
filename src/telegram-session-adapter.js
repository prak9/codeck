import { sessionTarget } from './telegram-sessions.js';
import { sessionRpc } from './session-rpc.js';

export function createTelegramSessionAdapter({ connection, list, read, pendingRequests, create, rpc = sessionRpc }) {
  async function validate(target) {
    const current = sessionTarget(await list(), target.tmuxSession);
    if (current.provider !== target.provider || current.threadId !== target.threadId) throw new Error('会话身份已变化');
  }
  async function snapshot(target) {
    await validate(target);
    const value = await read(target);
    const interactions = [];
    const session = (await list()).find(s => s.name === target.tmuxSession);
    const q = session?.agent?.question;
    if (q) interactions.push({ kind: 'question', id: q.id, native: true,
      text: `${q.prompt || q.question || '请选择'}\n${(q.options || []).map(o => typeof o === 'string' ? o : o.label || o.text).join('\n')}\n直接回复此消息：/answer 选项文字` });
    for (const { provider, request } of pendingRequests()) {
      if (provider !== target.provider || request.params?.threadId !== target.threadId) continue;
      if (/requestApproval$|^(execCommandApproval|applyPatchApproval)$/.test(request.method)) {
        interactions.push({ kind: 'approval', id: request.id,
          text: `${request.params?.reason || request.params?.command || 'Agent 请求权限审批'}\n直接回复此消息：/approve 同意，/deny 拒绝。` });
      } else if (request.method === 'item/tool/requestUserInput') {
        const questions = request.params?.questions || [];
        interactions.push({ kind: 'question', id: request.id, native: false,
          questionId: questions.length === 1 ? questions[0].id : null,
          text: `${questions.map(q => `${q.question}\n${(q.options || []).map(o => o.label).join(' / ')}`).join('\n')}\n${questions.length === 1 ? '直接回复此消息：/answer 答案' : '多项问题请在网页回答。'}` });
      }
    }
    return { ...value, interactions };
  }
  return { list, read: snapshot,
    async create(task) {
      if (!create) throw new Error('当前服务不支持新建任务');
      if ((await list()).some(s => s.name === task.name)) throw Object.assign(new Error('会话名已存在，不会重复创建或覆盖'), { notStarted: true });
      return create(task);
    },
    async act(kind, target, args) {
      await validate(target);
      if (kind === 'send') return rpc(connection, { type: 'sendSessionMessage', ...target, text: args.text, commandId: args.commandId });
      if (kind === 'stop') return rpc(connection, { type: 'interruptSession', ...target, scope: 'foreground', commandId: args.commandId });
      const live = (await snapshot(target)).interactions.find(i => i.kind === (kind === 'approve' ? 'approval' : 'question') && String(i.id) === String(args.id));
      if (!live) throw new Error('询问已过期，不会回答另一个请求');
      if (kind === 'approve') return rpc(connection, { type: 'resolveApproval', ...target, requestId: live.id, decision: args.decision });
      if (kind !== 'answer') throw new Error('未知操作');
      if (live.native) return rpc(connection, { type: 'answerSessionQuestion', ...target, questionId: live.id, answer: args.answer }, { subscribe: true });
      if (!live.questionId) throw new Error('多项问题请在网页回答');
      return rpc(connection, { type: 'resolveInteraction', ...target, requestId: live.id, answers: { [live.questionId]: [args.answer] } });
    },
  };
}
