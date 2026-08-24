# Codeck

一个轻量级的服务器 Agent 桌面：既可在浏览器中管理 tmux 终端，也可用适合手机的对话界面远程操作 Codex、Claude Code 和 QoderCLI。

## 启动

```bash
npm install
npm start
```

`node-pty` 是原生模块；如果当前 Node.js 没有对应的预编译版本，需要服务器具备 C/C++ 编译工具和 Python（Debian/Ubuntu 可安装 `build-essential python3`）。

打开终端中显示的 HTTPS 地址，并输入同一处显示的访问令牌。默认监听 `0.0.0.0:4310`，适合不经过 nginx 的可信内网；公网通过 nginx 反向代理时，应显式设置 `HOST=127.0.0.1`，再由 nginx 在外网监听 `3392`。代理必须允许 `/ws` 和 `/agent` 的 WebSocket Upgrade。所有会话 API 和加密 WebSocket 连接都必须提供访问令牌。未设置 `CODECK_TOKEN` 时，每次启动会自动生成一个随机令牌。

首次启动会通过 `openssl` 在 `~/.codeck` 生成并保存自签名 TLS 证书。浏览器会提示该证书不受信任，需要手动确认。正式部署可使用受信任证书：

```bash
CODECK_TLS_CERT=/path/to/fullchain.pem CODECK_TLS_KEY=/path/to/privkey.pem npm start
```

如果不希望直接开放端口，可改为仅监听本机并通过 SSH 转发：

```bash
ssh -L 3392:127.0.0.1:4310 user@server
```

需要固定令牌、端口或监听地址时：

```bash
CODECK_TOKEN='replace-with-a-long-secret' PORT=4310 HOST=0.0.0.0 npm start
```

`CODECK_TOKEN` 可自定义，并支持特殊字符；在 shell 或环境文件中设置时请使用引号保护令牌。

终端模式下，`codex`、`claude` 或 `qodercli` 必须已安装在服务器的 `PATH` 中。缺少某个 CLI 不影响 tmux 和普通 shell 功能。

## 手机对话模式

打开 `/remote.html`，或从终端页顶部进入“对话模式”。这个页面不解析终端字符网格，而是通过三套官方结构化接口统一显示对话、流式回复、工具执行、停止操作和授权请求：

- Codex 使用服务器上的 `codex app-server`，需要已安装并登录 Codex CLI。
- Claude Code 使用 Claude Agent SDK，并沿用服务用户的 `~/.claude` 登录和配置；通过 cc-switch 配置的路由也会继续生效。
- QoderCLI 使用 Qoder Agent SDK 和服务用户现有的 `qodercli login` 状态。

远程 Agent 只接受 owner 令牌，不接受单个 tmux 会话的分享令牌。手机页面中的“本次会话允许”会放宽后续同类工具操作，确认前应检查命令、路径和参数。工作目录必须是服务器上的绝对路径。

手机页左栏统一列出当前仍存在于 tmux 的 Agent 会话，不按 Codex、Claude Code 或 QoderCLI 分栏；主标题显示 Coding CLI 自己的 session 名，副标题显示 tmux 名和即时的工作/完成状态。已经退出 tmux 的历史会话不会显示。打开会话后，输入区上方会显示“正在思考”“正在运行命令”“正在修改文件”或“正在回复”等活动，并在 owner 模式下实时显示 tmux pane 中当前可见的 Agent 动作块。该摘录会清除 ANSI 控制符并限制行数，单会话分享令牌不会获得 pane 内容。

打开已有 tmux Agent 会话后无需“接管”：原来的 Coding CLI 会继续运行，手机输入会经服务端重新校验 provider、thread ID 和 tmux session，再只发送到该 CLI 的精确 pane。桌面终端和手机因此可以直接参与同一个 Codex、Claude Code 或 QoderCLI 会话；停止按钮会向同一 pane 发送 Escape，不会结束 CLI 或 tmux 会话。CLI 刚启动、尚未暴露持久化 thread ID 时，左栏会话仍可点击并发送首条消息；检测到真实 ID 后，Remote 会自动切换到结构化历史。Remote 仍使用结构化接口显示消息、工具活动和状态，并只在会话工作中或手机刚发送消息后短时刷新历史，避免空闲时反复读取造成卡顿。会话若已退出、切换到其他 Agent，或身份无法精确确认，发送会被拒绝并提示刷新。

Remote 输入框左侧的 `＋` 支持从相册、相机或文件选择器添加附件，也可以直接粘贴图片或在桌面拖入文件。每次最多添加 10 个附件，单个文件最大 100 MB；发送时文件会先上传到 `~/.codeck/uploads/remote`，再把服务器路径交给 Codex、Claude Code 或 QoderCLI 读取。Shell 会话不会单独执行附件路径，必须先输入要运行的命令，Codeck 再把安全引用的路径追加到命令末尾。

连接终端后，可以从剪贴板直接粘贴 PNG、JPEG、WebP 或 GIF 图片。Codeck 会将图片保存到服务用户的 `~/.codeck/uploads`（单张最大 10 MB），并把服务器文件路径输入当前会话，供支持图片路径的 Agent CLI 读取。

也支持将本地文件/文件夹直接拖拽到终端区域。拖拽目录会保留目录结构，上传后的文件路径会按同样路径写入 `~/.codeck/uploads` 并在终端中自动写入对应路径。

支持从终端中选中 `~/.codeck/uploads/...` 下的文件路径直接拖拽到本地下载。拖拽时会携带当前 token，后端按 token 校验后返回文件二进制。

## 运维指南

- [通过 cc-switch 让 Claude Code 使用 ChatGPT/Codex OAuth](docs/cc-switch-claude-chatgpt.md)

## 验证

```bash
npm test
```

Codeck 会调用服务器现有的 `tmux`，且 Web 终端拥有该服务进程用户的权限。不要以 root 身份运行；公网部署应使用受信任的 TLS 证书，并通过防火墙限制可访问来源。
