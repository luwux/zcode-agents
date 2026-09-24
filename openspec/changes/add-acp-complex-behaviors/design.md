## Context

ACP 执行链路：`AcpConnection`（stdio）→ `AcpSessionObserver`（唯一写入者）→ `AcpTranscriptStore` 追加 →
`AcpConversationProjection` 应用 → `AcpRuntimeCoordinator.publish` → `AcpV4Bridge` 以整份 snapshot 帧推送
`conversation/<taskId>`。本变更不新增执行所有者，也不改 V4 wire schema。

SDK `@agentclientprotocol/sdk` 1.4.0 不认识 `subagent_*` / `async_task_*`：`session/update` 在进入 Client
回调前被 `zSessionNotification.parse` 拒收（console 报 `Invalid params`）。SDK 对每条入站消息并发执行处理链，
同一方法的回调入口按到达顺序触发，但 request 与 notification 的处理链长度不同，不能跨方法依赖回调顺序。

## Goals / Non-Goals

- Goals：三个内置 Runtime 的子智能体、后台任务、问答、目标、MCP/CUA 工具调用在现有 V4 行与面板上可见、可恢复；
  桌面 `desktop-continuous` 与手机 `web-remote-replayable` 语义一致。
- Non-Goals：新 UI 组件；为 ACP Agent 注入 ZCode Computer Use（占位包，见 D9）；向 ACP Runtime 开放 ZCode
  动态工作流引擎；Claude legacy `parentToolUseId` 回退（声明 `subagents` 后 Claude 走原生子会话，不再需要）；
  `_lody/subagents/output` 子输出拉取；原生子智能体的停止（适配器没有停止方法）。

## Decisions

### D1 所有者与事件顺序

```mermaid
sequenceDiagram
  participant G as Agent 适配器 (stdout)
  participant X as AcpExtensionStream + ChildRegistry<br/>(连接级, 线序唯一观察点)
  participant K as SDK ClientSideConnection
  participant C as AcpConnection 回调
  participant O as AcpSessionObserver (唯一写入者)
  participant T as AcpTranscriptStore
  participant P as 根 AcpConversationProjection<br/>(拥有 SubagentRegistry/BackgroundWorks/goal/pending)
  participant B as AcpV4Bridge
  G->>X: [R] subagent_spawned(S)
  X->>X: zod 校验; 父为 R 或已登记子 → 登记 S
  X->>K: 包装为 session_info_update._meta["codez.dev/extensionUpdate"]
  K->>C: sessionUpdate(R, carrier)
  C->>O: onUpdate({sessionId:R, update: subagent_spawned})
  O->>T: append(update, at)
  O->>P: applyUpdate → 宿主 Agent toolCall + subagent 行 + 子投影 V(S)
  G->>X: [S] tool_call / agent_message_chunk
  X->>K: 原样转发（S 已登记）
  K->>C: sessionUpdate(S)
  C->>O: onUpdate (S ∈ 登记表, 否则丢弃)
  O->>T: append(update, sessionId=S)
  O->>P: applyUpdate → 路由到 V(S) 行
  G->>K: [S] session/request_permission
  K->>C: requestPermission (S ∈ 登记表, 否则 cancelled)
  C->>O: pending 于根会话, origin.kind="subagent", childSessionId=V(S)
  G->>X: [R] subagent_state_update(S, completed)
  O->>P: subagent 行 success, V(S) 回合收口, summaryText=子最后文本
  P-->>B: publish(R) → conversation/R 与已订阅的 conversation/V(S)
```

- 连接级 `AcpChildSessionRegistry` 在**入站流变换**中登记子会话：这是唯一严格按线序处理的位置，保证子会话的首条
  更新或权限请求（request 处理链更短）一定晚于其 spawn 被登记。它只保存会话 id 与存活状态，不保存业务状态。
- 扩展更新以“载体” `session_info_update._meta["codez.dev/extensionUpdate"]` 穿过 SDK：与其他 `session/update`
  处理链等长，保持相对顺序；Agent 自带的同名 `_meta` 键在变换中被剥离，防止伪造。`AcpConnection` 解包后再次
  zod 校验。
