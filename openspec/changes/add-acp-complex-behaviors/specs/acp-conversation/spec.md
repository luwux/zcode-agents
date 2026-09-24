## ADDED Requirements

### Requirement: ACP tool identity is stable

CodeZ SHALL 在 ACP 工具调用首次出现时确定 `toolName`：优先 MCP 身份（`mcp__<server>__<tool>`），其次
`name` 或 `_meta.claudeCode.toolName`（已知工具名规范化大小写），再按 kind 回退（`execute→Bash`、`read→Read`、
`edit→Edit`、`search→Grep`、`fetch→WebFetch`），最后使用 `title`。后续 `tool_call_update` 的 `title`
SHALL NOT 覆盖 `toolName`；只有首次来源为 kind/title 且更新携带 `name`/`claudeCode.toolName`/MCP 身份时才升级一次。
工具行 SHALL 保留结构化 `input`（`rawInput`），MCP 工具 SHALL 携带 `display.kind = "mcp_tool"`。

#### Scenario: Refining update carries a descriptive title

- **WHEN** Claude 先发送 `tool_call{name:"Read"}`，再发送 `tool_call_update{title:"Read src/a.ts"}`
- **THEN** 工具行 `toolName` 仍为 `Read`，`input` 为 Agent 的 `rawInput` 对象

#### Scenario: Codex MCP tool call

- **WHEN** Codex 发送 `_meta.is_mcp_tool_call` 且 `rawInput = {server:"github", tool:"search", arguments}`
- **THEN** 工具行 `toolName = "mcp__github__search"`、`input = arguments`，并带 `mcp_tool` display

### Requirement: ACP extension updates are validated and ordered

CodeZ SHALL 以运行时 schema 校验 `subagent_spawned`、`subagent_state_update`、`async_task_spawned`、
`async_task_progress`、`async_task_state_update`、`_meta.lody.task` 与 `_meta.goal`；非法事件 SHALL 被丢弃并记 debug
日志，不得中断会话。扩展更新 SHALL 与其他 `session/update` 保持 Agent 发送顺序。转录 update 条目 SHALL 可选携带
`sessionId`（仅子会话），缺省按根会话回放。

#### Scenario: Invalid extension update

- **WHEN** Agent 发送缺少 `subagentSessionId` 的 `subagent_spawned`
- **THEN** CodeZ 丢弃该事件，会话继续正常运行

#### Scenario: Restore keeps child attribution

- **WHEN** 含子会话更新的会话在重启后从转录恢复
- **THEN** 子会话的工具与文本仍出现在该子会话中，而不是根会话

### Requirement: ACP lifecycle updates apply outside a turn

子智能体、后台任务、Pi 任务、计划、标题与目标更新 SHALL 在无活动回合时同样生效。回合外的 Agent 内容（文本、思考、
工具调用） SHALL 仅在可归因于仍在运行或 30 秒内完成的后台工作（异步任务或子智能体）时，展示在
`origin = "backgroundResult"`、`state = "completedSuccess"` 的展示轮中，`originMeta` 标明
`backgroundSource`、`workId` 与标题；否则 SHALL 丢弃。展示轮 SHALL NOT 改变会话 phase 或回合所有权。

#### Scenario: Claude follows up after a background task

- **WHEN** 根回合已结束，后台 Bash 任务 10 秒前完成，随后 Agent 发送回复文本
- **THEN** 文本显示在以该任务为标题的后台结果轮中，会话仍可立即接纳新输入

#### Scenario: Unattributable late content

- **WHEN** 根回合结束且没有运行中或 30 秒内完成的后台工作时 Agent 发送文本
- **THEN** 文本不进入会话视图

### Requirement: ACP native subagents are visible read-only sessions

CodeZ SHALL 向 ACP Agent 声明子智能体会话能力，并只接纳已由 `subagent_spawned` 宣告的子 sessionId 的更新、权限
与表单请求；其他未知 sessionId SHALL 被拒绝或以 `cancelled` 收口。每个子会话 SHALL 在父会话中表现为配对的
`Agent` 工具行与 `subagent` 行，并可通过虚拟会话 id 以只读方式打开；重复 spawn SHALL 幂等，
`<S>:generation:<N>` SHALL 视为新的子会话。子会话终态 SHALL 单调映射为 success/failed/cancelled，摘要取子会话
最后一段回复。子会话的权限请求 SHALL 出现在根会话并带 `origin.kind = "subagent"`。

