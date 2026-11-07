# Program: Codeck 总控与 Telegram 入口

> 历史方案，已于 2026-11-06 按用户要求取消总控 Agent。当前方案见 ../session-services/program.md；以下保留历史证据，不作为执行依据。

- Overall status: `已取消`
- Profile: `Lite`
- Contract status: `Confirmed`
- Active plan node: `None`
- Latest evidence: `/tmp/codeck-control-full-test.log`（1258/1258 通过）；两套浏览器测试通过，见下表。
- Current blocker: None；总控方案已取消。
- Next step: 转至 ../session-services/program.md
- Next checkpoint: 内置 session 服务验收
- Next human decision: 无；实际任务须沿用用户具体目标，不将绑定消息当作任务。
- Owner: `AI`
- Last updated: `2026-11-04`

## Outcome

- Problem: 网页总控原型已具备基本入口，但首次创建异常会形成恢复死端，Telegram 尚未接入。
- Success: 保持简洁界面，完善总控可恢复发送，并提供与网页共用总控会话的 Telegram 私聊入口；身份校验、消息去重、结果通知及停止有隔离证据。
- Collaboration intent: delivery。用户已授权按当前目标自主推进，无需阶段性重复确认。
- Non-goals: 不引入流程编辑器、人员面板、多租户系统；不操作用户已有真实会话；本阶段不自行提交、推送或重启生产服务。

## Constraints

- Strategic defaults: 用户 AGENTS.md：先读代码、最小改动、失败测试先行、证据驱动；复用现有 AgentHub、Provider 和审批机制。
- Tactical objective: 减少切换与转述，不以复杂状态阻碍输入；失败时明确真实边界，不盲目重放。
- Imperative bounds: 凭据只在私有文件中；Telegram 仅接受指定用户私聊；消息投递不确定不得自动重复执行；未指定预算，不设默认值。
- Negotiable space: 内部模块划分、持久化格式、隔离 fixture 和错误恢复策略。
- Material assumptions: 网页使用现有 Codex 总控与多 Provider 执行会话；Telegram 为同一总控的入口。
- Active unknowns: Bot 配置与 owner ID（用户提供）；首次创建/回复丢失后的真实边界（隔离故障注入）；Telegram 不确定消息发送不具备 exactly-once 保证（文档与 outbox 测试）。
- Escalate when: 外部凭据缺失阻碍实机接入，或需要改变既有权限和生产运行方式。

## Acceptance

| ID | Condition | Verification | Pass condition |
|---|---|---|---|
| A-001 | 首次创建失败可恢复且已发送请求不重复 | 控制层故障注入测试 | 创建前失败可重试；提交结果丢失可核对原 thread；不创建第二个执行任务 |
| A-002 | Telegram 与网页共用对话且隔离陌生用户 | fake Telegram 与实际控制层联合测试 | owner 私聊入队；其他用户/群聊无动作；重复 update 不重复发任务 |
| A-003 | 断网/重启只恢复未完成阶段 | 持久化 inbox/outbox 恢复测试 | 已接收消息不丢，重发通知不重跑模型；不确定投递如实显示 |
| A-004 | 保持原有网页体验 | npm test 与两个浏览器 smoke | 全部相关测试通过；桌面/手机、快捷按钮、会话切换和重连不回归 |
| A-005 | 实际 Telegram 可用 | 专用 Bot 的 owner 消息往返 | 用户配置到位后验证；缺配置保持未启用并明确交接 |

## Plan

| Node | Status | Action | Verification | Evidence | Reflection |
|---|---|---|---|---|---|
| NODE-001 | `完成` | 修复总控首次发送恢复边界 | 故障注入与重启测试 | `/tmp/codeck-control-recovery.log`：47 项通过；全套回归复验通过 | R-001 |
| NODE-002 | `完成` | Telegram 入口、身份验证、消息与结果投递 | 隔离联合测试 | `test/telegram-control.test.js`、`test/telegram-runtime.test.js` 全套回归通过，含实际 control-room 共用与重启 | R-002 |
| NODE-003 | `完成` | 全套回归与文档更新 | npm test + browser smoke | `/tmp/codeck-control-full-test.log`：1258 项通过；`/tmp/codeck-control-room-browser-smoke.log`、`/tmp/codeck-remote-browser-smoke.log`：通过、零浏览器错误；配置见 `docs/telegram.md` | None |
| NODE-004 | `已取消` | Telegram 总控模型联调 | 用户取消总控方案 | 转为 session 直接路由；旧总控历史保留 | None |

## Reflection Log

仅记录改变实现或验收判断的证据。

| ID | Scope | Evidence | Wrong / changed | Right / preserve | Next rule |
|---|---|---|---|---|---|
| R-001 | NODE-001 | `test/control-room.test.js`、`test/agent-backends.test.js` | 统一 pending 阻断使创建前失败也不可恢复；改为 creating / sending 边界 | 真实提交前先保存 thread ID，未知消息不重放 | 以是否进入提交阶段判断可重试性，不凭空 composer 或 UI 状态 |
| R-002 | NODE-002 | Telegram 故障注入测试与官方 Bot API | 通知重试无法保证恰好一次；持久化错误不能退回全新状态 | 收件持久化先于 offset 确认，未知任务不重发，通知单独重试 | 明确区别任务执行去重与通知可能重复；身份不一致停止入口 |

## Delivery checkpoint — 2026-11-04

代码与隔离验证完成；未提交、推送或重启生产服务。A-001 至 A-004 已验证；A-005 缺专用 Bot 配置与 owner ID，尚未连接真实 Telegram，不能报告完整上线。测试没有操作真实执行会话。浏览器证据保留在 `/data/tmp/codeck-control-browser-LEsh4R`，测试临时存档由各测试清理。

第一版 Telegram 仅文字、总控本轮回复和网页审批提醒；执行会话的长任务完成订阅、自动创建 worker 与多任务依赖调度不在本阶段范围。外部通知遇到丢失 ACK 可能重复，模型任务不因通知重试而重新执行。未指定预算，不设默认值。

## Deployment checkpoint

用户明确要求继续启用后，配置 `/etc/systemd/system/codeck.service.d/30-telegram.conf`，重启 Codeck 服务并部署当前工作区版本；尚未 git 提交或推送。凭据位于仓库外的私有配置目录。认证健康检查返回 `ok: true`，服务日志确认 Telegram owner 私聊入口启动。已接收绑定消息并发送确认，outbox 为 0、待执行任务为 0；没有将绑定文字交给模型。原 `info-hub.service` 仍 active，未修改其凭据；tmux server 位于独立 session scope，未重启。真实模型任务联调仍待验证。

用户随后报告 Telegram 无法确认，并明确要求总控 --yolo。现场第一轮已 interrupted，“确认”只作为 userMessage 追加，未回答审批。已将托管总控创建、恢复及后续 turn 设置为 never / danger-full-access，其他会话不受影响；生成指令要求业务确认走普通聊天。`/tmp/codeck-yolo-full.log`：1259 项通过，已重启部署。原总控 thread 的实际 resume 返回 approvalPolicy=never、sandbox.type=dangerFullAccess，验证没有启动模型轮次或重发旧任务。Telegram 原生交互请求仍仅通知网页处理，不能把此修改表述为实现了 Telegram 原生审批协议。
