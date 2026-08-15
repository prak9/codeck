# Codeck

一个轻量级的服务器 Agent 桌面：在浏览器中查看、创建、进入和结束 tmux 会话，并直接使用 Codex、Claude 或普通 shell。

## 启动

```bash
npm install
npm start
```

`node-pty` 是原生模块；如果当前 Node.js 没有对应的预编译版本，需要服务器具备 C/C++ 编译工具和 Python（Debian/Ubuntu 可安装 `build-essential python3`）。

打开终端中显示的 HTTPS 地址，并输入同一处显示的访问令牌。默认监听 `0.0.0.0:4310`，可通过服务器的局域网或公网 IP 远程访问；所有会话 API 和加密 WebSocket 终端连接都必须提供访问令牌。未设置 `CODECK_TOKEN` 时，每次启动会自动生成一个随机令牌。

首次启动会通过 `openssl` 在 `~/.codeck` 生成并保存自签名 TLS 证书。浏览器会提示该证书不受信任，需要手动确认。正式部署可使用受信任证书：

```bash
CODECK_TLS_CERT=/path/to/fullchain.pem CODECK_TLS_KEY=/path/to/privkey.pem npm start
```

如果不希望直接开放端口，可改为仅监听本机并通过 SSH 转发：

```bash
ssh -L 4310:127.0.0.1:4310 user@server
```

需要固定令牌、端口或监听地址时：

```bash
CODECK_TOKEN='replace-with-a-long-secret' PORT=4310 HOST=0.0.0.0 npm start
```

`CODECK_TOKEN` 可自定义，并支持特殊字符；在 shell 或环境文件中设置时请使用引号保护令牌。

`codex`、`claude` 或 `qodercli` 必须已安装在服务器的 `PATH` 中。缺少某个 CLI 不影响 tmux 和普通 shell 功能。

## 验证

```bash
npm test
```

Codeck 会调用服务器现有的 `tmux`，且 Web 终端拥有该服务进程用户的权限。不要以 root 身份运行；公网部署应使用受信任的 TLS 证书，并通过防火墙限制可访问来源。
