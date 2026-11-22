# Program: Codeck 工作台 · Tasks / Automations / Bots

- Overall status: `完成`
- Profile: `Lite`
- Contract status: `Confirmed`
- Active plan node: `None`
- Latest evidence: 双模式四组浏览器验收、隔离 HTTPS 服务及调度回归通过，详情见交付核验。
- Current blocker: `None`
- Next step: None
- Next checkpoint: None
- Next human decision: None
- Owner: Codeck 维护者与实现 Agent
- Last updated: 2026-11-22

## Outcome

- Problem: 用户可以进入 research 等长期会话，但跨天寻找一项工作、处理待决问题、了解定时规则为何运行，需要分别翻对话、便签和个人行动台。
- Success: 同一件事从会话登记、侧栏查看、人工回答到打开当次成果均可追溯；定时执行不抢占正在使用的主对话。普通与 Remote 共用这套语义。
- Collaboration intent: 本次交付设计、开发实现、使用指南与隔离验收。核心体验用可点击示例和独立验收核对，生产发布单独安排。
- Non-goals: 首版聚焦本机工作台；跨主机调度、外部工单同步、看板拖拽、多 Bot 工作流编辑器留待实际需求。

## Constraints

- Strategic defaults: 沿用当前 Agent/provider、CLI、session 身份、owner 权限与局域网访问方式。普通会话可独立使用。
- Tactical objective: 日常工作仍可从上次会话直接开始；追踪任务与阅读进展尽量复用现有记录、审批和成果入口。
- Imperative bounds: 只读导航、建立跟踪关系和打开成果都应产生零次 Agent 输入。开发验收使用隔离数据、模拟通知与测试会话。
- Negotiable space: 表名、HTTP 路由、列表组件和索引按实际存储演进确定。未指定时间、费用或轮数预算。
- Material assumptions: 一个 Bot 的第一版配置绑定一台机器及至多一个主对话；同一主对话只绑定一个 Bot。一项任务可有多次执行记录；同一时刻只有一个接受该任务控制指令的执行目标。
- Verified scope: 旧蓝图沿用原记录和入口。普通终端打开来源会话，Remote 用可用历史锚点定位。独立派工支持 Codex、Claude、Qoder。
- Escalate when: 需要改变权限、重新启动已有派工或合并无法核实归属的历史数据。优先保留可读原记录。

### 产品及交互约定

| 对象 | 入口、主要操作 | 数据归属与边界 |
|---|---|---|
| Sessions | 原侧栏的目录、搜索、会话名称；普通模式进终端，Remote 进对应会话 | 保留原 session。名称用于展示；执行路由需核对创建身份、provider 与 thread。旧身份可读。 |
| Tasks | 侧栏 Tasks 打开主内容区；默认先列待你处理，再列进行中，最近交付折叠。行内展示标题、归属和一条进展。详情优先显示可处理的问题，其次为成果和「打开会话」。 | 每件事有稳定任务 ID，保存来源锚点、执行记录、阶段更新与成果版本。将一段对话加入 Tasks 时复用已有来源，双击只登记一次。任务可无 Bot。 |
| Automations | 规则行显示自然语言触发条件、执行者、下一次检查和上次结果。详情有暂停/启用、试算、运行记录。试算展示会派到哪里；手动实际执行另有明确动作。 | 规则 → 每次检查记录 → 满足条件后的任务或既有任务的后续执行。无变化只记跳过。一次性跟进携带原任务 ID；暂停只影响将来触发。 |
| Bots | 点名字进入主对话；独立展开控件列活跃任务。创建时填名称、职责，选已有 session 或新建。默认目录和 Agent 沿用所选目标。高级配置放详情。 | Bot 保存职责、范围、主会话引用及可选的专属偏好。点击 Bot 与点击其主 session 命中同一 thread。移除绑定保留历史和成果。全局记忆与 Bot 记忆分别管理。 |

示例路线：在 research 将“核对 APP 季报”加入 Tasks → 从详情找到原问题与版本化对照表 → 如需重复，建立“工作日 09:00 上海时间检查公告” → 新公告派给投研助手的独立会话 → 在 Tasks 回答口径问题 → 从原任务查看当次成果。普通问答沿用原路径。Telegram 的授权回答引用同一条待决记录。

