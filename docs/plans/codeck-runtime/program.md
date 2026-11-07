# Program: Codeck 恢复与 Agent 接口完善

- Overall status: `完成`
- Profile: `Lite`
- Contract status: `Confirmed`
- Active plan node: `None`
- Latest evidence: /tmp/codeck-runtime-browser.log：手机/桌面切换及断线恢复；/tmp/codeck-cli.log：真实 CLI 子进程旅程；/tmp/codeck-source.log：稳定来源发布。
- Current blocker: `None`
- Next step: `None`
- Next checkpoint: `None`
- Next human decision: `None`
- Owner: `AI`
- Last updated: `2026-11-07`

## Outcome

- Problem: 吸收 Orca 恢复、操作接口、状态及成果来源设计，改善 Codeck 跨入口一致性。
- Success: 终端恢复拒绝旧流数据，CLI/Skill 可操作现有会话与页面，各入口共享状态含义，页面按来源稳定更新。
- Collaboration intent: delivery；用户已确认四项按顺序实施。
- Non-goals: 不引入总控 Agent、任务 DAG、桌面 IDE、多机运行时或新依赖；不提交推送；不向真实会话注入测试输入。

## Constraints

- Strategic defaults: 用户 AGENTS.md；plan-skill、skill-creator；最小改动、先失败测试后修复。
- Tactical objective: 后台机制明确，前端保持简洁，复用现有 tmux、AgentHub、命令回执和发布接口。
- Imperative bounds: 不重放结果未知的输入；不把进程空闲或一轮结束等同目标完成；保留已有未提交成果。
- Negotiable space: 协议字段、CLI 命令、来源字段及测试选择由执行者决定。
- Material assumptions: CLI 优先复用 HTTPS/WebSocket；tmux attach 是快照来源，不移植 Orca 自有 PTY 环形缓存。
- Active unknowns: 当前切换流是否会接收旧输出，使用隔离连接与浏览器测试核验。
- Escalate when: 需要修改用户权限模型或扩大实际任务执行范围。

## Acceptance

| ID | Condition | Verification | Pass condition |
|---|---|---|---|
| A-001 | 断线/切换拒绝旧流并恢复，输入不重放 | 连接和浏览器隔离中断测试 | 延迟旧输出不进入新会话，过期 ACK 不影响新画面 |
| A-002 | CLI 与 Skill 可列举、读取、发送、创建会话和发布/分享/撤销页面 | 文档命令旅程、伪 Agent/隔离 HTTP/WS 测试 | 权限沿用主 Token，身份校验、错误和未知结果明确 |
| A-003 | 状态事实一致且不虚报完成 | 状态、Remote/Telegram 相关回归 | 空闲/执行/等待/失败与轮次结果分离 |
| A-004 | 同一来源发布更新稳定页面 | 并发、重启和发布测试 | 不重复建页，来源及内容版本可追踪 |
| A-005 | 整体验证和服务正常 | 全套测试、隔离浏览器与健康检查 | 相关测试通过，无真实会话操作 |

## Plan

| Node | Status | Action | Verification | Evidence | Reflection |
|---|---|---|---|---|---|
| NODE-001 | `完成` | 完善终端恢复契约 | 隔离恢复测试 | /tmp/codeck-runtime-terminal.log；/tmp/codeck-runtime-browser.log | R-001 |
| NODE-002 | `完成` | 轻量 CLI 和 Skill | 文档命令端到端 | /tmp/codeck-cli.log；Skill quick_validate；本机 CLI 列出18个会话 | None |
| NODE-003 | `完成` | 共享状态事实 | 状态及入口回归 | /tmp/codeck-state.log；/tmp/codeck-runtime-regression.log | None |
| NODE-004 | `完成` | 页面来源稳定更新 | 发布并发及重启 | /tmp/codeck-source.log；CLI 发布旅程 | None |
| NODE-005 | `完成` | 全套回归、文档及部署核验 | 测试/浏览器/health | /tmp/codeck-runtime-full.log：1275通过；/tmp/codeck-runtime-remote.log；实际HTTPS稳定来源发布/分享/撤销，临时页面已删除 | None |

## Reflection Log

| ID | Scope | Evidence | Wrong / changed | Right / preserve | Next rule |
|---|---|---|---|---|---|
| R-001 | NODE-001 | 旧 connect 用未标记清屏符作为切换边界；隔离旧流测试先失败后通过 | 仅清屏符不能识别来源会话 | 复用 tmux attach 重绘，不移植自有 PTY 缓存 | 输出绑定 flowId/epoch/seq，断点不明重新获取画面，输入不重放 |

## Delivery — 2026-11-07

已完成四项优化并重启部署工作区版本，未提交推送。终端采用协商的二进制 JSON 输出帧，绑定 flowId、attach epoch 和累计序号；重复/旧 ACK 不会提前完成新流排空。切换后旧清屏帧与旧输出被丢弃；不连续输出重新附着 tmux 获取当前画面，不重放输入，不建立 Orca 式长期 PTY 回放缓存。

CLI 安装于 ~/.local/bin/codeck，连接配置 ~/.config/codeck/client.json，主 Token 仅保存在0600私有文件。Skill 源在 skills/codeck，通过 /data/.codex/skills/codeck 符号链接发现。文档命令已以真实 Node 子进程、隔离 HTTPS 和 AgentHub 验证；模拟成功执行但回执丢失，调用次数仍为一次。生产仅执行只读会话列表（18个）和临时页面验证，未向真实 Agent 发送任务或创建测试会话。

界面与 Telegram 共享状态标签；completed turn 明确为本轮结束，不代表用户目标完成。页面通过来源 key 确定稳定 ID，返回 session/revision/contentHash；重复发布不会创建多个页面，更新保留分享。

全套1275项通过。终端浏览器390/1365验证切换、延迟旧流、强制断线恢复且无输入重放；Remote Codex/Qoder流程通过。服务刚重启的首个只读health请求收到502，待健康后执行一次临时发布旅程，创建/更新/分享/撤销验证通过，临时页面和文件已删除。测试浏览器、隔离服务均关闭，保留测试日志和截图。未知网络故障无法保证恰好一次执行，因此 CLI 不自动重发；结果需通过只读查询核实。长期真实会话运行尚未观察。
