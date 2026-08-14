# Codeck

一个轻量级的服务器 Agent 桌面：在浏览器中查看、创建、进入和结束 tmux 会话，并直接使用 Codex、Claude 或普通 shell。

## 启动

```bash
npm install
npm start
```

`node-pty` 是原生模块；如果当前 Node.js 没有对应的预编译版本，需要服务器具备 C/C++ 编译工具和 Python（Debian/Ubuntu 可安装 `build-essential python3`）。

打开终端中显示的地址，并输入同一处显示的访问令牌。默认只监听 `127.0.0.1:4310`。远程使用时，推荐通过 SSH 端口转发：

```bash
ssh -L 4310:127.0.0.1:4310 user@server
```

需要固定令牌、端口或监听地址时：

```bash
CODECK_TOKEN='replace-with-a-long-secret' PORT=4310 HOST=127.0.0.1 npm start
```

`codex` 或 `claude` 必须已安装在服务器的 `PATH` 中。缺少某个 CLI 不影响 tmux 和普通 shell 功能。

## 验证

```bash
npm test
```

Codeck 会调用服务器现有的 `tmux`，且 Web 终端拥有该服务进程用户的权限。不要以 root 身份运行，也不要直接暴露到公网；公网部署应置于带 TLS 和身份认证的反向代理之后。
