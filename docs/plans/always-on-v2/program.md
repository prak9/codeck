# Program: Codeck Always-On v2：目标蓝图、引导建档与反馈进化

> Single-file current-state plan for implementing Goal Blueprints, Codeck Architect (guided onboarding + Dry-Run), Entity Key cross-source correlation, Feedback Improvement Proposals, and Micro-Collector pages across both 普通模式 and Remote 模式.

- Overall status: `完成`
- Profile: `Lite`
- Contract status: `Confirmed`
- Active plan node: `None`
- Latest evidence: `/tmp/codeck-always-on-v2-full.log`（1385/1385 通过）；`/tmp/codeck-always-on-v2-browser.log`（普通/Remote × 390/1365 四象限通过）
- Current blocker: `None`
- Next step: `None`
- Next checkpoint: `None`
- Next human decision: `None`
- Owner: `AI`
- Last updated: `2026-11-20`

## Outcome

- Problem: Always-On v1 已具备底层五大原语（Inbox / Timers / Memory / Permissions / Outbox），但缺少面向业务的“目标蓝图（Goal ≠ Process）”、低门槛访谈式建档与异常演练（Codeck Architect）、跨源稳定实体 ID 关联（Entity Key）、反馈驱动的流程改进提案，以及缺数据时的轻量采集页。
- Success: 在不破坏现有 1382 项测试与双端克制布局的前提下，落地全部 5 项 v2 能力，同时支持普通模式（`index.html`）与 Remote 模式（`remote.html`）及 390px/1365px 双视口；全量回归与真实 Chromium 浏览器 smoke 通过。
- Collaboration intent: delivery；用户已明确授权“直接规划完成开发”，全流程自主推进，不未经授权修改生产配置或触碰真实用户会话。
- Non-goals: 不引入外部数据库或中间件；不静默自动修改用户 Blueprint（所有改进提案须人工采纳）；不向真实用户 tmux 会话发送测试消息；不覆盖历史计划文档。

## Constraints

- Strategic defaults: 复用 Node 22 内置 SQLite（`super-agent.db`）、`~/.codeck/memory/` 白盒目录与既有 `always-on-panel.js` 双端弹窗；所有新增 `/api/always-on/*` 接口强制 `ownerOnly`；改前端模块同步推高 `app.js?v=` / `remote.js?v=` 与缓存指纹。
- Tactical objective: 降低从 0 到 1 创建高可靠自动化的门槛（先谈清、先演练、再上线），并让历史反馈通过稳定 `entity_key` 沉淀为可审计的改进提案。
- Imperative bounds:
  - **双模式支持**：普通模式与 Remote 模式共享同一套行动台能力，Remote 不新增常驻顶栏占高。
  - **安全与人机门控**：Architect 建档默认先 Dry-Run / 确认后再启用；改进提案绝不静默生效；微型采集页仅 owner 可提交且零外部脚本依赖。
  - **无损兼容**：保持 v1 既有表结构与 API 向后兼容。
- Negotiable space: SQLite 新增表列细节、Architect 启发式规则与问题模板、Dry-Run 报告字段格式、微型采集页内联样式。
- Material assumptions: 语音脑暴复用浏览器原生 `SpeechRecognition` / `webkitSpeechRecognition`，不支持的浏览器自动隐藏麦克风按钮并保留纯文本输入。
- Active unknowns: None。
- Escalate when: 需要改动线上 systemd/Nginx 配置、放宽 owner 鉴权边界或发现既有测试无法兼容时暂停请示。

## Acceptance

