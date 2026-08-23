const COMMANDS = Object.freeze({
  codex: Object.freeze([
    ['/status', '查看会话配置、模型和用量'],
    ['/statusline', '配置终端状态栏'],
    ['/model', '选择模型和推理强度'],
    ['/permissions', '调整 Agent 操作权限'],
    ['/skills', '查看和使用 Skills'],
    ['/review', '审查当前工作区改动'],
    ['/diff', '查看 Git 差异'],
    ['/compact', '压缩较长的对话上下文'],
    ['/new', '在当前 CLI 中开始新对话'],
    ['/resume', '恢复已保存的对话'],
    ['/rename', '重命名当前会话'],
    ['/fork', '从当前会话创建分支'],
    ['/copy', '复制最近的 Agent 输出'],
    ['/export', '将对话导出为 Markdown'],
    ['/raw', '切换便于复制的原始回滚视图'],
    ['/init', '为项目创建 AGENTS.md'],
    ['/plan', '切换 Plan 模式'],
    ['/goal', '设置或查看长期任务目标'],
    ['/agents', '查看和切换 Agent 会话'],
    ['/side', '开始不影响主线程的临时对话'],
    ['/mention', '引用项目文件'],
    ['/usage', '查看账户用量'],
    ['/ps', '查看后台终端任务'],
    ['/stop', '停止后台终端任务'],
    ['/mcp', '查看已配置的 MCP 工具'],
    ['/apps', '管理 Apps'],
    ['/plugins', '浏览 Plugins'],
    ['/personality', '选择 Agent 沟通风格'],
    ['/theme', '选择终端高亮主题'],
    ['/cd', '切换当前工作目录'],
    ['/feedback', '向维护者发送反馈'],
    ['/quit', '退出 Codex'],
  ]),
  claude: Object.freeze([
    ['/status', '查看版本、模型和账户状态'],
    ['/statusline', '配置终端状态栏'],
    ['/model', '选择当前模型'],
    ['/permissions', '查看或调整工具权限'],
    ['/tasks', '查看和管理后台任务'],
    ['/agents', '管理自定义子 Agent'],
    ['/diff', '打开当前改动的差异视图'],
    ['/doctor', '诊断 Claude Code 安装'],
    ['/effort', '设置模型推理强度'],
    ['/compact', '压缩对话上下文'],
    ['/clear', '清空当前对话'],
    ['/resume', '恢复之前的对话'],
    ['/branch', '从当前对话创建分支'],
    ['/context', '查看上下文占用'],
    ['/init', '为项目创建 CLAUDE.md'],
    ['/plan', '进入计划模式'],
    ['/review', '审查当前代码改动'],
    ['/security-review', '执行安全审查'],
    ['/simplify', '检查并简化近期改动'],
    ['/mcp', '管理 MCP 服务器'],
    ['/memory', '编辑项目记忆文件'],
    ['/skills', '查看可用 Skills'],
    ['/hooks', '管理生命周期 Hooks'],
    ['/plugins', '管理 Plugins'],
    ['/export', '导出当前对话'],
    ['/rewind', '回退对话或文件改动'],
    ['/background', '将任务移到后台'],
    ['/batch', '并行处理多个任务'],
    ['/remote-control', '启用远程控制'],
    ['/teleport', '接管远程会话'],
    ['/debug', '排查当前会话问题'],
    ['/feedback', '提交 Claude Code 反馈'],
    ['/help', '查看帮助'],
    ['/stop', '停止后台任务'],
    ['/quit', '退出 Claude Code'],
  ]),
  qodercli: Object.freeze([
    ['/status', '查看账户和 CLI 状态'],
    ['/statusline', '配置终端状态栏'],
    ['/model', '选择当前模型'],
    ['/permissions', '查看或调整工具权限'],
    ['/tasks', '查看当前任务'],
    ['/agents', '管理自定义 Agent'],
    ['/diff', '查看当前代码差异'],
    ['/review', '审查当前代码改动'],
    ['/compact', '压缩对话上下文'],
    ['/clear', '清空当前对话'],
    ['/resume', '恢复之前的会话'],
    ['/continue', '继续最近的会话'],
    ['/new', '开始一个新会话'],
    ['/rename', '重命名当前会话'],
    ['/branch', '从当前会话创建分支'],
    ['/export', '导出当前会话'],
    ['/copy', '复制最近的 Agent 输出'],
    ['/rewind', '回退会话或文件改动'],
    ['/effort', '设置模型推理强度'],
    ['/fast', '切换快速模式'],
    ['/context-window', '设置上下文窗口'],
    ['/plan', '进入计划模式'],
    ['/goal', '设置或查看任务目标'],
    ['/loop', '配置循环执行'],
    ['/quest', '管理 Quest 工作流'],
    ['/workflows', '管理工作流'],
    ['/kanban', '查看任务看板'],
    ['/init', '初始化项目指导文件'],
    ['/setup-github', '配置 GitHub 集成'],
    ['/settings', '打开 CLI 设置'],
    ['/theme', '选择终端主题'],
    ['/editor', '配置外部编辑器'],
    ['/vim', '切换 Vim 输入模式'],
    ['/shortcuts', '查看键盘快捷键'],
    ['/mcp', '管理 MCP 服务器'],
    ['/tools', '查看可用工具'],
    ['/skills', '查看可用 Skills'],
    ['/hooks', '管理生命周期 Hooks'],
    ['/commands', '查看内置和自定义命令'],
    ['/plugins', '管理 Plugins'],
    ['/marketplace', '浏览扩展市场'],
    ['/memory', '管理项目记忆'],
    ['/debug', '排查当前会话问题'],
    ['/verify', '验证本轮工作结果'],
    ['/simplify', '检查并简化近期改动'],
    ['/security-scan', '执行安全扫描'],
    ['/run', '运行项目任务'],
    ['/batch', '批量执行任务'],
    ['/remember', '保存重要上下文'],
    ['/login', '登录 Qoder 账户'],
    ['/logout', '退出 Qoder 账户'],
    ['/profile', '查看账户资料'],
    ['/usage', '查看账户用量'],
    ['/remote-control', '启用远程控制'],
    ['/remote-env', '配置远程环境'],
    ['/add-dir', '添加可访问目录'],
    ['/context', '查看上下文占用'],
    ['/docs', '打开 Qoder 文档'],
    ['/help', '查看帮助'],
    ['/about', '查看 QoderCLI 信息'],
    ['/quit', '退出 QoderCLI'],
  ]),
});