- 根投影是子会话、后台任务、目标与待处理交互的唯一所有者；子投影 V(S) 只由根投影创建和写入。协调器、桥与服务
  只读 snapshot 或发命令。
- 幂等键：子会话 = 原生 S（重复 spawn 忽略，`S:generation:N` 是新子会话）；后台任务 = `asyncTaskId`；
  Pi 任务 = `taskId`；表单 = `acp-elicitation:<uuid>`；子权限 = `acp-subagent:<S>:<toolCallId>`。
- 终态单调：子智能体/后台任务进入终态后不再回到运行中；迟到的终态重复更新忽略。

### D2 转录与回放

- update 条目：`{v:1, kind:"update", at, update, sessionId?}`；`sessionId` 仅在更新来自子会话时写入，
  缺省即根会话，旧转录照常读取。扩展更新按校验后的形状落盘，回放时再次校验。
- 观察者对同一更新只取一次 `at`，同时用于落盘与实时投影，回放得到相同的 30s 归因结果。
- 回放结束时：未收口的根回合按既有规则失败；仍在运行的子智能体、Pi 任务与后台任务标记为失败（旧进程已退出）。

### D3 工具身份

1. MCP：Codex `_meta.is_mcp_tool_call` + `rawInput{server,tool,arguments}`（或 `title` 为 `mcp.<s>.<t>`）→
   `toolName = mcp__<server>__<tool>`，`input = arguments`，`display = {kind:"mcp_tool", serverName, toolName}`；
   Claude 的 `mcp__s__t` 名称同样生成 display。服务名含 `computer-use` 时改为 `mcp__computer-use__<tool>`（D9）。
2. `update.name` 或 `_meta.claudeCode.toolName`：已知工具名规范化大小写（`bash`→`Bash`）。
3. 无已知名称时按 kind 回退（包括 Codex 的非渲染器名称，如 `exec_command` + `kind:"execute"` → `Bash`；
   kind 不可映射时保留原 name）：`execute→Bash`、`read→Read`、`edit→Edit`、`search→Grep`、`fetch→WebFetch`，
   并用 `locations`/`title` 补齐渲染器所需的 `command`/`file_path`/`pattern`/`url`。
4. 其余用 `title`。

- 身份在首次出现时确定；后续 update 只有携带更强来源（1、2）且首次来源为弱来源（3、4）时升级一次，
  `title` 永不覆盖 `toolName`。`input` 保留 `rawInput` 对象，`inputText` 为其有界 JSON。
- 输出：文本 content 优先，否则有界 `rawOutput`；图片仅用于 D9 的 CUA display 与 `node_repl` 的
  `node_repl_images`（均有界）。`display` 放在 row 顶层，与 ZCode CLI 投影一致（UI 读取
  `row.output?.display ?? row.display`，运行中即可识别 MCP 卡片）。

### D4 回合外更新（负责人裁决）

- 生命周期更新在任何时刻应用：`subagent_*`、`async_task_*`、`_meta.lody.task`、`plan`、`session_info_update`
  （标题、goal）、`current_mode_update`。
- Agent 内容（message/thought chunk、tool_call、tool_call_update）在无活动回合时：若可归因于**仍在运行**或
  **30s 内完成**的后台工作（异步任务或子智能体，取最近者），追加到一个仅展示的回合：`turnHeader.origin =
"backgroundResult"`、`originMeta = {backgroundSource: "bash"|"subagent", workId, title}`、`state =
"completedSuccess"`；连续内容归入同一展示轮，归因对象变化时另起一轮。否则按现状丢弃并记 debug。
- 展示轮不修改 `control.phase`、不占用回合所有权（`sendPrompt` 仍可接纳）；文本行直接为 `complete`。下一次
  `beginTurn` 时展示轮中未收口的工具行标记为 `cancelled`。

### D5 子智能体

