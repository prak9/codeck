# 进度、条件任务和成果反馈

进度便签和待处理提示显示在普通/Remote 侧栏。`codeck session checkpoint NAME --file NOTE.txt` 更新当前会话的简短进度，鼠标悬停显示更新时间。`codeck session list --json` 可读同一信息。便签不是实时推断，Agent 必须主动更新；已有会话不会被额外注入提示。

提醒区分“需要回答”“本轮有新结果”“待你查看”。从工作转为空闲仅标记本轮新结果，不证明目标完成。点击会话只清除当时那条结果提醒，问题保持到实际处理。冷启动遇到已空闲会话不会凭空生成完成提示。记录绑定 tmux 创建时间与 Agent 身份，重建同名会话不会继承。Telegram 继续沿用原有提问/轮次结束通知。

条件任务通过 `codeck task list|put|remove` 管理，详细格式见 [Skill 说明](../skills/codeck/references/conditional-tasks.md)。不新增调度面板，也不预装任何实际任务。预检查只决定是否派发，不代表执行成果；同一任务串行，未知投递不重放。

独立开发工作区：

```sh
codeck session create task-one --provider codex --cwd /data/code/project --worktree /data/code/project-task-one
```

从已提交 HEAD 创建 detached worktree，不移动当前分支、不复制脏文件。不自动共享依赖、密钥、数据库或端口。需要提交分支时在工作区自行 `git switch -c`。创建会话失败也保留工作区，先核实再清理；Codeck 删除会话不会删除该工作区。

发布页点击右上角“批注”，再点段落或选择文字，填写反馈并保存。可积累多条后点击“发送待处理批注”。每条保留引用、段落位置、内容摘要、版本和来源会话；页面更新后旧批注仍可读，明确显示旧版本。成功提交不自动标为已解决，审阅后手工解决/重新打开。已投递批注不会再次发送；新增反馈请新建批注。

分享访客不可批注或派发。HTML 继续是 opaque-origin sandbox，不能读取父页面/凭据或调用 API。iframe 消息只能填入待编辑引用；存储和发送都必须在所有者页面明确点击。来源会话发生替换时拒绝派发给新身份。未知 ACK 留下记录，不能把刷新页面当作重试。

## iPhone 入口

Safari 打开 Codeck HTTPS 地址并登录，选择分享→添加到主屏幕。入口默认打开 Remote，可切回终端模式；仍使用同一服务和授权。manifest、主屏幕图标与 standalone 配置已提供，没有 Service Worker 离线缓存，因此不会缓存旧终端数据或离线排队输入。需要可达服务器和受信任的 HTTPS 证书。

此版是主屏幕 Web App，不是已签名的原生 iOS App；未接 Web Push，后台提醒仍由 Telegram 承担。独立 SwiftUI/WKWebView 外壳可复用 API，但需要 macOS/Xcode、签名和真机验证后才可交付 TestFlight。

Apple 资料：[主屏幕 Web Push](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers)、[SwiftUI WebKit](https://developer.apple.com/documentation/webkit/webkit-for-swiftui)。本次未在 iPhone 真机验证。