**关键状态。** 任务可处于待开始、进行中、待你处理、已交付、已停止；失败附上发生在哪次执行、已保留什么、可采取什么动作。执行中的断线、后台、空闲、送达未知属于运行记录。新成果或有依据的明确交付才更新任务交付状态；未验证项仍在成果旁显示。“待你”按未解决的实际问题计数，同一问题在 Bot、Tasks、Telegram 中只有一个归属；阅读和回答是两个动作。网页或 Telegram 重复回答只生效一次。回答时若执行目标已换人，旧问题可查，输入不发往同名新会话。

**界面打磨。** 现有工具栏保持给当前 session 使用。桌面 Tasks/Automations 使用主区，手机使用侧栏抽屉和单页详情。浏览器返回应恢复原列表位置；返回终端应恢复选中会话、阅读位置与未发送草稿。Bot 名字、展开箭头和任务行是独立的点击目标。窄屏长标题可截断，待决问题在详情完整可读。所有操作有键盘焦点、可读名称，状态用文字辅以颜色。空态分别提供“从会话加入任务”“新建规则”“绑定已有会话”；错误显示当前可采取的动作。

### 迁移及工程边界

- 原概览的审批、待决建议和交付在 Tasks 聚合；保留原记录 ID 及处理端点。未归属某个任务的审批也必须可处理。未读简报与真正待决分开计数。
- 定时器、条件任务沿用现有调度与去重记录。现有 CLI 的 `task list/put/remove` 操作的是条件规则；保留语义，新增人工任务命令须明确区分。迁移默认只读映射，规则的启停、下次运行、授权范围和实际目标保持一致。
- 蓝图保留原目标、版本、试算及提案；能明确归属的链接到相应对象，其余保留可访问的旧记录。全局记忆、权限与自动编排开关在设置可达。共享只读链接不展示 owner 的任务标题、角标或审批。
- 同一事件重复到达、跨端点击和服务重启应复用持久化标识；投递不确定时先核实，保留手动处置入口。独立任务会话默认继承明确的项目与权限；已有调度继续沿用原绑定。新建 session 本身不提供文件隔离，需要并行修改同一仓库时沿用现有 worktree 能力。
- 先新增可关闭的新入口并共用原数据。以迁移前后 ID/条数、待批、规则触发次数、授权、成果可达性作差分。切回旧入口仅改变导航；新任务和运行记录保留可恢复。迁移试运行、故障注入、切换和回退均先在数据副本验证。

## Acceptance

| ID | Condition | Verification | Pass condition |
|---|---|---|---|
| A-001 | 追踪长期会话中的独立工作 | 在测试 research 连续登记两个不同目标，重复登记原消息，分别交付两版文件再重开旧任务 | 两个任务；新增 Agent 输入为零；旧任务仍指向原消息和原版本。 |
| A-002 | session 身份及输入安全 | 切到另一会话、重建同名 session、延迟送达旧事件，再从任务尝试回答 | 旧记录可读，错误 thread 收到零输入；绑定目标经核实后可操作。 |
| A-003 | 规则能解释每次运行 | 对同一规则试算、空检查、同一公告重复、下一个新公告、忙碌与暂停；在派发边界重启 | 试算和无变化唤醒模型零次；每个新公告至多一次自动派发；未知回执可查；暂停不终止在途任务。 |
| A-004 | Bot 是长期入口 | 将 Bot 绑定到既有 research，从两个入口进入；另开任务并解除绑定 | 两个入口对应原 thread；独立任务不改主对话草稿或执行现场；解除后两者历史可访问。 |
| A-005 | 待决、结果和进程状态各自可信 | 让 session 空闲、后台、报错；分别在网页与模拟 Telegram 对同一问题作答，回看成果 | 空闲不生成已交付；重复确认只处理一次；待决角标随真正解决而清除；结果展示对应版本、依据和未核验项。 |
| A-006 | 双模式好用 | 普通与 Remote 各跑 390px、1365px；用鼠标、键盘走完“找任务、回答、看成果、返回草稿”，模拟掉线/重连 | 无横向溢出、误展开或误发；焦点和草稿可恢复。记录失败步骤、操作数、截图和修订后复测。 |
| A-007 | 迁移可回退 | 在旧版数据副本上启用新入口两次，再切回；分别用 owner 和分享凭据核对 | 无丢失、重复派发或越权读取；原有未处理事项和开关可找回，新产生记录可保留。 |