- 声明 `clientCapabilities.subagents = {}` 与 AIR `_meta.jetbrains.air = {version:1, capabilities:
["nativeSubagentSessions","asyncTasks"]}`（SDK 1.4 无类型，按 wire 形状断言）。实测适配器捆绑的 SDK 1.5 解析
  initialize 时会剥离 `subagents` 字段，因此 AIR `nativeSubagentSessions` 是实际生效的声明，两者都保留。
- Claude Code 2.1.280 默认异步启动 Agent：适配器在原生模式下仍发送一条无前置 `tool_call` 的控制
  `tool_call_update`（`_meta.claudeCode.toolResponse{isAsync:true, agentId}`）。该回执不生成工具行（否则回合结束时
  会被判为未收到终态的失败 Agent 行），只把 `agentId` 对应子会话的宿主行与 subagent 行标记 `backgrounded`。
  失败回退（`tool_call` + `failed`）仍按普通工具行展示。
- `subagent_spawned(S)` 于父会话 P（根或已登记子）：在 P 的当前回合（或 D4 展示轮）追加宿主
  `toolCall{toolCallId:"acp-subagent:"+S, toolName:"Agent", input:{description,prompt,subagent_type}, status:"running"}`
  与 `subagent{parentToolCallId: 同 id, subagentType:name, status:"running", summaryText:task, childSessionId:V(S)}`；
  创建只读子投影 V(S)，其首轮以 `origin:"synthetic"` 的输入行展示任务。
- `subagent_state_update`：`completed→success`、`failed|disconnected→failed`、`cancelled→cancelled`；宿主工具行
  对应 `success|error|cancelled`；`summaryText` = 子会话最后一段回复（≤2000 字符，无则任务文本）。
- 根回合以取消或错误结束时，仍运行的子智能体按 `cancelled`/`failed` 收口；正常结束时保留（可能是后台子智能体）。
- `snapshot.subagents`：每个投影列出自己的直接子会话；有待处理权限的子会话状态为 `blocked`。
- 子权限：待处理交互放在根会话，`origin = {kind:"subagent", agentId:S, agentType:name, childSessionId:V(S),
parentSessionId:P 的工作台 id, parentToolCallId: 宿主 id, description: task}`，锚定根会话中该分支顶层宿主行。
- 虚拟 id `V(S) = <rootTaskId>::acp-subagent::<encodeURIComponent(S)>`，工作区身份键沿用
  `workspaceIdentity?.trim() || workspacePath`。`AcpV4Bridge.isAcpTask/subscribe/resync` 与协调器
  `load/snapshot/rowsRange` 识别虚拟 id 并读取根投影中的子投影；对虚拟 id 的命令一律以
  `acpSubagentReadOnly` 拒绝。根投影发布时，桥仅在子 snapshot `revision` 变化时推送虚拟订阅。
- `listSessionSubagents`：ACP 根会话（及虚拟子会话）由桥按上述 snapshot 事实应答，ended 列表按结束时间倒序、
  数字游标分页。
- Pi：带 `_meta.lody.task{kind:"subagent"}` 的 tool_call 不生成工具行，而是在宿主 `subagent` 工具行所在回合追加
  `subagent` 行（`subagentType = modelId ?? "Pi"`，`summaryText = error ?? description`），子投影只含任务说明
  与终态；运行中以 `backgroundWorks{kind:"subagent", workId:taskId, childSessionId:V(key)}` 暴露停止入口，仅当
  `agentCapabilities._meta.lody.subagents.cancel === true` 时 `cancellable`，停止发送 `_lody/subagents/cancel`。

### D6 后台任务

- `async_task_spawned` → `backgroundWorks{workId: asyncTaskId, kind:"bash", title: name ?? description,
status:"running", startedAt, cancellable: canStop, anchorRowId: toolCallId 对应行}`（`kind` 为闭集，workflow
  任务同样用 `bash` 并以工作流名为标题）；对应工具行标记 `backgrounded:true, workId`。
