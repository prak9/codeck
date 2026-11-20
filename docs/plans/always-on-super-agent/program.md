# Program: Codeck Always-On 个人 Super Agent 落地计划

> Single-file current-state plan for evolving Codeck into a personal always-on Super Agent supporting both 普通模式 (`index.html`) and Remote 模式 (`remote.html`).

- Overall status: `完成`
- Profile: `Lite`
- Contract status: `Confirmed`
- Active plan node: `None`
- Latest evidence: `/tmp/codeck-always-on-full-test.log`（1382/1382 通过）；`/tmp/codeck-always-on-browser-smoke.log`（普通/Remote × 390/1365 四象限通过）；`/tmp/codeck-always-on-snr-eval.log`（降噪率 0.833）
- Current blocker: `None`
- Next step: `None`
- Next checkpoint: `None`
- Next human decision: `None`
- Owner: `AI`
- Last updated: `2026-11-20`

## Outcome

- Problem: Codeck 已具备多执行器底座（Codex / Claude Code / QoderCLI / agy）、条件任务、进度便签、工作文件、发布页批注、历史检索与 Telegram 路由，但输入入口分散、缺少 Agent 自设跟进定时器、记忆停留在单会话级、审批仍同步阻塞终端且缺少统一的外发节流与全局待办视角，尚停留在“多 Agent 远程驾驶舱”，未形成低打扰、可恢复的“个人 Always-on Super Agent”。
- Success: 在不推翻现有 Codeck 多会话与终端工作流的前提下，落地 Always-on 五大原语（Event Inbox、Timers、Memory + Dreaming、Permissions/Deferred Approvals/Credential Proxy 框架、Outbox），上层采用无常驻固定总管的按需短命唤醒 Butler 编排模式，并在**普通模式**、**Remote 模式**与 **Telegram** 三端提供一致、克制的行动台、异步审批、记忆审计与主动汇报体验；全程可崩溃恢复、零重型外部中间件、既有 1300+ 测试与三 Provider 能力零回归。
- Collaboration intent: delivery；合同与范围已由用户确认，待用户下达实施指令后按节点推进，不未经授权修改生产服务或向真实用户会话发送消息。
- Non-goals: 不引入 Kafka/Redis/Temporal 等外部中间件；不推翻现有 tmux 终端与 Remote 对话主流程；不强行接管或自动终止用户已有真实会话；不自动扩大既有权限或编造未指定的任务预算；不把本轮模型回复结束当作目标完成；不覆盖历史归档计划 `../super-agent/program.md`（保留其已取消记录与教训）。

## Constraints

- Strategic defaults: 遵循 Codeck 既有工程原则——最小增量改动、失败测试先行、Node 22 内置 SQLite（与 `src/history-index.js` 同栈）、显式证据而非自报完成、不向已有会话静默注入指令。复用 `../session-services/program.md` 的按需路由与恢复经验，以及 `../session-progress/program.md` 的双端空间克制偏好。
- Tactical objective: 把“一直运行”转化为“零 Token 休眠 + 事件驱动短命唤醒 + 可审计持久化状态机”，最大化信噪比（Start quiet, earn attention），最小化对普通终端与手机聊天空间的干扰。
- Imperative bounds:
  - **双模式强制支持**：所有面向用户的能力（全局行动台、异步审批卡片、记忆/定时器查看与操作、通知徽标）必须同时支持普通模式（`public/index.html` + `public/app.js`）与 Remote 模式（`public/remote.html` + `public/remote.js`），并覆盖 390px 手机与 1365px 桌面双视口。
  - **布局克制**：Remote 模式不新增占用聊天区的常驻顶栏（沿用侧栏摘要 + 按需抽屉/弹窗）；普通模式不破坏终端输入共享队列、copy-mode 退出与快捷键。
  - **幂等与安全红线**：同一 scope 同时仅允许 1 个 Active Worker；未知投递不自动盲目重放；凭据不得出现在 prompt、日志、workfiles 或发布页中；所有新增接口均须 owner 鉴权，分享访客严格只读不可见。
  - **兼容与无损**：迁移 `src/conditional-tasks.js`、Telegram 入口与网页批注时保留现有配置与历史记录兼容；未授权前不修改生产配置或重启线上服务。
  - **已锁定架构决策（2026-11-20 用户确认）**：
    - 编排形态（原 U-001）：采用方案 A——**无常驻固定总控**；五大原语直接服务所有会话，Butler 总管仅作为按事件短暂唤醒的轻量编排 Run，不占固定 tmux，随时可开关。
    - Credential Proxy 范围（原 U-002）：**首批只建通用代理框架 + 1 个隔离样板服务验证**，不提前硬编码具体外部生产服务接入。
