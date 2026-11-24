# Codeck 工作台

普通和 Remote 模式都从侧栏 Sessions 进入对话。需要定时执行、管理 Bot 或查看已发布的页面时，展开「工作台」即可看到 Automations、Bots 和 Pages。

## 会话问题与 Bot 任务

例如 research 在核对季报时询问采用哪个财务口径，直接在 research 会话中回答。若工作已关联 Bot，展开该 Bot 并点开任务也能回答来源会话的问题、查看进展或取回当次关联的成果。历史任务可从 **管理 Bot → 关联任务** 打开。Remote 可定位到仍在历史中的来源消息，普通模式打开来源终端。会话的 **资料与成果** 提供交付物登记和查找。

## 设置投研助手与公告检查

侧栏 **Bots → ＋**，填「投研助手」及职责，选已进入 Agent 的 research 作为主会话。需要新目录或新 Agent 时先用 **新建会话** 配置。点 Bot 名称可回到这个对话，点旁边的箭头查看归属它的活跃任务。

在 **管理 Bot → 职责与偏好** 可以写“对照表注明公告日期和原文链接”。职责和可选偏好只保存在此 Bot 的绑定记录中。保存设置不会向主会话发送消息。全局长期指令仍在 **Automations → 更多 → 原有提醒与设置 → 记忆** 中管理。解除绑定后，原会话和任务仍然保留。

在 **管理 Bot → Telegram** 选择已连接的机器人，再点 **绑定 Telegram**。此后给该机器人发私聊会进入这个 Bot 的主会话；待答通知也从同一机器人返回。每个 Telegram 机器人对应一个工作台 Bot。另一个 Bot 可选用另一只机器人，接入方法见 [Telegram 配置](telegram.md#绑定工作台-bot)。

打开 **Automations → 新建规则**，填写执行事项，例如“核对新公告并生成差异表”。默认选择 **指定项目 · 按需新建会话**，填写本机项目目录、选择 Agent，设置工作日 09:00 和时区 Asia/Shanghai。也可以选已有会话继承项目和 Agent，或选投研助手使用其职责与偏好。

Codeck 服务在后台调度，浏览器关闭后仍会执行。保存规则只登记时间和执行配置。到点后，有条件的规则先检查，命中后才创建独立会话；无条件的规则到点直接创建。创建时用到的模板会话可以提前关闭。

若只在出现新公告时派工，在 **条件检查** 填入本机已有检查程序的绝对路径与参数组成的 JSON 数组。检查程序输出稳定的公告编号，无新结果时返回空输出。先点 **试算** 核对时间、项目与派工目标，再保存。**立即运行** 会实际检查。在 **运行记录** 查看跳过、入队或启动的结果，以及执行会话的名称。

在规则卡片点 **编辑**，可以修改执行事项、来源、条件和时间，支持一次、固定间隔、每天或工作日。Bot 脚本在来源列表显示脚本名与绑定的 Telegram 账号。编辑沿用原规则 ID、运行记录和启停状态；更新或删除时会撤销尚未派发的工作，已经开始的工作继续执行。**更多操作 → 复制为新规则** 可复用一份工作台规则或条件规则；**更多操作 → 删除** 会先要求确认。已结束的工作台规则可复制后重新设定时间。

要定期检查条件并跟进原会话，可从 **Automations → 更多 → 新建条件规则** 设置检查目录、命令与执行会话，在同一列表编辑、启停、运行和查看最近的检查结果。

独立任务会话继承选定项目目录和 Agent 类型。明确选择 Bot 时，派工提示包含其职责与偏好。自动派工支持 Codex、Claude 和 Qoder。新会话按 Codeck 本机配置启动，共用的项目目录也共用文件。要隔离并行代码改动，先准备独立的工作目录或 worktree。一次性跟进可以选择原任务，待对应执行会话空闲后继续。暂停规则会保留已开始的工作。遇到送达待核实，在原会话确认执行情况，再决定是否发起新的检查。

## 从命令行使用

已有 CLI 可查询会话、登记成果和管理旧规则。连接复用本机配置中的主 Token 与 CA。成果 JSON 支持标题、工作主题、项目内文件路径、版本和验证依据，见[资料与成果格式](workfiles.md)。

```sh
codeck session list
codeck workfiles add research --record /absolute/path/result.json --json
codeck workfiles list research --json
codeck task list
codeck timer list
```

`codeck task list/put/remove` 管理原有条件规则。人工跟踪任务使用 `/api/workstation`。从仓库根目录运行下面这段，只读列出已登记的任务，沿用 CLI 的连接与证书设置。

```sh
node --input-type=module <<'JS'
import { loadClientConnection, clientRequest } from './src/codeck-client.js';
const connection = await loadClientConnection();
const { tasks } = await clientRequest(connection, '/api/workstation');
console.table(tasks.map(({ id, title, status, target }) => ({ id, title, status, session: target.session })));
JS
```

要从 Agent 工具登记一条对话，先读取 `GET /api/sessions`，取原会话的 `name`、`createdAt`、`agent.kind`、`agent.id`。向 `POST /api/workstation/tasks` 传入 `title`、`target: {session, createdAt, provider, threadId}`、稳定的 `anchor`，以及可选 `botId`。重复登记相同来源和锚点会返回同一任务 ID。向 `PATCH /api/workstation/tasks/:id` 传 `output: {itemId, versionId}` 可关联已登记成果，传 `progress` 和 `status` 可显式更新进展。任务状态可选 `planned`、`active`、`delivered`、`stopped`。登记只写工作台记录。

## 回到原入口

在 **Automations → 更多 → 原有提醒与设置** 打开原个人行动台。要让本次页面显示旧导航，在当前普通或 Remote 地址的查询参数中添加 `workstation=legacy`。删除该参数即可恢复新导航。切换导航无需执行数据库回退。

任务、Bot、执行记录和定时检查保存在服务现有的数据目录 `super-agent.db`。文件快照仍由同目录的 `workfiles/` 管理。分享链接按原会话权限访问，工作台管理接口仅供主账号使用。

已有固定投递脚本的 Bot 可通过 Automations 管理周期、暂停和运行记录。维护者把可执行文件安装到 `~/.codeck/automation-scripts/<Bot ID>/<脚本名>`，创建规则时指定 `botId`、`script` 和已绑定的 Telegram `channelId`。脚本自行核验发送回执。退出码 0 表示执行成功，3 表示无事可做，4 表示结果待核实，其他非零码表示失败。

本机的 **Joe · 期货日报推送** 会把 Telegram 已确认送达的日报同步到 **Pages → 期货日报**，每个交易日一页，登录后可读。Pages 暂时不可用时，规则下次运行会补存缺失的日报，沿用同一页面地址。