- `async_task_progress` 更新锚点与标题；`async_task_state_update`：`completed` → 从 `backgroundWorks` 移除
  （保留 30s 归因）、`failed→failed`、`stopped→cancelled`、`running|paused` 不变。
- `tool_call_update._meta.jetbrains.air.asyncTasks.backgrounded === true` → `toolCall.backgrounded = true`。
- `cancelBackgroundWork{workId}`：Bash 任务调用 `_session/async_task/stop{sessionId, asyncTaskId}`，Pi 任务调用
  `_lody/subagents/cancel`；`stopped:false` 或未知/已结束工作以 `fault.command.backgroundWorkCancelRejected.<reason>`
  拒绝，不伪造成功。

### D7 表单问答

- 声明 `elicitation: {form: {}}`，实现 SDK 1.4 `Client.createElicitation`。仅接受根会话或已登记子会话的 form 模式；
  其他模式或作用域 `decline`。
- 映射：`requestedSchema.properties` 按顺序生成 `questions[]`：`oneOf`/`enum` → 单选，`array` + `items.anyOf|enum`
  → 多选，boolean → 是/否，其余 → 自由文本。“自定义答案”伴随字段（Claude `_askUserQuestionCustomAnswer`、
  Codex `role:"user_note"`、Pi `lody.elicitation.customAnswerFor`）不单独成题，用户输入的非选项答案写回伴随字段。
  Codex 属性 `title` 是问题、`description` 是标题；其余 Agent 反之。无属性的表单呈现为“接受/拒绝”选项。
- `resolveInteraction{action, content}`：按 `answer_<i>` 写回原属性键，数值/布尔按 schema 转换；`decline`/`cancel`
  原样回传。`stop`、进程退出与回合结束时未应答的表单以 `cancel` 收口并清理待处理交互。

### D8 目标

`session_info_update._meta.goal`：对象 → `snapshot.goal{targetId:"acp", objective, status: active→active,
paused|blocked|limited→paused, complete→verified, iteration: iterations ?? 0, timeUsedSeconds, verifications:[],
iterations:[]}`；`null` 清除；缺省不变。回合内 objective 变化时追加 `timelineMarker{type:"goalSet"}`。
`pauseGoal/resumeGoal` 仍不可用（`_session/goal` 控制不在本变更范围）。

### D9 Computer Use 与工作流（阻塞项）

- `@zcode/zcode-cua` 是 fail-closed 占位包（`packages/zcode-cua/package.json`、README、官方插件定义均说明），
  没有可注入的 ZCode Computer Use；本变更不伪造 CUA、不向 `session/new|load` 注入 `node_repl`。
- Codex 服务名含 `computer-use` 的 MCP 工具 → `toolName = mcp__computer-use__<tool>`，由现有 `CuaToolCallBlock`
  渲染；终态 `output.display = {kind:"cua", schemaVersion:1, toolName, status, text?, media≤4}`，每张图 base64
  ≤200KB，超限丢弃并标 `truncated`。`mcp__node_repl__*` 的图片进入 `display.kind="node_repl_images"`（≤2 张）。
- Claude `taskType:"workflow"` 后台任务只进入 `backgroundWorks(kind:"bash")`；ZCode 动态工作流需另立变更经 MCP 暴露。

### D10 SDK 校验与日志

扩展 schema 放在 `packages/services/src/agent-runtime/acpExtensionSchemas.ts`：它们只描述 ACP wire 的内部形状，
仅由 Host 的 ACP 适配层消费；UI 只看到既有 V4 行与 snapshot，因此不进入 `packages/shared` 公共协议。
非法扩展事件丢弃并以 `createServiceLogger("acpExtension")` 记 `debug`；原始载荷不写入 info 日志。

## Risks / Trade-offs

- 载体包装依赖 SDK 1.4 对 `session_info_update._meta` 的透传；升级 SDK 后（原生类型）应移除包装。
- 展示轮是投影事实而非 Agent 回合；若 Agent 在回合外长时间输出且无后台工作可归因，这些内容仍被丢弃。
- 原生子智能体没有停止方法；只能随根回合取消。