## Plan

下表是已确认的开发顺序。第一条纵向切片先证明“找得到、回得去、不会重发”，再接入派工。

| Node | Status | Action | Verification | Evidence | Reflection |
|---|---|---|---|---|---|
| NODE-001 | 完成 | 盘点旧入口的全部操作、Provider 能力与旧档样本；建立隔离会话及迁移基线，用动线样稿核实观察点。 | A-002、A-006、A-007 的旧行为、截图、输入计数和只读快照。 | fd674af 上旧行动台四种浏览器组合通过；迁移旧文件身份在 test/workstation-migration.test.js 核对。 | None |
| NODE-002 | 完成 | 接在 001 后，打通消息登记 → Tasks → 对应版本成果 → 原会话。先落实任务身份与来源，再接 UI。 | A-001、A-002；过期链接与未绑定来源的负例。 | test/workstation-tracking.test.js：双击同一消息唯一、同一会话两个任务、历史 v1 与当前 v2 分离、重建后仍可下载。 | None |
| NODE-003 | 完成 | 接在 002 后，汇聚待答与审批，接入便签和 Telegram 已有处理接口。 | A-005；刷新、先读后答、两端同时答。 | test/agent-connection.test.js、test/telegram-session-adapter.test.js：网页和模拟 Telegram 同时回答只生效一次，拒绝过期身份及被复用的请求 ID。 | R-001 |
| NODE-004 | 完成 | 基于 002 的任务关系实现 Bot 建立、主对话和任务分组；自动规则可先绑定 Session。 | A-004、A-002；源会话忙碌、被替换或只读。 | test/workstation-tracking.test.js：打开主对话、解绑仍保留任务、私有偏好只影响所属 Bot；两种界面的导航和设置在浏览器样例核实。 | None |
| NODE-005 | 完成 | 复用调度器显示规则与运行历史；接 002 的任务，接 004 的可选 Bot 执行目标。 | A-003、A-005；检查、派发、收到回执分开观察。 | test/workstation-automations.test.js、test/conditional-tasks.test.js：试算、无变化、重复公告、独立启动、忙碌跟进、启停、重启、未知回执各自验证。 | None |
| NODE-006 | 完成 | 汇合 003–005。迁移所有旧入口、补空态/异常态，用原型和实装对比普通与 Remote 四套路径。 | A-006、A-007；每个影响操作的体验问题有修订前后证据。 | scripts/always-on-browser-smoke.mjs、test/workstation-migration.test.js：实际双模式四种屏宽组合通过，原始存档副本双次初始化及回读一致，导航产生零次 Agent 输入。 | R-002 |
| NODE-007 | 完成 | 编写最短使用指南，完整跑投研样例、权限和重启场景，演练回退，准备评审与交付。 | A-001 至 A-007 的实际版本、日志、截图、未验范围与操作指南。 | docs/workstation.md、scripts/always-on-browser-smoke.mjs；最终全量结果见交付记录。 | None |

### 现有依据与验收入口