- Negotiable space: SQLite 表细节字段、内部模块文件拆分、Batch 合并时间窗口默认值、Morning Digest 模板样式与测试隔离 fixture 设计。
- Material assumptions:
  - agy 当前使用原生终端、不支持结构化 read/send，在 Super Agent 编排中默认作为人工/终端可见会话登记，不强行假定其支持结构化异步审批。
- Active unknowns:
  - **U-003（Deferred Tool Calls 与原生 CLI 边界）**：Codex / Claude Code / QoderCLI 各自原生审批 hook 与挂起恢复能力差异较大，哪些走原生挂起、哪些由 Codeck 外层策略门控（CLI/Proxy 层拦截）？解决方式：在 `NODE-005` 启动前对三套 backend 做只读能力核对探针。
- Escalate when: 任何阶段发现需要修改线上运行权限/systemd/Nginx 配置、放宽安全边界、引入外部依赖，或实测发现某 Provider 无法满足预期异步挂起语义时，立即暂停依赖节点并请用户拍板。

## Acceptance

| ID | Condition | Verification | Pass condition |
|---|---|---|---|
| A-001 | 统一 Event Inbox 实现多源入队、去重、单活串行、Batch 合并与崩溃恢复 | 隔离单元测试 + 进程中断/重启故障注入测试 | 重复 `dedupe_key` 不重复入队；同 `scope_key` 并发事件严格串行或合批；Worker 崩溃重启后不丢失未完成事件，且已进入提交阶段的未知投递不盲目重放 |
| A-002 | 统一 Timers 同时支持 `schedule`（保留低成本只读 `check` 预检）与 Agent 自设 `follow_up` | `codeck timer` CLI 测试 + 调度器时间推进隔离测试 | Timer 到点只向 Inbox 写事件不直接调模型；`check` 无变化时零模型唤醒；`follow_up` 触发一次后标 `done`，`schedule` 滚动到下一周期；兼容既有 `conditional-tasks` 配置 |
| A-003 | 个人统一 Memory（`~/.codeck/memory/`）具备瘦身基线、按需指针与离线 Dreaming | 记忆读写测试 + Dreaming 隔离运行测试 | 启动基线文件（`instructions.md` / `index.md` / `reported.md`）结构稳定且有体积上限守护；不复制 workfiles/pages 大正文而存指针；Dreaming 能归档已完成进度、去重过期笔记且不覆写用户锁定条目 |
| A-004 | Outbox 实现 4 级触达（`silent`/`digest`/`notify`/`urgent`）、防刷屏与晨报生成 | Outbox Dispatcher 单元测试 + 假 Telegram/Web 联调 | `silent` 不推送；`notify` 窗口合并且写入 `reported.md` 防重；`digest` 定时汇总生成摘要/发布页；`urgent` 即时推送；通知重试不触发模型重跑 |
| A-005 | Permissions 闭环支持异步挂起审批（不阻塞 Worker）与本机 Credential Proxy | Deferred Approval 状态机测试 + Proxy 隔离测试 | 高危调用落盘 `approvals` 表并结束当前 Run 释放 Worker；用户在任意端审批后写入回流事件恢复上下文；Proxy 正确注入凭据且 Agent 环境/日志/上下文零明文泄露 |
| A-006 | 普通模式（`index.html`）与 Remote 模式（`remote.html`）双端完整支持且零回归 | 双模式双视口（390px/1365px）Playwright 浏览器回归 + DOM/交互测试 | 两端均提供行动台（待我拍板/推进中/最新交付）、异步审批卡片、记忆与定时器抽屉；Remote 不增加常驻顶栏占高；普通模式终端输入队列、copy-mode、链接与快捷键零回归；零控制台报错 |
| A-007 | 按确认形态落地 Butler 编排并保持既有 Codeck 全量能力稳定 | `npm test` 全套回归 + 隔离多会话编排旅程测试 | 既有 1300+ 单元/集成测试与三套浏览器 smoke 全通过；不触碰真实用户会话；分享令牌严格隔离所有 Super Agent 数据 |

## Plan

