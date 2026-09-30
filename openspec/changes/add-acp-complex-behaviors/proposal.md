## Why

`add-builtin-acp-runtimes` 让 Claude Code、Codex、Pi 以 ACP 运行，但工作台只投影了文本、思考、工具与计划。
三个适配器实际还会发送子智能体会话、后台任务、表单问答、目标（goal）与 MCP/Computer Use 工具调用；
这些要么被 `AcpConnection` 按 sessionId 丢弃，要么被 SDK 1.4 的 schema 校验拒收，要么被投影忽略：

- 子智能体的工具与文本不可见（Claude 在未声明能力时把它们压平到根会话，声明后则发往子 sessionId）。
- 后台 Bash / workflow 的生命周期与停止入口缺失，回合外的更新（后台完成、目标变化）被整体丢弃。
- Claude `AskUserQuestion`、Codex `request_user_input`、Pi 提问没有应答界面。
- `tool_call_update.title` 覆盖 `toolName`，把 `Read` 改成 `Read foo.ts`，渲染器身份错乱（缺陷）。

## What Changes

- P0 基础：修复工具身份（`name`/`_meta.claudeCode.toolName` 一次确定，kind 回退，MCP 命名
  `mcp__<server>__<tool>` + `display.kind="mcp_tool"`，结构化 `input`）；转录 update 条目增加可选
  `sessionId`（旧条目按根会话读取）；生命周期更新可在回合外应用；回合外 Agent 内容按“后台结果展示轮”策略
  展示或丢弃；ACP 扩展更新（`subagent_*`、`async_task_*`、`_meta.lody.task`、goal meta）以 zod 运行时校验，
  非法即丢弃并记 debug 日志。
- P1 子智能体：声明 `clientCapabilities.subagents`；连接级子会话登记表只接纳已宣告子 sessionId 的更新、
  权限与表单；根投影合成宿主 `Agent` toolCall + `subagent` 行，子会话以只读虚拟 id
  `<rootTaskId>::acp-subagent::<S>` 经现有 `SubagentSessionSidePane` 打开；`snapshot.subagents`、
  权限 `origin.kind="subagent"`、`listSessionSubagents` 对 ACP 根会话生效。Pi 的 `_meta.lody.task`
  生命周期投影为与 Pi `subagent` 工具行配对的 `subagent` 行，并在 Agent 公布时经 `_lody/subagents/cancel` 停止。
- P2 后台任务与问答：声明 AIR `asyncTasks`，`async_task_*` → `snapshot.backgroundWorks`（`kind:"bash"`）、
  工具行 `backgrounded`，`cancelBackgroundWork` → `_session/async_task/stop`。声明 `elicitation.form`，
  `elicitation/create` → `pendingInteraction kind:"userInput"`（`questions[]`），`resolveInteraction` 回传
  `{action:"accept", content}`；停止/退出时以 `cancel` 收口。
- P3 目标：`session_info_update._meta.goal` → `snapshot.goal`（回合内变化追加 `goalSet` 标记）。
- P4 Computer Use：仅把 Codex 服务名含 `computer-use` 的 MCP 工具映射为 `mcp__computer-use__<tool>`，
  复用现有 `CuaToolCallBlock`，并在输出 display 中保留有界截图。`@zcode/zcode-cua` 是失败即关闭的占位包，
  本变更不向 ACP Agent 注入 ZCode Computer Use。Claude `workflow` 类后台任务只映射为 `backgroundWorks`，
  ZCode 动态工作流引擎不对 ACP Runtime 开放。

## Capabilities

### Modified Capabilities

- `acp-conversation`: 子智能体、后台任务、表单问答、目标、回合外更新与工具身份规则。

## Impact

`packages/services/src/agent-runtime/`（连接能力声明与扩展流、投影拆分模块、协调器命令、V4 桥的虚拟子会话路由）、
`packages/services/src/zcode-agent/zcodeAgentService.ts`（`listSessionSubagents` 对 ACP 根会话的委托）。
不改 V4 wire schema、不新增 UI 组件；复用 `ConversationAgentToolCallRow`、`SubagentSessionSidePane`、
状态面板 Agents/Terminals 分区、`V4UserInputDialog`/`ElicitationDialog`、`McpToolCallBlock`、`CuaToolCallBlock`。
