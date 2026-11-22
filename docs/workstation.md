# Codeck 工作台

日常聊天仍从 Sessions 进入。要隔几天找回一件事及其成果，把它加入 **Tasks**。需要在指定时间检查变化，用 **Automations**。要为长期职责保留固定对话，例如「投研助手」，绑定一个 **Bot**。三个入口都使用主账号权限。

## 在 research 跟踪一份报告

1. 在 Remote 找到“核对 APP 季报”那轮消息，点 **加入 Tasks**，核对标题并保存。下次再从同一轮加入会打开同一条任务。在普通模式也可以打开 **Tasks → 从会话加入任务**，选择 research 并填写标题。手动登记会创建独立任务，同一会话内可以有两个同名任务。
2. 在同一个 research 会话继续讨论其他公司。回到 **Tasks**，仍可按标题打开 APP 任务。在详情的 **更新任务** 填入已经核实的进展，按实际结果选择任务状态。会话变为空闲时，任务保留原状态。
3. 用 research 的 **资料与成果** 登记财报对照表为成果，或通过下方 CLI 登记。打开任务详情，点 **关联成果版本**，选择这次交付的版本。以后覆盖原文件或上传新版，任务仍能取回当时的文件及其验证记录。若登记的是外部网址，打开时展示该地址当前提供的页面。
4. 有待回答的问题时，在 **Tasks → 待你处理** 查看来源并作答。需逐项填写的问题可返回来源会话处理。已有的延迟审批、待决建议、蓝图、全局记忆及编排开关在 **审批与设置** 中。回到任务可继续阅读成果。

任务的来源记录会话名、创建时间、Agent 和对话 ID。同名会话重建后，旧任务及已关联文件仍可读。Remote 的具体消息以可用的历史锚点定位。普通模式打开来源终端。

## 设置投研助手与公告检查

侧栏 **Bots → ＋**，填「投研助手」及职责，选已进入 Agent 的 research 作为主会话。需要新目录或新 Agent 时先用 **新建会话** 配置。点 Bot 名称可回到这个对话，点旁边的箭头查看归属它的活跃任务。

在 **管理 Bot → 职责与偏好** 可以写“对照表注明公告日期和原文链接”。职责和可选偏好只保存在此 Bot 的绑定记录中。保存设置不会向主会话发送消息。全局长期指令仍在 **审批与设置 → 记忆** 中管理。解除绑定后，原会话和任务仍然保留。

在 **管理 Bot → Telegram** 选择已连接的机器人，再点 **绑定 Telegram**。此后给该机器人发私聊会进入这个 Bot 的主会话；待答通知也从同一机器人返回。每个 Telegram 机器人对应一个工作台 Bot。另一个 Bot 可选用另一只机器人，接入方法见 [Telegram 配置](telegram.md#绑定工作台-bot)。

打开 **Automations → 新建规则**。例如，填写执行事项“核对新公告并生成差异表”，选择投研助手，设置工作日 09:00、时区 Asia/Shanghai。若只在出现新公告时派工，在 **条件检查** 填入本机已有检查程序的绝对路径与参数组成的 JSON 数组。检查程序输出稳定的公告编号。无新结果时返回空输出。先点 **试算** 核对时间、项目与派工目标，再保存。**立即运行** 会实际检查。在 **运行记录** 看这次跳过、入队、启动或待核实的原因。

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

在 **Tasks → 审批与设置** 打开原个人行动台。要让本次页面显示旧导航，在当前普通或 Remote 地址的查询参数中添加 `workstation=legacy`。删除该参数即可恢复新导航。切换导航无需执行数据库回退。

任务、Bot、执行记录和定时检查保存在服务现有的数据目录 `super-agent.db`。文件快照仍由同目录的 `workfiles/` 管理。分享链接按原会话权限访问，工作台管理接口仅供主账号使用。

已有固定投递脚本的 Bot 可通过 Automations 管理周期、暂停和运行记录。维护者把可执行文件安装到 `~/.codeck/automation-scripts/<Bot ID>/<脚本名>`，创建规则时指定 `botId`、`script` 和已绑定的 Telegram `channelId`。脚本自行核验发送回执。退出码 0 表示执行成功，3 表示无事可做，4 表示结果待核实，其他非零码表示失败。
