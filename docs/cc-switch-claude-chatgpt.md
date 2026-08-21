# 通过 cc-switch 让 Claude Code 使用 ChatGPT/Codex OAuth

本文说明如何让 Claude Code 通过 cc-switch 的本地路由使用 ChatGPT/Codex OAuth，并处理以下错误：

```text
API Error: 400 配置错误: Claude Provider 缺少 base_url 配置
```

操作和界面名称基于 Linux 上的 cc-switch 3.20.0。后续版本可能调整入口名称，但判断方法不变：Claude Code 连接本地路由，路由当前 Provider 必须是已授权且带上游地址的 Codex Provider。

如果 `Codex` Provider 已完成 OAuth 授权，直接在 Claude Provider 页面选中它并点击“启用”即可修复该错误；不要继续使用空的 `default` Provider。

## 工作方式

```text
Claude Code
    -> http://127.0.0.1:15721
    -> cc-switch（Anthropic 请求转 OpenAI Responses 请求）
    -> Codex OAuth Provider
    -> ChatGPT Codex 上游
```

`~/.claude/settings.json` 中的 `ANTHROPIC_BASE_URL` 应指向 cc-switch 本地路由，不能直接填写 `https://api.openai.com/v1`。Claude Code 和 OpenAI Responses API 使用不同的请求格式，cc-switch 负责转换两者。

