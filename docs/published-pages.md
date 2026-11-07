# 发布页面 API

页面服务复用 Codeck 的 HTTPS、反向代理和主 Token。当前本机 Nginx 的 3392 端口已经转发至 Codeck，无需额外端口或进程。

- 浏览器入口：`https://你的服务器:3392/pages`
- 页面链接：`https://你的服务器:3392/pages/页面标识`
- 浏览器沿用现有 Token 登录；未登录先到登录页，登录后回到目标页面。
- API 使用 `Authorization: Bearer <现有主 Token>`；会话分享 Token 无权查看或管理页面。浏览器会话 Cookie 不授权写入 API。

## Agent 发布

推荐固定标识的 PUT，可重试并更新同一个链接。标识只能含字母、数字、短横线和下划线，最长64位。

```sh
export CODECK_URL='https://你的服务器:3392'
# CODECK_TOKEN 使用现有主 Token，由私有环境注入，不写入报告或仓库。
python - <<'PY' > /tmp/codeck-page.json
import json
from pathlib import Path
print(json.dumps({"title": "研究报告", "html": Path("report.html").read_text()}))
PY
curl --fail-with-body "$CODECK_URL/api/pages/research-report" \
  -X PUT -H "Authorization: Bearer $CODECK_TOKEN" \
  -H 'Content-Type: application/json' --data-binary @/tmp/codeck-page.json
```

客户端应信任服务器的 HTTPS 证书或使用 `--cacert` 指定本机 CA。不要将 Token 放进页面链接。

返回示例：

```json
{"id":"research-report","title":"研究报告","createdAt":"...","updatedAt":"...","url":"/pages/research-report"}
```

`url` 为同站相对地址，拼到原来的 HTTPS 地址及 3392 端口即可；内部 Agent 也可通过 Codeck 的本机 HTTPS 端口调用相同 API。

| 方法与路径 | 用途 |
|---|---|
| `POST /api/pages` | 创建随机 ID 的新页面，返回201；网络结果不确定时先列出核实，不盲目重复 POST |
| `PUT /api/pages/:id` | 创建或覆盖固定 ID 的页面，返回200；同地址并发更新采用最后完成的写入 |
| `GET /api/pages` | 列出标题、ID、更新时间和链接 |
| `GET /api/pages/:id` | 读取完整 HTML 和元数据 |
| `DELETE /api/pages/:id` | 删除页面，返回204 |

请求体：`{"title":"标题","html":"完整 HTML"}`。标题非空且不超过256字；JSON 请求体最大20MB，仅页面 API 使用此限额。内容持久保存于 `${CODECK_DATA_DIR:-~/.codeck}/pages`，目录0700、文件0600，更新通过原子重命名替换；服务重启不会丢失页面。

## 页面能力与边界

支持独立 HTML、内嵌 CSS/JavaScript、交互图表、data URI 图片，以及 HTTPS 图片。请将必要样式、脚本内嵌到 HTML；API 不部署服务器代码，也不安装依赖。

发布页面在不带同源权限的 sandbox iframe 中运行，直接打开内容地址也受 CSP sandbox 保护。页面不能读取 Codeck 的 Cookie、localStorage 或父页面，不能调用 Codeck API、嵌套网页、提交表单、打开弹窗或导航父页面。外部 JS、网络 fetch、eval 不开放。需要数据的图表应由 Agent 先获取数据，再随 HTML 发布。包装页对标题转义，页面数据不进入 Codeck 主界面的脚本环境。

验证：`node --test test/published-pages.test.js`；`scripts/pages-browser-smoke.mjs` 覆盖手机/桌面登录、交互脚本、父页面与存储隔离、API 请求阻断和页面列表。

## 免登录分享

可以直接告诉 Agent：“发布这个页面，并给我一个免登录分享链接。”

- `POST /api/pages/:id/share`：创建分享链接；每次调用都会更换密钥，使此前链接失效。返回 `{"url":"/pages/页面标识?share=随机密钥"}`。
- `DELETE /api/pages/:id/share`：撤销分享，返回204。两个接口都要求现有主 Token。
- 分享链接只能读取指定页面，不能列出其他页面或调用管理、会话 API。分享页面继续使用相同的 HTML 沙箱隔离。
- 链接持有人可以查看并转发；默认没有到期时间。更新页面会同步更新分享内容，链接不变。删除页面后链接失效，即使重新创建同名页面也不会恢复。
- 撤销阻止后续读取，不能收回访客已经加载或保存的内容。分享密钥只在创建响应中返回，服务端保存哈希；忘记链接时重新创建即可。
- 将返回的相对链接拼接到可访问的 HTTPS 地址和3392端口。分享不会改变服务器网络可达性：局域网地址仍要求访客能连接该网络。

已登录的页面右上角提供“分享”和“取消分享”按钮。点击分享后展示可复制链接；重新打开已分享页面时可取消分享或更换链接（旧链接失效）。分享访客不显示管理按钮。浏览器管理操作通过专用 `/pages/:id/share` 路由使用登录 Cookie，并要求自定义请求头与同站请求；发布 API 继续要求主 Token。

## 按来源稳定发布

`POST /api/pages/publish` 接受原 title/html，并要求 `source: {key, session?, revision?}`。key 为稳定、跨项目唯一的来源标识（最多2000字），session/revision 为可选文本（各最多256字）。服务根据 key 生成固定页面 ID，同一来源的并发与重启后发布更新同一个页面；显式 PUT 不能把该 ID 改绑到另一个来源。响应、列表与读取包含 source 和 HTML 的 SHA-256 contentHash。来源信息不展示给免登录访客。
