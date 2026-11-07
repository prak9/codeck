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
codeck session send research --file /tmp/task.txt
codeck session create new-task --provider codex --cwd /data/code/project
codeck page publish report.html --title '研究报告' --source-key '/project:reports/report.html' --session research --revision abc123
codeck page share source-ID
codeck page revoke source-ID
```

`session create` 只创建并启动 CLI，不附加任务；Agent 身份就绪后再 send。命令支持 `--json`；默认输出可读文字。读取不触发新轮次。创建失败先查列表，发送失败按错误中的 commandId 核对，不自动重放。会话创建、消息发送和网页操作沿用服务端权限。

发布返回页面 ID、链接、source 和 contentHash。无来源时使用 `--id`；有来源时使用 `--source-key`，不要同时传两者。同一 key 在重启及并发发布后仍指向同一页面，正文、标题和来源版本按串行写入顺序更新，已有分享保持不变。key 是来源身份，不应把每次变化的 commit/hash 放进 key；变化版本写到 revision。

配套 Skill 位于 `skills/codeck/SKILL.md`，本机通过 Codex Skill 目录的符号链接安装。无需新增常驻 Agent 或后台服务。
