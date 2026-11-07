# Program: 历史检索与成果证据

> Single-file current-state plan for direct, independently verifiable work.

- Overall status: `完成`
- Profile: `Lite`
- Contract status: `Confirmed`
- Active plan node: `None`
- Latest evidence: /tmp/codeck-history-full-serial.log，1290项通过；/tmp/codeck-history-browser.log；/tmp/codeck-history-boot.log。
- Current blocker: `None`
- Next step: `None`
- Next checkpoint: `None`
- Next human decision: `None`
- Owner: `AI`
- Last updated: `2026-11-07`

## Outcome

- Problem: 历史讨论难定位，成果版本与验证范围不统一。
- Success: 可检索三种 provider 本地历史，读取上下文并核验关联 Git 提交；发布页统一显示版本、证据和未验证事项。
- Collaboration intent: delivery；用户已确认推进。
- Non-goals: 不增加重型面板；不发送真实会话输入；不自动执行 Skill 对照实验；不自动提交部署。

## Constraints

- Strategic defaults: 用户 AGENTS，plan-skill、web-design；按主题查知识库。
- Tactical objective: 后台增量索引和只读检索，沿用 owner 授权、CLI 与页面入口。
- Imperative bounds: 分享访客不可搜索私有历史；不把提交存在等同结果已验证；不让旧证据附到新内容版本。
- Negotiable space: 索引格式、UI和测试细节。
- Material assumptions: None unless an inferred preference could change the plan.
- Active unknowns: None. Record only unknowns that can change execution, each with its cheapest resolution.
- Escalate when: A preference conflicts or evidence reveals a better option that requires changing a bound.

## Acceptance

| ID | Condition | Verification | Pass condition |
|---|---|---|---|
| A-001 | 搜索命中真实正文且可追溯，成果证据随版本绑定 | 隔离文件增量/重写/权限测试，CLI与手机桌面浏览器旅程 | 部分索引明确标识，无凭据跨权限泄漏，源文件不修改。 |

## Plan

| Node | Status | Action | Verification | Evidence | Reflection |
|---|---|---|---|---|---|
| NODE-001 | `完成` | 历史索引、API和来源上下文 | 索引行为测试 | /tmp/codeck-history-index.log；/tmp/codeck-history-boundaries.log；/tmp/codeck-history-scale.log | R-001 |
| NODE-002 | `完成` | 搜索入口与Git关联 | CLI/浏览器旅程 | /tmp/codeck-history-cli.log；/tmp/codeck-history-browser.log；/tmp/codeck-history-boot.log | None |
| NODE-003 | `完成` | 成果证据展示与完整验收 | API版本/权限及浏览器测试 | /tmp/codeck-history-evidence-unit.log；/tmp/codeck-history-pages.log；/tmp/codeck-history-full-serial.log | None |

## Reflection Log

Add `R-*` only when evidence changes an assumption, plan, verifier, scope, or reusable rule. For routine success with no trigger, use explicit `None` in the Plan row.

| ID | Scope | Evidence | Wrong / changed | Right / preserve | Next rule |
|---|---|---|---|---|---|
| R-001 | NODE-001 | history-index.test.js 文件重写场景 | SQLite内部rowid会重用，不能作为用户历史链接 | 用内容/来源标识查上下文 | 文件重建后旧结果必须失效或仍指同一内容 |

## Delivery — 2026-11-07

实现已完成，未提交、推送或部署。独立worker增量索引三种provider的本地JSONL；不借助完整SDK消息图，不向源会话写入；未变化文件不解析。Owner-only API与CLI支持查询/上下文/核验Git关联；两个界面共用轻量弹窗。原始历史可能包含旧分支，明确不视为当前事实。SQLite为本机Node22内置experimental API，无新依赖；16MiB单行上限跳过计数可见。

成果证据绑定内容摘要与来源版本，HTML/版本变化时不继承旧验证，分享不暴露内部记录。版本、方法、证据位置和未验证项由发布者如实提供，不自动赋予“已完成”。

1290项通过；390/1365搜索/证据/批注浏览器通过；普通终端与Remote既有旅程通过。实际HTTPS隔离服务证实owner访问、无登录401与分享403。合成318MB工具日志样本冷索引2726ms、查询0.52ms、热检查0.94ms、进程峰值RSS71.6MiB；未在生产历史全量验证，不把样本性能推广为生产承诺。

隔离浏览器、worker与服务已关闭，测试源文件/索引临时目录由fixture清理；保留日志和截图。知识沉淀 /data/code/knowleage/engineering/codeck-history-evidence.md，未提交。后续Skill对照实验不在本轮两项实现范围内。