const COMMAND_TOKEN = /^\/[^\s]*$/;

function commandEntries(provider) {
  return (COMMANDS[provider] || []).map(([command, description]) => ({ command, description }));
}

export function slashCommandSuggestions(provider, value, limit = 8) {
  if (!COMMAND_TOKEN.test(value || '')) return [];
  const query = String(value).toLowerCase();
  return commandEntries(provider)
    .filter(({ command }) => command.startsWith(query))
    .slice(0, Math.max(0, limit));
}

export function slashCommandMenuAvailable({ provider, tmuxSession }) {
  return Boolean(COMMANDS[provider] && typeof tmuxSession === 'string' && tmuxSession.trim());
}

export function completeSlashCommand(value, command) {
  if (!COMMAND_TOKEN.test(value || '') || !/^\/[^\s]+$/.test(command || '')) return value;
  return command;
}

export function nextSlashCommandIndex(index, count, direction) {
  if (count < 1) return -1;
  if (index < 0 || index >= count) return direction < 0 ? count - 1 : 0;
  return (index + direction + count) % count;
}

export function slashCommandKeyAction({ key, value, suggestions, activeIndex }) {
  if (!suggestions.length) return null;
  if (key === 'Escape') return { type: 'close' };
  if (key === 'ArrowDown' || key === 'ArrowUp') {
    return {
      type: 'select',
      index: nextSlashCommandIndex(activeIndex, suggestions.length, key === 'ArrowDown' ? 1 : -1),
    };
  }
  const selected = suggestions[activeIndex] || suggestions[0];
  if (key === 'Tab') return { type: 'complete', command: selected.command };
  if (key === 'Enter' && value !== selected.command) {
    return { type: 'complete', command: selected.command };
  }
  return null;
}
