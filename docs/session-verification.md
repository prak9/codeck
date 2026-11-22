# 会话验收

从仓库根目录运行 `node scripts/verify-session.mjs`。默认依次运行下面三组验证。浏览器组需要可导入的 Playwright 及其 Chromium。使用已有安装时可设置 `CODECK_PLAYWRIGHT_MODULE`（模块的绝对路径）和 `CODECK_BROWSER_EXECUTABLE`（Chromium 可执行文件）。

| 场景和入口 | 单独运行 | 通过条件 |
| --- | --- | --- |
| Remote 对话，发送后从侧栏切走再切回 | `node scripts/verify-session.mjs remote` | 同一页操作两个会话，另一个会话打开后收到前一会话的迟到快照。切回后，唯一标记的用户消息和回复各一条，服务端只收到一次提交。覆盖 Codex、Claude、Qoder、AGY 的协议夹具，各跑手机和桌面宽度。 |
| 普通终端，后台返回后直接输入 | `node scripts/verify-session.mjs terminal` | 模拟浏览器隐藏和恢复可见，保持连接打开但丢弃心跳回复。浏览器自行创建新连接，解析当前会话的新画面并恢复焦点。用键盘输入首字符，目标终端输入处理函数恰好收到一次。 |
| 后端识别当前会话和消息回执 | `node scripts/verify-session.mjs backend` | 运行 Agent 身份与 Codex 投递回执测试，包含未发送草稿与另一会话历史相同、同一轮有同文旧消息的场景。 |

`--dry-run` 列出命令。加 `--json` 时标准输出为版本、各组结果和截图目录，诊断在标准错误。失败返回非零。浏览器运行真实页面，使用本地隔离 HTTP/WebSocket 和模拟 Agent 回应；终端路径使用实际连接处理器与替身终端。真机休眠、外部网络、模型响应和真实 CLI 持久化需要另行验证。

交付时将运行版本、实际断言、证据及未验证范围放入本次运行专属的成果页，在便签引用该页。复测或验证另一版本时使用新的运行标识和页面来源 key，旧便签保留原证据。不要将会过期的下载票据写入便签。变更入口或验收场景时同步更新本表和对应浏览器脚本。
