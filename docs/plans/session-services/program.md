# Program: Codeck 内置会话后台服务

> Single-file current-state plan for direct, independently verifiable work.

- Overall status: `完成`
- Profile: `Lite`
- Contract status: `Confirmed`
- Active plan node: `None`
- Latest evidence: `/tmp/codeck-natural-full.log`：1264 项通过；真实只读模型路由与隔离 tmux 验证通过；生产健康检查与 Telegram connected。
- Current blocker: `None`
- Next step: `None`
- Next checkpoint: `None`
- Next human decision: `None`
- Owner: `AI`
- Last updated: `2026-11-06`

## Outcome

- Problem: 用户取消总控 Agent，需要轻量内置服务。
- Success: 无常驻总控；复用连接恢复和投递回执，Telegram 用自然语言选择、回复、订阅现有 session，或按用户目标创建执行 session 启动任务。
- Collaboration intent: delivery；用户已明确确认实施与更新服务。
- Non-goals: 不创建常驻总控 Agent，不无授权续跑、重发未知任务或批准审批；不提交推送。用户现已授权自然语言请求创建执行 session。

## Constraints

- Strategic defaults: 用户 AGENTS.md；最小改动，失败测试先行，复用 AgentHub。
- Tactical objective: 简洁，无额外大屏；服务随 Codeck 启停。
- Imperative bounds: owner 私聊；路由绑定 provider/thread/session；旧总控记录不重放；未指定预算。
- Negotiable space: 命令和模块划分；通知默认只发用户选择或订阅的会话。
- Material assumptions: None unless an inferred preference could change the plan.
- Active unknowns: None. Record only unknowns that can change execution, each with its cheapest resolution.
- Escalate when: A preference conflicts or evidence reveals a better option that requires changing a bound.

## Acceptance

| ID | Condition | Verification | Pass condition |
|---|---|---|---|
| A-001 | 无独立总控入口或常驻总控模型 | 静态检查、浏览器 smoke | 只保留执行 session；自然语言理解采用按需临时只读调用 |
| A-002 | Telegram 正确直接路由 | 隔离命令旅程 | 选择、回复、身份变化、陌生用户和重复消息正确处理 |
| A-003 | 通知与回执可靠 | 故障注入、重启 | 不重跑任务，不把本轮结束当目标完成，旧记录不执行 |
| A-004 | 已有体验与部署正常 | npm test、浏览器、服务检查 | 回归通过，tmux 与 Info Hub 保留 |
| A-005 | 自然语言理解与新任务创建 | 模型只读路由实测、隔离任务旅程 | 歧义追问，不凭空扩大目标；多个目标正确拆分；创建/发送各阶段持久化，不重复建会话或重发 |

## Plan

| Node | Status | Action | Verification | Evidence | Reflection |
|---|---|---|---|---|---|
| NODE-001 | `完成` | 移除总控，实现 Telegram session 路由与通知 | 隔离旅程和故障注入 | `test/telegram-sessions.test.js`、`test/telegram-session-adapter.test.js`、`test/session-rpc.test.js`；全套通过 | None |
| NODE-002 | `完成` | 回归、文档和部署 | 全套测试、浏览器、健康检查 | `/tmp/codeck-session-services-full.log`：1254 通过；`/tmp/codeck-services-browser.log`、`/tmp/codeck-services-remote-browser-smoke.log`、`/tmp/codeck-services-terminal-theme-browser-smoke.log` 通过；生产 health ok / Telegram connected / 17 个 session | R-001 |
| NODE-003 | `完成` | 按需模型理解与澄清，复用 session 路由 | 隔离路由及只读模型验证 | `/tmp/codeck-route-live.log`、`/tmp/codeck-route-context-live.log`；多目标、歧义、新任务约束、澄清后保留目标通过 | R-002 |
| NODE-004 | `完成` | 创建执行 session、启动任务及失败恢复 | 创建与发送跨阶段故障注入 | `/tmp/codeck-natural-isolated.log`；隔离 tmux/假 CLI 收到一次完整初始 prompt，无 shell 展开；未知创建不重放 | None |
| NODE-005 | `完成` | 文档、回归、部署 | 全套测试与健康检查 | `/tmp/codeck-natural-full.log`：1264 项通过；认证 health ok，Telegram connected，原17个session保留，Info Hub active | None |

