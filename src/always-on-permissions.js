import fs from 'node:fs/promises';
import path from 'node:path';

const DEFER_KINDS = new Set([
  'external_send',
  'page_share',
  'destructive_delete',
  'force_push',
  'prod_restart',
  'budget_override',
  'credential_write',
]);

const GUARD_KINDS = new Set([
  'code_edit',
  'worktree_create',
  'session_create',
  'credential_read',
]);

export function classifyActionRisk(action = {}) {
  const kind = String(action.kind || '').trim();
  if (DEFER_KINDS.has(kind)) return 'defer';
  if (GUARD_KINDS.has(kind)) return 'guard';
  return 'allow';
}

export function createApprovalGate({ store, runtime, now = Date.now }) {
  function requestApproval({
    scopeKey = 'butler',
    sessionName = null,
    provider = null,
    threadId = null,
    summary,
    action = {},
    risk = null,
  }) {
    const resolvedRisk = risk || (classifyActionRisk(action) === 'guard' ? 'guard' : 'defer');
    const approval = store.createApproval({
      scopeKey,
      sessionName,
      provider,
      threadId,
      summary,
      action,
      risk: resolvedRisk,
      now: now(),
    });

    store.enqueueOutbox({
      scopeKey,
      priority: 'urgent',
      channel: 'all',
      dedupeKey: `approval-card:${approval.id}`,
      title: `待确认审批：${summary}`,
      contentMd: `风险级别：${resolvedRisk}\n目标：${sessionName || scopeKey}\n操作：${JSON.stringify(action)}`,
      meta: { approvalId: approval.id, kind: 'approval_card', sessionName },
      now: now(),
    });

    return { deferred: true, approval };
  }

  async function resolveApproval(id, { decision, note = null }) {
    if (!['approved', 'rejected'].includes(decision)) {
      throw new Error('审批结论仅支持 approved 或 rejected');
    }
    const resolved = store.resolveApproval(id, { status: decision, decisionNote: note, now: now() });
    if (!resolved) return null;

    const enqueued = await runtime.enqueueAndWake({
      scopeKey: resolved.scopeKey,
      source: 'approval_resolved',
      dedupeKey: `approval-resolved:${resolved.id}`,
      payload: {
        approvalId: resolved.id,
        decision: resolved.status,
        note: resolved.decisionNote,
        summary: resolved.summary,
        action: resolved.action,
        sessionName: resolved.sessionName,
        provider: resolved.provider,
        threadId: resolved.threadId,
        reason: `审批已${resolved.status === 'approved' ? '批准' : '拒绝'}：${resolved.summary}${note ? `（备注：${note}）` : ''}`,
      },
    });

    return { approval: resolved, event: enqueued.event };
  }

  return { requestApproval, resolveApproval };
}

/**
 * Local Credential Proxy Framework (NODE-005).
 * Secrets remain in 0600 files inside secretsDir and are injected ONLY on the outbound HTTP call.
 * Agent contexts, env vars, and error messages never receive raw credentials.
 */
export function createCredentialProxy({ secretsDir, services = {}, fetchImpl = globalThis.fetch }) {
  const registry = new Map(Object.entries(services));

  function registerService(name, spec) {
    if (!/^[a-z0-9][a-z0-9_-]{0,47}$/.test(name)) throw new Error('无效的代理服务名');
    const base = new URL(spec.baseUrl);
    if (!['https:', 'http:'].includes(base.protocol)) throw new Error('代理目标必须为 HTTP(S)');
    registry.set(name, {
      baseUrl: base.origin,
      headerName: spec.headerName || 'Authorization',
      prefix: spec.prefix ?? 'Bearer ',
      secretFile: spec.secretFile,
      allowedPathPrefix: spec.allowedPathPrefix || '/',
      allowedMethods: new Set((spec.allowedMethods || ['GET', 'POST']).map(m => m.toUpperCase())),
    });
  }

  function listServices() {
    return [...registry.entries()].map(([name, spec]) => ({
      name,
      baseUrl: spec.baseUrl,
      headerName: spec.headerName,
      allowedPathPrefix: spec.allowedPathPrefix,
      allowedMethods: [...spec.allowedMethods],
    }));
  }

  async function loadSecret(secretFile) {
    const resolved = path.resolve(secretsDir, secretFile);
    const root = path.resolve(secretsDir);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
      throw new Error('凭据路径越界');
    }
    const stat = await fs.stat(resolved);
    if (!stat.isFile() || (stat.mode & 0o077)) {
      throw new Error('凭据文件权限必须为 0600 或 0400');
    }
    const raw = (await fs.readFile(resolved, 'utf8')).trim();
    if (!raw) throw new Error('凭据文件为空');
    return raw;
  }

  async function forward({ service, method = 'GET', requestPath = '/', headers = {}, body = undefined }) {
    const spec = registry.get(service);
    if (!spec) throw new Error('未知的凭据代理服务');
    const upperMethod = String(method).toUpperCase();
    if (!spec.allowedMethods.has(upperMethod)) throw new Error(`服务 ${service} 不允许方法 ${upperMethod}`);

    const cleanPath = String(requestPath || '/');
    if (!cleanPath.startsWith('/') || cleanPath.startsWith('//') || cleanPath.includes('..')) {
      throw new Error('非法的代理请求路径');
    }
    if (!cleanPath.startsWith(spec.allowedPathPrefix)) {
      throw new Error('请求路径不在允许前缀范围内');
    }

    const secret = await loadSecret(spec.secretFile);
    const targetUrl = new URL(cleanPath, spec.baseUrl).href;

    // Strip any caller-supplied auth headers to prevent spoofing/leakage.
    const outboundHeaders = {};
    for (const [k, v] of Object.entries(headers || {})) {
      const lower = k.toLowerCase();
      if (lower === 'authorization' || lower === spec.headerName.toLowerCase() || lower === 'cookie') continue;
      outboundHeaders[k] = v;
    }
    outboundHeaders[spec.headerName] = `${spec.prefix}${secret}`;

    try {
      const res = await fetchImpl(targetUrl, {
        method: upperMethod,
        headers: outboundHeaders,
        ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      return {
        ok: res.ok,
        status: res.status,
        body: text,
      };
    } catch (error) {
      // Never leak secret in error messages.
      const safeMsg = String(error?.message || '代理转发失败').replaceAll(secret, '[REDACTED]');
      throw new Error(safeMsg);
    }
  }

  return {
    registerService,
    listServices,
    forward,
  };
}
