const invalid = () => Object.assign(new Error('成果证据格式无效：需要版本、总结、验证记录和未验证事项'), { status: 400 });
export function normalizeEvidence(value, contentHash) {
  if (value === null) return undefined;
  const string = (v, max) => typeof v === 'string' && v.length <= max;
  if (!value || !string(value.version, 256) || !value.version.trim() || !string(value.summary, 4000)
    || !Array.isArray(value.checks) || value.checks.length > 50 || !Array.isArray(value.limitations) || value.limitations.length > 50
    || value.limitations.some(v => !string(v, 2000))) throw invalid();
  const checks = value.checks.map(check => {
    if (!check || !string(check.method, 2000) || !check.method.trim() || !['passed', 'failed', 'not-run'].includes(check.result)
      || !string(check.reference || '', 2000)) throw invalid();
    return { method: check.method, result: check.result, reference: check.reference || '' };
  });
  return { version: value.version.trim(), summary: value.summary, checks, limitations: value.limitations,
    contentHash, recordedAt: new Date().toISOString() };
}
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
export function evidencePanel(page) {
  const evidence = page.evidence;
  const body = evidence ? `<p>${escape(evidence.summary)}</p><p>版本：<code>${escape(evidence.version)}</code> · ${escape(evidence.recordedAt)}</p><ul>${evidence.checks.map(check => `<li><b>${{ passed: '通过', failed: '失败', 'not-run': '未执行' }[check.result]}</b> · ${escape(check.method)}${check.reference ? `<small>${escape(check.reference)}</small>` : ''}</li>`).join('')}</ul><h3>未验证事项与限制</h3>${evidence.limitations.length ? `<ul>${evidence.limitations.map(v => `<li>${escape(v)}</li>`).join('')}</ul>` : '<p>提交者未列出限制；不代表已覆盖全部场景。</p>'}<small>验证记录由提交者提供，页面服务不代替实际验收。内容标识：${escape(evidence.contentHash)}</small>`
    : '<p>此版本尚未附验证记录。</p>';
  return `<details class="page-evidence"><summary>版本与验证${evidence ? '' : ' · 未附记录'}</summary><section>${body}</section></details><style>.page-evidence{padding:10px 20px;border-bottom:1px solid #38383c;font-size:13px;flex-shrink:0}.page-evidence summary{cursor:pointer}.page-evidence section{max-height:40vh;overflow:auto;line-height:1.6;overflow-wrap:anywhere}.page-evidence li{padding:8px 0}.page-evidence h3{font-size:14px}.page-evidence code{white-space:pre-wrap}</style>`;
}
