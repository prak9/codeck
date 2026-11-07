# Program: Codeck 进度、条件任务与成果反馈

> Single-file current-state plan for direct, independently verifiable work.

- Overall status: `完成`
- Profile: `Lite`
- Contract status: `Confirmed`
- Active plan node: `None`
- Latest evidence: /tmp/codeck-workflow-full-serial.log：1284通过；pages/terminal/remote 浏览器日志。
- Current blocker: `None`
- Next step: `None`
- Next checkpoint: `None`
- Next human decision: `None`
- Owner: `AI`
- Last updated: `2026-11-07`

## Outcome

- Problem: 多会话需要反复询问进展，成果反馈需手工搬运，定时任务缺少条件检查。
- Success: 普通和 Remote 展示进度与待处理提醒；条件检查决定是否派发；发布页逐段批注批量反馈到来源会话；独立工作区可选。
- Collaboration intent: delivery；已授权执行。
- Non-goals: 不引入总控 Agent、复杂面板、新依赖；不向真实会话发送测试消息；iOS 交付方式待用户答复，先评估。

## Constraints

- Strategic defaults: 用户 AGENTS、plan-skill、web-design。
- Tactical objective: 复用 API、身份校验、发送回执与既有界面。
- Imperative bounds: 分享访客不可派发；未知投递不得自动重发；空闲不等于目标完成；不覆盖已有修改。
- Negotiable space: 接口字段、存储和测试细节。
- Material assumptions: None unless an inferred preference could change the plan.
- Active unknowns: None. Record only unknowns that can change execution, each with its cheapest resolution.
- Escalate when: A preference conflicts or evidence reveals a better option that requires changing a bound.

## Acceptance

| ID | Condition | Verification | Pass condition |
|---|---|---|---|
| A-001 | 进度、提醒、条件任务与批注具备可验证的完整路径 | 隔离 API/状态测试、真实浏览器手机和桌面交互 | 无重复投递，过期版本明确，权限隔离不回归。 |

## Plan

| Node | Status | Action | Verification | Evidence | Reflection |
|---|---|---|---|---|---|
| NODE-001 | `完成` | 进度与提醒 | 会话身份和状态测试 | session-checkpoints.test.js；/tmp/codeck-workflow-terminal.log；/tmp/codeck-workflow-remote.log | None |
| NODE-002 | `完成` | 条件任务与可选工作区隔离 | 条件跳过、重启、重复运行隔离测试 | conditional-tasks.test.js；isolated-workspace.test.js；/tmp/codeck-workflow-cli.log | R-001 |
| NODE-003 | `完成` | 逐段批注与批量反馈 | API权限/版本测试及浏览器验证 | /tmp/codeck-workflow-feedback.log；/tmp/codeck-workflow-pages.log | None |
| NODE-004 | `完成` | iOS方案、整体回归、文档和知识沉淀 | 技术评估与验收记录 | 隔离服务启动/授权/PWA元数据通过；/tmp/codeck-workflow-full-serial.log | None |

## Reflection Log

Add `R-*` only when evidence changes an assumption, plan, verifier, scope, or reusable rule. For routine success with no trigger, use explicit `None` in the Plan row.

| ID | Scope | Evidence | Wrong / changed | Right / preserve | Next rule |
|---|---|---|---|---|---|
| R-001 | NODE-002 | conditional-tasks.test.js 同目标双任务测试 | 瞬时空闲不足以允许下一项调度 | 持久化请求标识和未知结果不重放 | 等对应 transcript 轮次结束再释放调度占用 |

## Delivery — 2026-11-07

功能已实现并隔离验证，未提交、推送或重启生产服务。保留原有未提交修改；新文件亦未暂存。普通和 Remote 显示进度与待处理提醒；后台10秒采样状态，不开启额外模型推断。条件任务通过 CLI/API 配置，预检查有30秒/64KB限制并清理进程组；同一目标调度等待已投递轮次结束，未知结果保持记录。未配置实际任务。

发布页逐段批注保存版本和来源身份；页面 iframe 与批注表单校验同一内容摘要，拒绝更新竞态；分享访客无写权限。手机390/桌面1365浏览器验证选段、保存、批量派发、刷新不重发。独立 worktree 通过真实隔离 Git 仓库测试，原仓库脏文件未变。

iOS 选择尚无用户答复，已说明采用轻量默认：主屏幕 Web App。提供 manifest/512图标/standalone，保留现有授权；无 Service Worker 缓存、Web Push、TestFlight 或真机验证。独立原生 App 不计为已交付。

全套并行曾有1项原有 tmux 时序断言失败，单独复测通过，最终串行1284项通过；未修改该测试或实际 tmux 发送路径。浏览器和隔离服务均关闭，临时测试数据按各 fixture 清理，保留日志/截图。知识结论写入 /data/code/knowleage/engineering/codeck-lightweight-workflows.md（未提交推送）。使用说明 docs/workflow-tools.md；CLI/Skill 路径保持不变。

## Deployment — 2026-11-07 19:03 Asia/Shanghai

用户授权“修复部署”后重启 codeck.service，包含本计划工作区改动及 Back to bottom 点击白名单修复。HTTPS健康正常，18个会话可读取且具备checkpoint字段，Telegram connected，条件任务0个，公开manifest返回200。systemd active，启动日志无错误；真实codeck pane仍存活，未注入验证输入。未提交或推送。真实Codex历史横幅点击效果尚待实际使用核验。
