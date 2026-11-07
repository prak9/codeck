# 历史搜索与成果证据

普通模式和 Remote 侧栏的“搜索历史内容”打开同一个轻量搜索框。输入关键词可找到已关闭会话的正文，点击结果查看前后上下文；历史资料不自动代表当前事实。当前是字面关键词检索，不是模型语义问答，不为搜索启动 Agent。

索引读取本机配置下的 Codex sessions/archived_sessions、Claude projects 和 Qoder projects JSONL。仅提取用户/助手正文，不索引工具输出、思考内容、图片或 sidechain。旧分支对话可能仍存在于原始日志中，结果是存档片段，不声明属于当前活动分支。上下文显示相邻文本片段，长消息按4000字符分片，200字符重叠；搜索结果按来源消息去重。

首次搜索触发后台索引，期间显示进度与“结果尚不完整”；后续搜索最多每15秒触发一次文件变化检查。未变化文件不解析，追加只读新内容。重写/缩短文件重建对应记录，删除文件移出索引。文件头/尾局部检查依赖 provider 的追加日志约定，不能检测所有人为原地篡改情形。未完成的末行等待后续写入；超过16MiB的单条JSON或损坏记录跳过并显示数量，不静默宣称完整。1–2字符查询使用索引库字面扫描，较长词用 FTS trigram。

索引在独立 worker，使用当前 Node 22 自带 SQLite（此运行时仍带 experimental 提示），没有新增 npm 依赖；目录 `~/.codeck/history-search` 权限0700，仅主Token可检索。索引包含私有对话，请按会话数据保护；它不提供给分享访客，源 transcript 不修改。无离线远程云索引或外部数据上传。

## CLI 与 Git 关联

```sh
codeck history search '历史读取' --provider codex --json
codeck history context RESULT_ID --json
codeck history link research --repo /data/code/project --commit COMMIT_SHA
codeck history link THREAD_ID --provider codex --repo /data/code/project --commit COMMIT_SHA
```

最后一种用于已关闭会话。界面也可在上下文下方填写项目路径和提交号。正文候选提交号明确标为未核验；关联时执行只读 Git 查询，确认该项目中提交实际存在，保存完整 SHA、标题和关联时间。关联表示用户/Agent 显式声明的来源关系，不证明该提交通过测试，也不自动判断因果关系。当前不读取远端 GitHub 或自动拉取提交。

## 成果证据

发布时添加 `--evidence evidence.json`：

```json
{
  "version": "实际代码版本或资料标识",
  "summary": "实际已验证的成果",
  "checks": [
    {"method": "浏览器执行核心操作", "result": "passed", "reference": "证据文件或页面地址"}
  ],
  "limitations": ["尚未进行真机验证"]
}
```

`result` 可为 `passed`、`failed`、`not-run`。只填写实际执行的检查。页面服务会绑定当前 HTML 摘要与记录时间；HTML或来源版本变化而未附新记录时清除旧记录，避免旧验证被误认为覆盖新版本。显式 `evidence:null` 可清除记录。

所有者在发布页“版本与验证”中展开查看。此区域为提交者提供的声明，不是服务自动执行测试；没有列出限制不等于全部验证通过。本地路径仅以文本显示，不开放任意文件下载。分享页默认不附这些内部元数据；如需对外展示证据，由发布者明确将可公开证据写入页面正文。
