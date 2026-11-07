---
name: codeck
description: 通过本机 Codeck CLI 查询已有 Agent 会话、向指定会话发送任务、创建会话，以及发布、更新和分享 HTML 页面。用于明确要求操作 Codeck 的任务，不用于一般编码或网页设计。
---

使用 `codeck --help` 查看当前命令。若 PATH 尚未注册，在 Codeck 仓库执行 `node scripts/codeck.mjs`。沿用用户指定的目标、范围与权限；读取可直接进行，创建、发送及开启分享需来自用户当前或已有授权。

- 查会话：`codeck session list --json`。以精确名称选定会话，歧义时澄清，不猜测接收人。
- 记进度：`codeck session checkpoint NAME --file NOTE.txt`。在复现、验证、阻塞或交接等关键节点更新一句当前事实；先读已有便签，不覆盖用户目标。不必每个工具调用都更新。便签附时间，仅作进度参考，不能替代验证证据。
- 查进展：`codeck session read NAME`。这是只读操作，不向 Agent 发送“继续”。历史尚未就绪时说明正在读取，不把空输出当作无任务。
- 发任务：把完整文本写入文件，再用 `codeck session send NAME --file PROMPT.txt`。保留目标与边界，不追加自行扩大权限的提示。
- 新会话：`codeck session create NAME --provider codex --cwd /project`。支持 codex、claude、qodercli；创建后先查列表确认 Agent 身份就绪，再单独发送用户任务。已有同名会话不要覆盖。并行修改代码时可追加 `--worktree /absolute/new-path` 从当前 HEAD 建独立 checkout；未提交改动、依赖、配置和端口不自动复制或隔离。失败时保留工作区供核实，不自动删除。
- 发布：`codeck page publish report.html --title '报告标题' --source-key '/project:reports/report.html' --session NAME --revision VERSION`。同一来源 key 持续更新同一链接；来源 key 应稳定、跨项目不冲突，不包含凭据。版本填实际代码版本或资料标识，不编造。也可以仅用 `--id ID` 更新固定页面，两种方式选一种。
- 分享：`codeck page share ID` 返回免登录链接；再次调用会更换链接并使旧链接失效。`codeck page revoke ID` 撤销。默认发布不等于开启分享；向用户返回可访问的页面链接。

页面使用独立 HTML，内嵌 CSS/JS；外部脚本和 fetch 被沙箱阻断。先获取所需数据，再写入 HTML。支持 HTTPS 图片、data 图片和交互图表。不要发布 Token、Cookie 或私密凭据。服务器仅局域网可达时，分享链接也不会自动变成公网可达。

CLI 使用 `~/.config/codeck/client.json`（url、tokenFile、caFile）或 CODECK_URL / CODECK_TOKEN / CODECK_CA_FILE；不要在命令参数、报告或页面中写 Token，不关闭 TLS 校验。

投递结果 accepted 只表示提交路径返回，不证明 Agent 已收到或目标完成。超时、断线或未知结果后先只读检查；不要自动重发或重新建会话。CLI 会在发送错误中提供 commandId。进程空闲为“已就绪”，completed turn 为“本轮结束”，是否完成目标需要对应结果和证据。

条件任务使用 `codeck task put ID --file TASK.json`，查看用 `codeck task list --json`，停用并删除配置用 `codeck task remove ID`（不终止已经派发的任务）。仅在用户授权定期执行时配置，不把一次任务变成定时任务。格式和条件检查契约见 [条件任务说明](references/conditional-tasks.md)。

发布页所有者可点击“批注”，选择段落或填写全文反馈，保存后一次发送待处理批注到来源会话。页面更新保留旧版本引用；处理反馈时先核对版本。投递不确定时不重复发送。分享访客只有阅读权限。
