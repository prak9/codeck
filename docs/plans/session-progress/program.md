# Program: 简洁进度与可靠会话恢复

- Overall status: `完成`
- Profile: `Lite`
- Contract status: `Confirmed`
- Active plan node: `None`
- Latest evidence: `/tmp/codeck-progress-release.log`；`/tmp/codeck-progress-live-browser.log`
- Current blocker: `None`
- Next step: `None`
- Next checkpoint: `None`
- Next human decision: `None`
- Owner: `AI`
- Last updated: `2026-11-10`

## Outcome

- Problem: 运行状态与工作成果混杂，临时身份丢失清空内容，A入口与自然语言任务重复。
- Success: 普通与Remote移除A入口；提供可展开进度、真实待处理事项与证据；临时失联保留可靠记录并保护发送。
- Collaboration intent: delivery；关键判断与授权仍由用户通过原对话完成。
- Non-goals: 不创建总控面板或多Agent编排；不向真实会话注入任务。

## Constraints

- Strategic defaults: 最小修改、行为回归、现有深色设计、保留未知改动。
- Tactical objective: 可信且简洁的任务记录，独立于实时运行状态。
- Imperative bounds: 不自动改变目标、预算、权限或真实Agent任务。
- Negotiable space: 字段、兼容旧文本便签及共享组件实现。
- Material assumptions: 第一版通过显式Agent CLI更新便签，不额外调用模型提取或自动续跑。
- Active unknowns: 既有A控制器依赖与失联恢复路径，通过调用点和回归测试确定。
- Escalate when: 必须扩大授权或修改真实任务。

## Acceptance

| ID | Condition | Verification | Pass condition |
|---|---|---|---|
| A-001 | 任务记录可更新并跨临时身份丢失保留 | 后端隔离测试 | 记录不删除、不串会话，明确标注旧归属 |
| A-002 | 两种界面便签可展开、A不可见 | 浏览器与DOM测试 | 状态、进度、证据分离，无溢出 |
| A-003 | 身份待确认保留历史并保护发送 | UI迟到回包及重连测试 | 旧内容有标识，不向错误身份投递 |

## Plan

| Node | Status | Action | Verification | Evidence | Reflection |
|---|---|---|---|---|---|
| NODE-001 | `完成` | 进度模型、归属保留与CLI | 后端及CLI测试 | /tmp/codeck-progress-slice.log；/tmp/codeck-progress-storage.log | None |
| NODE-002 | `完成` | 两种界面进度便签与A入口移除 | DOM与浏览器 | /tmp/codeck-progress-normal-browser.log；/tmp/codeck-progress-remote-browser.log | None |
| NODE-003 | `完成` | 断线身份恢复、回归部署与文档 | 跨层测试及服务核验 | /tmp/codeck-progress-release.log；/tmp/codeck-progress-live-browser.log | None |

## Reflection Log

| ID | Scope | Evidence | Wrong / changed | Right / preserve | Next rule |
|---|---|---|---|---|---|

## 交付与边界

2026-11-10，第一版已部署，尚未提交推送。全套1306项测试通过；普通与Remote在390/1365下对Codex、Claude、Qoder均验证便签、问号/确认、无A入口和草稿保留；完整Remote流程包含历史、模型菜单、审批、重连与布局。当前真实codeck记录由新版CLI写入，页面可展开，历史20→40轮，无消息/中断指令。

任务便签来源是Agent显式CLI更新，相关Skill和问号/确认提示词已更新；没有后台模型自动提炼或周期巡检。新任务通过newTask显式归档；身份变化仅显示历史归属，不冒充新任务进展。未知身份下保留同一session实例的已读记录，保护结构化发送，恢复原thread时保留已加载早期历史；其他thread不合并。

旧A控制器接口仍留作既有协议实现，但两种界面已无A入口，不新建自主run。没有向真实Agent发送任务或终止原任务；只更新本次codeck任务自己的便签。测试子进程、临时浏览器和私有服务已关闭，截图与测试日志保留作证据。部署前checkpoint备份位于~/.codeck/backups/checkpoints-before-progress-20261110.json。

### 入口可见性复核

用户反馈看不到摘要，确认其位于聊天滚动区内而随最新消息滚动消失。已将Remote便签移到标题下方独立行，不占用无记录会话空间。42项样式/组件测试及三provider两视口滚动到最新验证通过；真实codeck页面入口y=75，展开及20→40轮分页通过，无消息写入。证据：/tmp/codeck-progress-fixed-position.log、/tmp/codeck-progress-position-live.log。已部署未提交。

### 用户最终布局偏好

用户取消Remote顶部常驻便签，改为点击侧栏进度摘要进入对应session后弹出按需详情；关闭后不占聊天空间。键盘在当前会话行确认也可打开，回到对话动作关闭详情再聚焦输入。普通模式保持既有便签位置。三provider、手机与桌面验证通过：/tmp/codeck-progress-dialog-browser.log。