OpenAI 官方 API 是另一条接入路径：应用使用 API Key 或短期访问令牌认证，并通过 Responses API 等接口发起请求。参见 [OpenAI API Overview](https://developers.openai.com/api/reference/overview) 和 [Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create)。本文配置的是 cc-switch 管理的 Codex OAuth 路由，不是 OpenAI API Key 直连。

## 前提条件

- 已安装并启动 cc-switch。
- 已安装 `claude`，且命令在 `PATH` 中可用。
- 可以在浏览器中完成 ChatGPT/Codex 设备授权。
- cc-switch 与 Claude Code 运行在同一台主机、同一操作系统用户下。
- 使用 Claude Code 时，cc-switch 需要持续运行。

不要把 OAuth 文件、Refresh Token、`ANTHROPIC_AUTH_TOKEN` 或完整配置输出提交到仓库。相关文件通常位于 `~/.cc-switch` 和 `~/.claude`。

## 配置步骤

### 1. 完成 Codex OAuth 授权

1. 打开 cc-switch 的 Claude Provider 页面。
2. 新增或打开 `Codex` Provider，认证类型选择 cc-switch 管理的 Codex OAuth。
3. 启动 Device Code 授权流程，在浏览器中登录目标 ChatGPT 账号并确认授权。
4. 返回 cc-switch，确认认证页面显示账号已保存，`Codex` Provider 不再要求登录。

cc-switch 会管理 OAuth 凭据和 ChatGPT Codex 上游地址。不要手工把 OAuth Token 写入 `~/.claude/settings.json`，也不要把内部的 `chatgpt.com/backend-api/codex` 地址当作 Claude Code 的 `ANTHROPIC_BASE_URL`。

### 2. 启用本地路由

在“设置 → 路由”中确认：

- “路由总开关”为开启状态。
- “路由启用”中的 `Claude` 为开启状态。
- 服务地址为 `http://127.0.0.1:15721`，或你明确配置的其他本地地址。

“在主页面显示本地路由开关”只控制界面上是否展示快捷开关，不等同于“路由总开关”。

### 3. 把 Codex 设为当前 Claude Provider

返回 Claude Provider 页面：

1. 找到完成 OAuth 授权的 `Codex` 卡片。
2. 点击卡片，再点击“启用”。
3. 等待卡片变成绿色高亮，并显示“使用中”。

不要启用显示“未配置官网地址”的空 `default` Provider。空 Provider 没有 `base_url`，路由选中它后，每个 Claude 请求都会返回本文开头的 400 错误。

启用后，cc-switch 日志应出现类似记录：

```text
代理接管模式：热切换 claude 的目标供应商为 ...
```

Provider 热切换不需要重启 cc-switch。若 Claude Code 原本已经连接本地路由，下一次请求会直接使用新 Provider。

### 4. 检查 Claude Code 的实时配置

以下命令只显示地址和 Token 是否存在，不会打印 Token：

```bash
jq '{
  model,
  env: {
    baseURL: .env.ANTHROPIC_BASE_URL,
    authTokenPresent: ((.env.ANTHROPIC_AUTH_TOKEN // "") | length > 0)
  }
}' ~/.claude/settings.json
```

结果应满足：

- `baseURL` 为 `http://127.0.0.1:15721`。
- `authTokenPresent` 为 `true`。

不要使用 `cat ~/.claude/settings.json` 排障；该文件可能包含本地路由 Token。

## 验证

### 1. 检查路由端口

```bash
ss -ltnp | rg ':15721\b'
```

输出应显示 `cc-switch` 正在监听 `127.0.0.1:15721`。

### 2. 从空目录发送最小请求

使用空目录可避免把当前项目内容带入验证请求：

```bash
verify_dir="$(mktemp -d /tmp/cc-switch-verify.XXXXXX)"
(
  cd "$verify_dir" || exit 1
  claude -p 'Reply with exactly: OK' --model sonnet --output-format json
)
```

成功时命令退出码为 `0`，JSON 中的 `is_error` 为 `false`，`result` 为 `OK`。验证结束后可删除该临时目录。

Claude Code 的结果中可能继续显示 `claude-sonnet-*` 等请求别名和 Claude 侧估算信息。这不代表请求实际发往 Anthropic；应以 cc-switch 的转发日志或使用统计为准。

### 3. 确认实际上游

```bash
rg -n '热切换 claude|请求目标:|缺少 base_url' \
  ~/.cc-switch/logs/cc-switch.log | tail -n 30
```

成功请求应出现指向 Codex Responses 路径的“请求目标”记录，并显示 `model=gpt-*`；切换完成后不应再出现新的“缺少 base_url”记录。

2026-08-21 在 cc-switch 3.20.0 上的端到端验证结果为：

- `claude-sonnet-4-6` 映射到 `gpt-5.6-sol`，HTTP 200。
- `claude-haiku-4-5` 映射到 `gpt-5.6-luna`，HTTP 200。

这些模型名是当次 Provider 配置的实测结果，不是必须长期固定的值。模型映射调整后，只要请求仍命中目标 GPT 模型并返回 200，链路就是正常的。

## 常见问题

| 现象 | 最可能原因 | 处理方式 |
| --- | --- | --- |
| `Claude Provider 缺少 base_url` | 当前 Provider 是空 `default` | 在 Claude Provider 页面启用已授权的 `Codex` 卡片 |
| 连接 `127.0.0.1:15721` 被拒绝 | cc-switch 未运行、路由总开关关闭或 Claude 路由关闭 | 启动 cc-switch，并在“设置 → 路由”开启总开关和 Claude |
| 上游返回 401 或 403 | Codex OAuth 失效或账号已被移除 | 在 cc-switch 认证页面重新完成 Device Code 授权 |
| Provider 已切换，旧终端仍请求旧地址 | Claude Code 进程启动时读取了旧的实时配置 | 退出并重新启动该 Claude Code 会话 |
| Claude Code 输出仍显示 `claude-*` | 这是发送给本地路由的请求别名 | 查看 cc-switch 日志中的实际 `请求目标` 和 `model=gpt-*` |
| cc-switch 显示“使用中”，但仍失败 | 路由未接管 Claude 实时配置，或本地端口与配置不一致 | 重新开启 Claude 路由，并用前述 `jq` 与 `ss` 命令核对地址 |

## 回退

需要恢复原来的 Claude 接入时：

1. 在 Claude Provider 页面启用此前可用的 Claude Provider，例如 `Claude Official`。
2. 如果不再使用本地转换，进入“设置 → 路由”，关闭 Claude 路由或路由总开关。
3. 检查 `~/.claude/settings.json`，确认 `ANTHROPIC_BASE_URL` 已恢复为预期地址，或已由 cc-switch 移除。
4. 重新启动现有 Claude Code 会话。

cc-switch 在接管实时配置时会保存备份。优先通过界面关闭路由并恢复配置，不要手工复制 OAuth Token。

## 安全检查

- OAuth 文件和 Claude 设置文件的权限应限制为当前用户可读：

  ```bash
  chmod 600 ~/.cc-switch/codex_oauth_auth.json ~/.cc-switch/settings.json ~/.claude/settings.json
  ```

- 排障输出只检查 Token 是否存在，不打印 Token 内容。
- 本地路由应只监听 `127.0.0.1`，不要把端口直接暴露到局域网或公网。
- 不要把 `~/.cc-switch`、`~/.claude/settings.json`、日志归档或数据库加入 Git。
- 分享日志前，先检查并移除 Device Code、邮箱、账号标识、Bearer Token 和 API Key。