## Reflection Log

Add `R-*` only when evidence changes an assumption, plan, verifier, scope, or reusable rule. For routine success with no trigger, use explicit `None` in the Plan row.

| ID | Scope | Evidence | Wrong / changed | Right / preserve | Next rule |
|---|---|---|---|---|---|
| R-001 | NODE-002 | `/tmp/codeck-services-terminal-browser.log` | 旧 A 浏览器脚本仍断言已取消的 planning 状态，不能作为当前设置服务验收 | 独立 `scripts/services-browser-smoke.mjs` 验证真实页面开关与手机/桌面布局，原 Remote/主题测试保持通过 | 不把过时脚本的失败掩盖为通过；用对应当前产品行为的独立验收 |
| R-002 | NODE-003 | 澄清回复测试与 `/tmp/codeck-route-context-live.log` | 无目标的 Bot 消息也需保存回复映射，否则用户直接回复澄清时无法继续；“仅会话名”规则不能覆盖原目标 | 保留原请求、问题与回答；区分单纯选择与回答待澄清任务 | 对话连续性属于路由正确性，必须覆盖真实模型和持久化消息两层 |

## Delivery — 2026-11-06

完成并重启部署工作区版本；未提交推送。原总控入口、模型创建、权限覆盖和专用工具代码移除；旧历史与 Telegram state.json 保留。新 sessions.json 只迁移确认过的输入偏移，不迁移旧待执行任务或通知。生产初始 selected=null、watches=0、inbox=0、outbox=0，无测试任务注入。认证 GET /api/health 返回 ok；/api/services 为 connection/delivery enabled、telegram connected；Info Hub 仍 active，17 个会话仍可读取。

现有连接维护和投递回执复用原实现，没有重新编排 Agent。仅订阅被选择/关注的会话；本轮结束不代表目标完成。Telegram 长通知可能因 ACK 丢失重复，操作不会因此重发；旧通知路由超过保留窗口会拒绝，不回落到当前会话。多问题原生询问仍需网页处理。UI 证据：`/data/tmp/codeck-services-browser-kQAeHS`。测试临时存档由测试清理，浏览器和隔离服务器已关闭；保留验证日志与截图。未指定预算，不编造使用额度。

## Natural-language delivery — 2026-11-06

用户追加授权自然语言操作和自动创建执行 session，现已实现并重启部署，未提交推送。每条普通消息按需使用 ephemeral、read-only 的 Codex 路由调用；完成/失败即关闭进程，不保留总控会话。结构化方案只用于内部校验和操作日志；选择、查询、发送、停止、订阅、新建分别执行。原生交互只在回复匹配通知时将“确认/拒绝/答案”映射到该请求，普通消息不会误批准。

新任务以稳定会话名一次 tmux 创建传入完整 CLI prompt，默认 Codex，沿用启动配置；显式项目路径与用户约束保留。不自动重试未知创建或发送；Agent 长时间未就绪会通知但不重复启动。以 pane/provider 校验首个 thread，之后采用现有 thread 身份保护。

证据包括真实模型多路由、歧义、预算/只读限制和澄清上下文验证；隔离 tmux 与假 CLI 验证多行/引号/命令替换不被 shell 展开且只接收一次 prompt，测试服务器已清理。未向真实用户 session 注入验收任务，也未启动真实研究/开发任务；生产检查仍为17个session。当前用户界面未修改，沿用上一轮三套浏览器通过证据。语义路由依赖模型，疑义或解析失败不执行，不能宣称所有自然语言均可无误理解。实际用户任务可正常使用并反馈。