| ID | Condition | Verification | Pass condition |
|---|---|---|---|
| A-001 | Goal Blueprint 与 Entity Key 跨源关联持久化及 CLI 可用 | SQLite 单元测试 + CLI 集成测试 | Blueprint 完整保存 6 段结构并镜像至 `memory/blueprints/`；`entity_links` 按 `entity_key` 准确聚合跨源时间线 |
| A-002 | Codeck Architect 支持脑暴拆分、逐题访谈、异常案例与只读 Dry-Run | Architect 单元与隔离演练测试 | 能识别 Goal/Process 混淆并生成单题访谈队列；Dry-Run 零外部副作用、不发真实 Outbox、输出可执行预判报告 |
| A-003 | 反馈改进提案与微型采集页闭环可靠 | Feedback & Collector 集成测试 | 提案可基于失败/拒绝/批注生成且去重；采纳后原子更新 Blueprint 版本并记入 `entity_links`，拒绝后写入 `notes/` 防重复；采集页零外部脚本且提交写入 Inbox + `entity_links` |
| A-004 | 普通模式与 Remote 模式双端升级且严格 owner 隔离 | 全套 `/api/always-on/*` 403 审计 + 双模式双视口 Chromium smoke | 两端均可使用目标蓝图、Architect 向导、Dry-Run、改进提案采纳与实体时间线；分享访客全部 403；零页面报错 |
| A-005 | 全量回归零退化 | `npm test` + `validate_plan.py --strict` | 全部单元/集成/缓存指纹测试通过，计划严格校验 `PASS` |

## Plan

| Node | Status | Action | Verification | Evidence | Reflection |
|---|---|---|---|---|---|
| NODE-001 | `完成` | 扩展 `always-on-store.js`（`blueprints` / `entity_links` / `proposals` 表）、`always-on-memory.js`（`blueprints/*.md` 镜像）与 `codeck-client.js`（blueprint / entity / proposal CLI） | 存储与 CLI 单元测试 | `/tmp/codeck-always-on-v2-unit.log`（3/3 通过） | None |
| NODE-002 | `完成` | 实现 `src/always-on-architect.js`（脑暴拆分 Goal/Process、逐题访谈队列、异常案例预演、一键实例化与只读 Dry-Run 沙盒） | Architect 与 Dry-Run 无副作用测试 | `/tmp/codeck-always-on-v2-unit.log`（含过程混淆预警、单题访谈、零副作用 Dry-Run 验证） | None |
| NODE-003 | `完成` | 实现 `src/always-on-feedback.js`（跨源反馈归因、改进提案生成与采纳/拒绝闭环、微型采集页 HTML 生成与提交入队） | Feedback 提案闭环与 Collector 测试 | `/tmp/codeck-always-on-v2-unit.log`（去重提案、原子采纳升版、拒绝记入 notes、零外部脚本采集页通过） | None |
| NODE-004 | `完成` | 扩展 `src/always-on-routes.js`、`src/server.js` 及双端 `public/always-on-panel.js/.css`（支持语音脑暴、蓝图/提案/时间线交互，同步推高 `app.js?v=172` / `remote.js?v=161`） | 双端 API 403 审计与双视口 Chromium smoke | `/tmp/codeck-always-on-v2-unit.log`（非 owner 全 403）；`/tmp/codeck-always-on-v2-browser.log`（normal/remote × 390/1365 全通过） | None |
| NODE-005 | `完成` | 跑通全量 `npm test`、双模式双视口浏览器回归与 `validate_plan.py --strict`，完成收口记录 | `npm test` + Chromium smoke + strict validate | `/tmp/codeck-always-on-v2-full.log`（1385/1385 通过）；`/tmp/codeck-always-on-v2-browser.log` | None |

## Reflection Log

Add `R-*` only when evidence changes an assumption, plan, verifier, scope, or reusable rule. For routine success with no trigger, use explicit `None` in the Plan row.

| ID | Scope | Evidence | Wrong / changed | Right / preserve | Next rule |
|---|---|---|---|---|---|

## 交付与边界

2026-11-20 完成 Always-On v2 全部 5 个节点开发与独立验证；**尚未 git 提交/推送，未重启线上 Codeck 服务，未向真实用户会话发送消息**。

- **新增模块**：`src/always-on-architect.js`、`src/always-on-feedback.js`、`test/always-on-v2.test.js`。
- **升级模块**：`src/always-on-store.js`、`src/always-on-memory.js`、`src/always-on-routes.js`、`src/server.js`、`src/codeck-client.js`、`public/always-on-panel.js`、`public/index.html`、`public/remote.html`、`public/app.js`、`public/remote.js`、`scripts/always-on-browser-smoke.mjs`。
- **缓存版本**：`app.js?v=172`（指纹 `e30b5b99eba29462`）、`remote.js?v=161`。
