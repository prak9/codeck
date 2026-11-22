# Codeck CLI

命令入口：`node /data/code/codeck/scripts/codeck.mjs`，本机也安装为 `~/.local/bin/codeck`。

连接配置 `~/.config/codeck/client.json`：

```json
{"url":"https://192.168.1.16:3392","tokenFile":"/home/x/.config/codeck/client-token","caFile":"/home/x/.config/codeck/client-ca.crt"}
```

将实际主 Token 放入私有 tokenFile（0600），证书使用对应服务 CA；不接受 HTTP、不跳过 TLS、不把 Token 写到 argv。CODECK_URL、CODECK_TOKEN、CODECK_CA_FILE 可覆盖配置，CODECK_CLIENT_CONFIG 可指定独立配置文件。

```sh
codeck session list
codeck session read research
codeck workfiles list research --json
codeck workfiles add research --record /absolute/path/source.json
codeck session send research --file /tmp/task.txt
codeck session create new-task --provider codex --cwd /data/code/project
codeck page publish report.html --title '研究报告' --source-key '/project:reports/report.html' --session research --revision abc123
codeck page share source-ID
codeck page revoke source-ID
```

`session create --provider agy` 启动 Google Antigravity 原生终端，默认通过本机 `http://127.0.0.1:7890` 代理，使用 `--dangerously-skip-permissions` 自动批准工具操作；恢复模式使用 `--continue` 继续最近会话。普通模式可直接创建；Remote 创建或选择 AGY 时进入对话页，读取该进程绑定的用户消息与 Agent 回复，输入发往原终端。终端右上角的 `？` 和 `✓` 分别发送目标与进展问询、确认继续的提示词。AGY 暂不支持 CLI 的 `session send/read`，首次使用在终端完成 Google 登录。

`session create` 只创建并启动 CLI，不附加任务；Agent 身份就绪后再 send。命令支持 `--json`；默认输出可读文字。读取不触发新轮次。创建失败先查列表，发送失败按错误中的 commandId 核对，不自动重放。会话创建、消息发送和网页操作沿用服务端权限。

## 将已有 Telegram 机器人绑定到工作台 Bot

先用 `codeck telegram list` 核对 Telegram 用户名。若要为 `@codeckbot` 设置独立主会话，先建立名为 `codeckbot` 的会话，在其中开始第一轮对话。用 `codeck session list` 核对该会话已有 Agent 对话 ID，然后绑定：

```sh
codeck bot create codeckbot --session codeckbot
codeck bot bind-telegram codeckbot --telegram @codeckbot
codeck bot show codeckbot
```

`codeck bot list` 列出 Bot 名称、主会话和 ID。同名 Bot 用 ID 指定。用户名也可以替换为 Telegram 的数字 ID。要解除绑定，使用 `codeck bot unbind-telegram codeckbot --telegram @codeckbot`。这些命令复用网页的主账号权限，绑定和解绑都只操作指定关系。接入新 Telegram 账号见[配置指南](telegram.md#绑定工作台-bot)。

发布返回页面 ID、链接、source 和 contentHash。无来源时使用 `--id`；有来源时使用 `--source-key`，不要同时传两者。同一 key 在重启及并发发布后仍指向同一页面，正文、标题和来源版本按串行写入顺序更新，已有分享保持不变。key 是来源身份，不应把每次变化的 commit/hash 放进 key；变化版本写到 revision。

配套 Skill 位于 `skills/codeck/SKILL.md`，本机通过 Codex Skill 目录的符号链接安装。无需新增常驻 Agent 或后台服务。

[工作文件格式、会话归属与版本边界](workfiles.md)。
