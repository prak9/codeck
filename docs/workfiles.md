# 工作文件：资料与成果

普通模式与 Remote 的会话工具栏提供文件夹按钮“工作文件”。默认关闭，不改变终端宽度；桌面打开右侧浮层，手机全屏打开。关闭后回到原会话，Esc 可关闭面板。

“资料”保存本次使用的材料；“成果”保存明确交付的文件、链接和已关联当前 Agent thread 的发布页。普通回复、命令日志不会自动转为成果，不扫描旧聊天或服务器目录。

文件的“预览”和历史版本在原面板中打开，支持常用 Markdown（标题、表格、列表、代码和链接）、图片、浏览器原生 PDF、纯文本。返回列表保留展开状态、位置与焦点；预览中按Esc先返回列表，再按Esc关闭面板。阅读期间固定所选快照，不自动替换成新版本。外部链接和发布页仍通过原有打开入口访问。

“版本与验证”显示快照版本、登记时间、内容哈希、提交者的验证方法/证据位置及未验证事项。原文件的时间、大小或inode改变时提示有更新迹象，不覆盖快照；字段未变也不等于原文件内容已重新验证。旧记录没有比较基线时如实显示未核验。检查只读取已登记路径的元数据，不扫描目录或重新哈希整份原文件。

上传会捕获当时的会话名、创建时间、provider/thread，保存为资料。上传完成后即使切换会话，也不会关联到后来选中的会话；没有可靠身份时不猜测归属。上传成功与登记成功分开，登记失败不重发消息。首次打开不会自动给 Agent 发消息。

面板打开且页面可见时每5秒检查更新；登记、上传、发布后的变化自动显示，无变化返回304且不重绘。关闭面板或切到后台停止检查，返回页面后立即核对。检查不重叠，连接出错会保留当前列表并重试。编辑条目、填写添加表单或查看展开的版本列表时暂缓更新，结束操作后继续；刷新保留分组展开状态、阅读位置和可恢复的焦点。下载票据即使内容未变也会定期更新。

Agent 读取 Codeck Skill 后，在使用关键来源和交付/更新正式成果时主动登记；不会向已运行会话注入提醒。未读取该约定或未实际登记的文件，不会自动从聊天或目录中推断出来。

## Agent 登记

```sh
codeck workfiles list research --json
codeck workfiles add research --record /absolute/path/source.json --json
```

链接示例：

```json
{"kind":"source","key":"app:2026-q3:filing","title":"APP 季度财报","url":"https://example.com/filing","date":"2026-11-05","group":"APP 财报更新"}
```

文件示例：

```json
{"kind":"result","key":"app:research-report","title":"APP 投资研究报告","path":"/absolute/project/report.md","revision":"实际版本标识","group":"APP 财报更新"}
```

- kind 为 source 或 result。key 在同一会话内稳定；修改同一成果沿用 key，变化版本放 revision。
- url 与 path 二选一。链接只接受 HTTPS 或本站 `/pages/ID`，不抓取正文；不要在链接中放凭据或敏感访问参数。
- 文件必须是当前 Agent 项目目录或上传目录内的真实文件，解析符号链接后仍须在范围内。不能借登记读取其他目录。
- 本地文件复制为私有快照并计算 SHA-256；后续修改原文件不改变旧版。相同 key、内容、revision/date 的重复登记不增加版本。
- group 可选，默认“当前工作”。标题和分组可在面板中编辑；编辑不修改文件版本。
- 来源登记不等于来源真实或结论已验证。填写实际来源、资料日期、版本；不要把自己的研究报告当成外部事实依据。
- 可选evidence沿用发布页的格式：`{"version":"实际版本","summary":"验证概要","checks":[{"method":"实际方法","result":"passed或failed或not-run","reference":"证据位置"}],"limitations":["未验证事项"]}`。记录由提交者提供，不自动构成验收；本地快照的contentHash由服务端绑定。新内容不会自动继承旧版本的验证记录。

关联当前 thread 的 `codeck page publish ... --source-key KEY --session research` 页面自动出现在成果中，沿用原有预览、分享与批注。固定 ID 的无来源页面不猜测归属；可明确登记其 `/pages/ID` 链接。发布页在此展示当前版本，仍沿用现有发布页的版本能力；文件快照历史不意味着发布页旧 HTML 已保存。

## 数据与权限

记录和快照位于 `${CODECK_DATA_DIR:-~/.codeck}/workfiles`，元数据0700目录/0600文件，原子替换。会话身份包括名称、创建时间、provider、thread；同名新会话不继承旧资料。

已保存的旧身份记录可在同名会话的“会话记录”中显式选择，只读访问，不合并进当前会话。会话关闭不删除快照。API也支持 owner 明确指定旧 identity 读取归档，不需启动 Agent。页面分享不开放整个资料列表。

下载使用仅限具体文件版本、身份及5分钟有效期的签名地址，不包含主 Token；链接持有人在有效期内可读取该版本。过期或服务重启后，刷新工作文件重新取得链接；打开文件预览会先更新该版本链接。启用网页持久登录时，精确文件GET也接受owner Cookie，保证长时间阅读PDF的后续范围请求仍可访问；Cookie不授权列表或写入API。

Markdown以DOM渲染，原始HTML按文本显示，不执行脚本或自动加载外部图片。文本预览最多读取256 KiB，截断明确提示；完整上传与下载上限不受此预览窗口影响。不支持的二进制文件可直接下载。PDF使用浏览器原生查看器，同源嵌入策略只开放application/pdf文件响应；不能内嵌时保留下载入口。HTML成果继续使用已有发布页沙箱，原始HTML文件只按纯文本预览。

第一版不自动提炼主题、不部署后台模型、不改 Agent 模式或预算。Agent 需显式登记额外资料与文件成果；文件快照会占磁盘空间，不在后台擅自删除历史。

API：`GET/POST /api/sessions/:name/workfiles`；POST需携带GET返回的identity；`PATCH .../workfiles/:id`编辑标题与group。owner读取归档用`GET .../workfiles?archive=IDENTITY`。三种Agent使用同一接口。

验证：`node --test test/workfiles.test.js`；`scripts/workfiles-browser-smoke.mjs`覆盖手机/桌面、深浅主题、版本、编辑、上传和切换身份。浏览器模块位置可用CODECK_PLAYWRIGHT_MODULE指定，已有Chromium路径可用CODECK_BROWSER_EXECUTABLE指定。