| Node | Status | Action | Verification | Evidence | Reflection |
|---|---|---|---|---|---|
| NODE-001 | `完成` | 建设 SQLite 控制面底座（`events` / `timers` / `outbox` 表、Single-Active-Worker、Batch 与租约恢复），新增 `codeck timer followup/list/pause`，平滑接入既有 `conditional-tasks`、网页批注与 Telegram 入口 | 隔离状态机测试、故障注入重启测试与 CLI 测试 | `/tmp/codeck-always-on-node001.log`（5/5 通过；`src/server.js` 语法检查通过） | None |
| NODE-002 | `完成` | 建立 `~/.codeck/memory/` 个人分层记忆规范与 CLI（`instructions.md`、`index.md`、`reported.md`、`notes/`、`progress/`），联动 `workfiles`/`session-checkpoints`/`history-index` 实现只存指针与夜间 Dreaming 任务 | 记忆读写、体积守护、Dreaming 隔离测试与只读历史索引回归 | `/tmp/codeck-always-on-node002.log`（2/2 通过；`/api/always-on/memory*` 与 CLI 已接线） | None |
| NODE-003 | `完成` | 实现 Outbox 分级调度器（`silent`/`digest`/`notify`/`urgent`、合并防刷屏、晨报生成）及**普通模式 + Remote 模式**双端行动台与记忆/定时器按需抽屉（含侧栏徽标与审批入口占位） | Outbox 单元联调 + 双模式双视口（390/1365）浏览器 smoke | `/tmp/codeck-always-on-node004-005.log`；`/tmp/codeck-always-on-browser-smoke.log`（normal/remote × 390/1365 全通过，零页面错误） | R-001 |
| NODE-004 | `完成` | 落地无常驻固定总管的**按需短命唤醒 Butler 编排层**（可开关）：消费 Inbox 事件、读写个人 Memory、通过既有 `codeck` CLI 编排与验收下层 Codex/Claude/Qoder 会话，输出走 Outbox | 隔离多会话编排旅程测试（派发、跟进、汇报防重、失败不盲目重放、开关停用） | `/tmp/codeck-always-on-node004-005.log`（Butler 派发+自动 follow-up+去重静默+开关停用通过） | None |
| NODE-005 | `完成` | 落地无人值守权限闭环：三端（普通模式 / Remote / Telegram）Deferred Approval 挂起与回流恢复状态机 + 风险策略分级 + 本机 Credential Proxy 通用框架（含 1 个隔离样板服务） | 异步审批非阻塞测试、重启恢复测试、Proxy 凭据零泄露测试与双端交互 smoke | `/tmp/codeck-always-on-node004-005.log`；`/tmp/codeck-always-on-ui-routes.log`（3/3 通过，含 8 组非 owner 403 隔离验证） | None |
| NODE-006 | `完成` | 全链路回归与信噪比基线校准：跑通全套 `npm test`、三 Provider 双模式双视口浏览器验收、分享权限隔离审计，以及基于隔离回放日志的 Outbox 静默/触达 Eval 脚手架与文档更新 | `npm test` + 全部浏览器 smoke + 权限隔离审计 + Eval 脚本验证 | `/tmp/codeck-always-on-full-test.log`（1382/1382 通过）；`/tmp/codeck-always-on-snr-eval.log`（降噪率 0.833）；`/tmp/codeck-always-on-browser-smoke.log` | None |

## Reflection Log

Add `R-*` only when evidence changes an assumption, plan, verifier, scope, or reusable rule. For routine success with no trigger, use explicit `None` in the Plan row.

| ID | Scope | Evidence | Wrong / changed | Right / preserve | Next rule |
|---|---|---|---|---|---|
| R-001 | NODE-003 | `/tmp/codeck-always-on-full-test.log`、`/tmp/codeck-always-on-snr-eval.log` | 改动前端模块后未同步推高 `app.js?v=`/`remote.js?v=` 及缓存指纹导致 `asset-version.test.js` 和 `remote-style.test.js` 失败；Butler 入队 outbox 时未透传合成时钟 `deliverAfter` | 推高至 `app.js?v=171`（指纹 `5e8ba067e801896c`）与 `remote.js?v=160`；Butler 统一使用注入时钟 `now()` | 修改 `public/` 前端模块必须同步推高入口 `?v=` 并复跑全量测试；所有时间调度模块必须全程注入时钟 |

## 交付与边界

2026-11-20 完成全部 6 个节点的代码实施与隔离验证；**尚未 git 提交/推送，未重启生产 Codeck 服务，未向任何真实用户会话发送消息**。

- **新增模块**：`src/always-on-store.js`、`src/always-on-runtime.js`、`src/always-on-memory.js`、`src/always-on-outbox.js`、`src/always-on-butler.js`、`src/always-on-permissions.js`、`src/always-on-routes.js`、`public/always-on-panel.js`、`public/always-on-panel.css`。
- **新增脚本与测试**：`scripts/always-on-snr-eval.mjs`、`scripts/always-on-browser-smoke.mjs`、`test/always-on-control-plane.test.js`、`test/always-on-memory.test.js`、`test/always-on-outbox-butler-permissions.test.js`、`test/always-on-ui-and-routes.test.js`。
- **CLI 扩展**：`src/codeck-client.js` 新增 `codeck timer list/followup/pause/resume/remove` 与 `codeck memory list/read/write/dream`。
- **未覆盖边界**：Credential Proxy 按确认范围仅建通用框架与隔离样板测试，未接入具体生产外部服务凭据；生产服务与 Telegram 线上配置未改动，需用户确认后部署。
