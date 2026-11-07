# 内置后台服务与 Telegram

Codeck 以执行 session 为中心，没有常驻总控 Agent、总控入口或后台模型巡视。自然语言消息按需调用一次临时只读模型理解意图，随后由确定的服务逻辑操作 session；理解完成或超时即关闭临时进程。三个职责随 Codeck 服务运行：

| 服务 | 行为 |
|---|---|
| 连接维护 | 复用现有心跳、重连、订阅恢复和快照同步；不重放终端输入或续跑任务 |
| 消息投递 | 复用 AgentHub 的身份校验、pane 输入队列和命令回执；未知结果不自动重发 |
| Telegram | 理解自然语言、选择/创建执行 session、订阅通知、回复原会话、明确停止或回答询问 |

普通模式「设置 → 后台服务」显示状态，并提供 Telegram 开关。关闭后不接收新操作；已提交的任务继续由原 session 执行。重新启用会处理关闭期间 Telegram 留存的消息，不能将关闭通知等同于取消任务。连接维护与回执是核心机制，保持启用。

## 配置

专用 Bot Token 保存在仓库外的私有文件，权限 0600。服务环境变量 `CODECK_TELEGRAM_CONFIG` 指向如下 JSON：

```json
{
  "tokenFile": "/home/x/.config/codeck/telegram-token",
  "ownerId": 123456789,
  "proxy": "http://127.0.0.1:7890",
  "webUrl": "https://codeck.example.com",
  "enabled": true
}
```

只接受 `ownerId` 指定用户的私聊。`proxy` 和 `webUrl` 可省略；填写 webUrl 后通知带对应 session 的网页链接，仍需正常登录。Token 不进入进程参数或日志。已有 webhook 或其他客户端轮询时报告冲突，不接管 Bot。

## 使用

可以直接发送：

- “让 research 继续当前目标，看看 report 进展。”
- “切换到 research。”随后说“继续”或“怎么样了”。
- “在 codeck 项目新开一个 Codex 任务，排查登录失败，只读定位，不修改代码，预算15分钟。”
- “新开一个任务，研究 XX。”

明确目标时直接处理；会话或项目有实质歧义时简短追问，普通回复或回复该追问都可继续；“取消”取消尚未执行的澄清请求。查询进展不会转换为继续执行。

新任务默认 Codex，沿用 Codeck 的 CLI 启动命令和现有权限配置；可明确指定 Claude 或 Qoder。项目目录匹配现有会话的 cwd 或用户明确提供的路径；未指定时继承当前明确会话的目录，否则使用 Codeck 服务工作目录。不会凭模型猜测创建目录。新 session 名为 `tg-消息ID-步骤`，任务通过 CLI 初始 prompt 参数启动，不经过粘贴/Enter。返回的 pane 与首次 thread 关联后才允许后续输入；启动尚未就绪时给出提示，不重复启动。

内部路由 JSON 不发给用户。模型只获得请求、必要的澄清上下文与会话元数据，不获得全量对话历史；只读路由调用有 60 秒连接/执行超时，这不是用户任务的执行预算。理解失败不猜测执行，也不自动重试任务。

以下命令仍可直接使用，不调用理解模型：

1. `/sessions` 查看当前 Agent 会话。
2. `/use research` 选择 research 并订阅其通知；之后普通文字直接发给它。
3. `/watch report` 单独订阅 report；`/unwatch report` 取消订阅。
4. `/status` 只读取所选会话最新进展；`/stop` 明确停止其前台执行，不顺带清理后台任务。
5. 回复一条会话通知，文字会发回该通知绑定的原 session，即使已切换当前选择。
6. 回复原生询问通知可直接写选项或答案，也可使用 `/answer`；直接回复原生权限通知的“确认/同意/拒绝”对应该具体请求，或使用 `/approve`、`/deny`。不在具体审批通知上的“确认”不会被当作权限批准。过期请求不执行；多项原生问题暂在网页回答。

新订阅以当前历史建立基线，不补发旧的已结束轮次。此后通知「本轮结束」「本轮失败」「本轮中止」「待确认」；本轮结束不是目标完成。只读取订阅会话的最近窗口，约每 10 秒检查一次；历史暂不可用不会产生完成通知。当前不提供独立的“目标完成”推断器。

当前仅文字，附件继续通过网页发送。不支持 Shell 注入，也不透传任意 CLI 斜杠命令。会话名字、provider、thread ID 必须匹配；会话被替换后需重新选择。保留最近 1000 条机器人消息的回复路由，过旧或未知回复明确拒绝，不能悄悄发到当前会话。

## 持久化与恢复

`${CODECK_DATA_DIR:-~/.codeck}/telegram/<bot-id>/sessions.json` 保存输入偏移、操作阶段、待发通知、会话选择和回复映射。目录 0700，文件 0600。先持久化输入再推进 offset，发送前记录 dispatching；进程重启后不重放结果未知的操作。发送返回只表示尝试发送，收到真实历史 user message 后另行确认。

通知发送失败只重试通知。Telegram 接收通知但 ACK 丢失时可能出现重复通知，不会因此重跑任务。旧版 `state.json` 和总控历史保留，只继承旧输入偏移，不执行旧总控的 inbox 或 outbox。

检查状态：owner 认证的 `GET /api/services`；开关：`POST /api/services/telegram`，JSON 为 `{"enabled":false}` 或 `{"enabled":true}`。开关写回配置，重启后仍生效。

## 验证

`npm test` 包含多会话路由、身份变化、显式审批、旧存档、通知失败、输入去重、TLS AgentHub 真实协议和既有重连/投递回归。

自然语言方案先持久化为独立步骤，再执行；每步操作前写入 dispatching。重启只推进尚未开始的独立步骤，结果未知的发送或创建不重放。创建会话和传入初始任务在一次 tmux 启动中完成；若结果丢失，报告确定的会话名供核实，不重新创建另一个。新增测试包括澄清上下文、多动作、创建 ACK 丢失、首次 thread 绑定，以及隔离 tmux/假 CLI 的初始参数与 shell 引号验证。

`scripts/services-browser-smoke.mjs` 覆盖 390px/1365px 的设置状态与开关；`scripts/remote-browser-smoke.mjs`、`scripts/terminal-theme-browser-smoke.mjs` 检查已有界面。浏览器脚本通过 `CODECK_PLAYWRIGHT_MODULE`、`PLAYWRIGHT_BROWSERS_PATH` 使用本机 Playwright，无新增项目依赖，不连接真实 Agent 输入。