#### Scenario: Claude spawns an Explore subagent

- **WHEN** Claude 在根会话发送 `subagent_spawned{subagentSessionId:"task-1", name:"Explore", task}`，随后以
  `sessionId:"task-1"` 发送工具调用与文本，最后发送 `subagent_state_update{state:"completed"}`
- **THEN** 根会话出现 `Agent` 工具行与 `success` 的 `subagent` 行，打开后只读显示子会话的工具与文本

#### Scenario: Subagent asks for permission

- **WHEN** 子会话 `task-1` 请求工具权限
- **THEN** 根会话显示权限对话框，origin 指向该子会话；用户选择被回传给 Agent

#### Scenario: Unknown child session

- **WHEN** Agent 以未宣告的 sessionId 发送更新或权限请求
- **THEN** 更新被丢弃，权限请求以 `cancelled` 收口

#### Scenario: Pi subagent task

- **WHEN** Pi 发送带 `_meta.lody.task{kind:"subagent", parentToolCallId}` 的 tool_call
- **THEN** 该任务显示为与 Pi `subagent` 工具行配对的 `subagent` 行；Agent 公布取消能力时状态面板可停止它

### Requirement: ACP background tasks

CodeZ SHALL 声明 AIR `asyncTasks` 能力，并把 `async_task_*` 投影为 `backgroundWorks`（`kind:"bash"`）和工具行的
`backgrounded` 标记；`cancelBackgroundWork` SHALL 调用 Agent 的 `_session/async_task/stop`，Agent 未停止任何任务时
SHALL 拒绝命令而不是报告成功。

#### Scenario: Stop a background shell

- **WHEN** 用户在状态面板停止运行中的后台 Bash 任务
- **THEN** CodeZ 发送 `_session/async_task/stop`，Agent 随后的 `stopped` 状态使该任务显示为已取消

#### Scenario: Best-effort stopped corrected by completion

- **WHEN** Agent 先报告后台任务 `stopped`，随后报告同一任务 `completed`
- **THEN** 以后到的终态为准，任务按已完成从 `backgroundWorks` 移除；终态之后的 `running` 仍被忽略

### Requirement: ACP form elicitation

CodeZ SHALL 声明 `elicitation.form` 并把 `elicitation/create` 呈现为现有的问答对话框；用户答案 SHALL 按原 schema
属性回传 `{action:"accept", content}`，拒绝与取消原样回传。停止、进程退出或回合结束时未应答的表单 SHALL 以
`cancel` 收口。

#### Scenario: Claude AskUserQuestion

- **WHEN** Claude 发送两个问题的 form elicitation（单选与多选，各带自定义答案字段）
- **THEN** 对话框显示两个问题；提交后 Agent 收到对应 `question_<n>` 与 `question_<n>_custom` 字段

#### Scenario: Stop while a question is pending

- **WHEN** 用户停止回合时仍有未应答的表单
- **THEN** Agent 收到 `cancel`，对话框消失

### Requirement: ACP session goal

CodeZ SHALL 将 `session_info_update._meta.goal` 投影为会话目标；`null` 清除目标，缺省不改变。

#### Scenario: Codex sets a goal

- **WHEN** Codex 发送 `_meta.goal{objective, status:"active", timeUsedSeconds:12}`
- **THEN** 状态面板显示该目标及用时

### Requirement: ACP computer-use tool calls

CodeZ SHALL 将 Codex 服务名包含 `computer-use` 的 MCP 工具调用展示为 Computer Use 工具卡，并只保留有界截图
（每张 base64 ≤ 200KB，最多 4 张）。CodeZ SHALL NOT 在 `@zcode/zcode-cua` 为占位包时向 ACP Agent 提供
ZCode Computer Use。

#### Scenario: Codex computer-use screenshot

- **WHEN** Codex 完成 `mcp.computer-use.screenshot` 工具调用并返回图片内容
- **THEN** 工具卡以 CUA 卡片展示截图；超限图片被丢弃并标记截断
