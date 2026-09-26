import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { query as queryClaude, resolveSettings as claudeSettings } from '@anthropic-ai/claude-agent-sdk';
import { query as queryQoder, qodercliAuth, resolveSettings as qoderSettings } from '@qoder-ai/qoder-agent-sdk';
import { CodexAppServer } from './codex-app-server.js';

const instructions = '只根据所给对话规划一段简短的自主迭代任务描述，不执行任务，不读取文件，不调用工具。只返回自然语言描述，不输出 JSON。';

function modelFailure(message) {
  const error = new Error('模型提取未完成');
  if (/auth|login|登录|认证/iu.test(message || '')) error.code = 'MODEL_AUTH_REQUIRED';
  return error;
}

export async function codexDefinition({ prompt, cwd, signal }, server = new CodexAppServer()) {
  let threadId, output = '', resolveResult, rejectResult;
  const done = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  done.catch(() => {});
  const abort = () => { rejectResult(signal.reason); server.close(); };
  const notification = ({ method, params }) => {
    if (!threadId || params?.threadId !== threadId) return;
    if (method === 'item/completed' && params.item?.type === 'agentMessage') output = params.item.text || '';
    if (method === 'turn/completed') {
      if (params.turn?.status !== 'completed') rejectResult(modelFailure(params.turn?.error?.message));
      else resolveResult(output);
    }
  };
  server.on('notification', notification);
  server.on('exit', rejectResult);
  server.on('serverRequest', request => {
    server.respondError(request.id, -32601, 'Task definition extraction does not allow tools').catch(rejectResult);
  });
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    const { thread } = await server.request('thread/start', {
      cwd, ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only', environments: [],
      baseInstructions: instructions, developerInstructions: instructions,
      config: { 'features.shell_tool': false, 'features.multi_agent': false, 'features.apps': false,
        'features.goals': false, 'web_search': 'disabled', 'mcp_servers': {} },
    }, { signal });
    threadId = thread.id;
    await server.request('turn/start', { threadId, input: [{ type: 'text', text: prompt }], effort: 'low' }, { signal });
    return await done;
  } finally {
    signal.removeEventListener('abort', abort); server.close();
  }
}

export async function sdkDefinition({ provider, prompt, cwd, signal }, query = provider === 'claude' ? queryClaude : queryQoder,
  resolveSettings = provider === 'claude' ? claudeSettings : qoderSettings) {
  const abortController = new AbortController();
  const abort = () => abortController.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  let stream;
  try {
    signal.throwIfAborted();
    // Preserve the user's model/auth endpoint, not project hooks or permissions.
    const { effective } = await resolveSettings({ cwd, settingSources: ['user'] });
    const settings = Object.fromEntries(['model', 'env', 'apiKeyHelper'].filter(key => effective[key] != null).map(key => [key, effective[key]]));
    signal.throwIfAborted();
    stream = query({ prompt, options: { cwd, abortController, persistSession: false, maxTurns: 1,
      systemPrompt: instructions, tools: [], allowedTools: [], mcpServers: {}, strictMcpConfig: true,
      settings, settingSources: [], plugins: [], canUseTool: async () => ({ behavior: 'deny', message: '仅提取任务定义' }),
      ...(provider === 'qodercli' ? { auth: qodercliAuth(), skills: [], extensions: [] } : {}),
    } });
    let output = '';
    for await (const message of stream) {
      signal.throwIfAborted();
      if (message.type === 'assistant') output = (message.message?.content || []).filter(part => part.type === 'text').map(part => part.text).join('\n');
      if (message.type === 'result') {
        if (message.is_error || message.subtype !== 'success') throw modelFailure([message.result, ...(message.errors || [])].join('\n'));
        return message.result || output;
      }
    }
    throw new Error('模型未返回提取结果');
  } finally {
    signal.removeEventListener('abort', abort); abortController.abort(); stream?.close?.();
  }
}

export async function generateDefinitionText({ provider, prompt, signal }) {
  if (!['codex', 'claude', 'qodercli'].includes(provider)) throw new Error('不支持的目标提取模型');
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'codeck-definition-'));
  const timeout = AbortSignal.timeout(45_000);
  const bounded = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    return await (provider === 'codex' ? codexDefinition : sdkDefinition)({ provider, prompt, cwd, signal: bounded });
  } finally { await fs.rm(cwd, { recursive: true, force: true }); }
}