- 当前 UI 和数据所有者见[行动台](../../../public/always-on-panel.js)、[进度便签](../../../src/session-checkpoints.js)、[事件与定时存储](../../../src/always-on-store.js)、[条件调度](../../../src/conditional-tasks.js)、[工作文件及版本](../../workfiles.md)。旧验收记录见[行动台 v2](../always-on-v2/program.md)。
- [交互样稿](/home/x/.codeck/uploads/workstation-design-NC48Cm/workstation.html)及同目录 390.png、1365.png 是本机参考。样稿使用合成数据，尚未验证持久化、真实授权、派工与跨端一致性。以上交互约定为跨机器可读的依据。
- 参考 Orca 的 [Bots](https://orca.dev/docs/bots)、[Automations](https://orca.dev/docs/cli/automations)、[Tasks](https://orca.dev/docs/review/github)。具体会话身份和权限以 Codeck 为准。
- 现有基线命令：`node --test test/session-checkpoints.test.js test/remote-identity.test.js test/workfiles.test.js test/conditional-tasks.test.js test/always-on-control-plane.test.js test/always-on-ui-and-routes.test.js test/telegram-routing.test.js`。UI 基线为 `node scripts/always-on-browser-smoke.mjs`，按仓库 README 配置 Playwright。后续在实际改动处扩展断言，收尾执行 `npm test`。前一任务的会话验收脚本仍属独立工作区改动，接入前先核对版本。
- 人工体验评审关注三个判断：第一次能否找到待决问题、能否知道答案发往哪里、能否找回昨天的成果。记录哪一步让人犹豫，优先改标签、层级或返回行为，再以相同任务复测。代码检查与浏览器结果分别留证。
- 恢复工作时先读本页元数据及最近有据的节点，核对工作区，再从下一项继续。上线前将未验证平台及迁移差异明确列入交接。

## Reflection Log

| ID | Scope | Evidence | Wrong / changed | Right / preserve | Next rule |
|---|---|---|---|---|---|
| R-001 | NODE-003 | 跨端并发和延迟答复测试 | 同一个 provider 可在新 thread 上复用请求 ID。 | 最终输入边界核对 thread，并沿用 AgentHub 原有去重。 | 将旧问题晚到保留为独立回归。 |
| R-002 | NODE-006 | 浏览器断线与返回用例 | 重连覆盖导航记录会丢失工作台的返回位置。 | 同一份终端和草稿保持挂载。 | 切入工作台后模拟断线，再回会话核对草稿。 |

## 交付核验

2026-11-22 完成本地开发与隔离验收。基线提交为 `fd674af`。本次更改及新增的 public、src 文件的清单和内容合并 SHA-256 为 `475f5afc1c7f67a9c32f531aac19b934001767f7e15e93c10be7892926f9daa3`。使用方法已写入[工作台指南](../../workstation.md)。

- A-001、A-002、A-004、A-005 已在持久化存储和实际 HTTP 路由核对。两个事项可同属一个 research；替换会话身份后，原任务可读、原版本可下载。同一个审批从网页和模拟 Telegram 同时作答只处理一次。
- A-003 用真实 SQLite 调度器验证重复保存、重复事件、无变化、执行中暂停、租约过期和未知回执。仅实际输入回执可更新为确认，迟到的原会话可补绑。另以临时 tmux server 和替身 CLI 核对多行派工原文和建会话次数。相关用例见[自动化回归](../../../test/workstation-automations.test.js)。
- A-006、A-007 已用同一条投研流程走过普通与 Remote 的 390px 和 1365px 页面。浏览器实际下载旧版本文件，断线重连后找回草稿；在规则已入库、响应丢失时重试仍只有一条。旧导航可切回，访客无法列出 owner 的任务或规则。旧数据库副本连续初始化两次再切回的结果见[迁移测试](../../../test/workstation-migration.test.js)。
- 交付版本全量单测 1,404 项通过，见[运行日志](/home/x/.codeck/uploads/workstation-verification-sbpuq4b4/unit.log)，四组浏览器记录和实测图见[浏览器日志](/home/x/.codeck/uploads/workstation-verification-sbpuq4b4/browser.log)、[桌面任务页](/home/x/.codeck/uploads/workstation-verification-sbpuq4b4/normal-1365-tasks.png)、[手机试算](/home/x/.codeck/uploads/workstation-verification-sbpuq4b4/remote-390-rule.png)。服务正式入口用临时目录独立启动，经 HTTPS 读取工作台、待处理、规则、旧概览四个接口均为 200。
- 隔离验收使用模拟的外部 Agent 和 Telegram。真实云端回复、线上存档和长期定时执行留给生产发布后的验证。生产服务保持现有版本。
