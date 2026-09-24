## Purpose

内置 Claude Code、Codex、Pi ACP Runtime 的安装、配置、认证与隔离规则。

## ADDED Requirements

### Requirement: Built-in runtimes are selectable providers

CodeZ SHALL 在 `listAgentRuntimes` 中列出 `claude-code`、`codex`、`pi` 及用户添加的内置 Runtime 配置，
并报告安装状态、认证状态与不可用原因。首次发现或创建时 SHALL 按固定版本与随源码的 lockfile 安装到数据根，
SHALL NOT 安装到全局或依赖用户 PATH 上的同名 CLI。

#### Scenario: First use installs pinned runtime

- **WHEN** 用户在未安装时对 `codex` 执行模型同步
- **THEN** Host 以 `npm ci --ignore-scripts` 安装到 `<数据根>/acp-runtimes/codex/<version>/` 后再握手
- **AND** 安装失败时卡片显示原因，不创建会话

### Requirement: Secrets and env isolation

BYOK 秘密 SHALL 只存加密凭据库，只在 spawn 时注入子进程 env；SHALL NOT 出现在配置文件、日志、
fingerprint、缓存键或状态中。子进程 env SHALL 由白名单构造，并剥离与所选认证模式冲突的宿主变量。

#### Scenario: Host Anthropic variables do not leak into a BYOK config

- **WHEN** 宿主 env 含 `ANTHROPIC_API_KEY` 与 `CLAUDE_CODE_USE_BEDROCK`，用户使用 OpenRouter 配置
- **THEN** Claude 子进程只看到配置的 `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`，且 `ANTHROPIC_API_KEY` 为空

### Requirement: Native homes are private per config

每个配置 SHALL 使用 `<数据根>/acp-homes/<id>/` 下私有的 `CLAUDE_CONFIG_DIR`/`CODEX_HOME`/`PI_CODING_AGENT_DIR`；
只有显式 `cli-login` 配置 SHALL 指向用户全局 home。

#### Scenario: Two Claude configs keep separate sessions and logins

- **WHEN** 用户同时有订阅配置与 OpenRouter 配置
- **THEN** 两者的会话文件与登录凭据分别位于各自目录，互不可见

### Requirement: Subscription login uses ACP auth

订阅配置 SHALL 声明 `auth.terminal` 能力并使用 Agent 公布的认证方法；`authRequired` SHALL 把配置置为
`auth-required`，当前 turn 以明确错误结束，SHALL NOT 回退到其他 Runtime 或 BYOK。订阅模式 SHALL 剥离所有
BYOK 路由与认证变量。

#### Scenario: Expired Claude login

- **WHEN** 订阅配置的 prompt 返回 -32000
- **THEN** 卡片显示需要登录；再次登录成功后同一配置可继续新建会话

### Requirement: Startup concurrency gate

Host SHALL 将 spawn、initialize 与 session/new|load 限制为最多 2 个并发。

#### Scenario: Three concurrent Codex sessions

- **WHEN** 同时创建三个 Codex 会话
- **THEN** 第三个在前两个完成握手后才启动

### Requirement: Configure built-in runtimes in Settings

设置页 ACP 详情 SHALL 以与自定义 API 供应商卡片相同的结构与交互（标题栏启停与菜单、Base URL、API 格式式的
预设选择、带显示切换的密码框、模型列表）让用户在不使用 CLI 脚本的情况下配置内置 Runtime：认证方式（限该
Runtime 支持的方式）、BYOK 的 Provider 预设、Base URL（自定义预设必填；Pi 自定义端点另选协议）、API Key 与模型
列表，订阅登录、Codex 设备码登录与登出。所有写入 SHALL 经 `saveAgentRuntimeConfig`/`loginAgentRuntime`/`logoutAgentRuntime`/
`deleteAgentRuntimeConfig` 进入 Host，Host SHALL 运行时校验入参。API Key SHALL 只写：Renderer 只能读到
`hasApiKey`，保存成功后清空输入框。认证状态 SHALL 在登录进行与结束后无需手动刷新即更新。

#### Scenario: Enter an API key in Settings

- **WHEN** 用户在显示 “API key is not configured” 的 BYOK 配置中输入 Key 并保存
- **THEN** Key 只进入加密凭据库，卡片不再显示缺少 Key，状态与页面都不回显 Key，密码框被清空
- **AND** 随后「同步 Agent 模型」使用新 Key 成功列出模型

#### Scenario: Subscription sign-in from Settings

- **WHEN** 用户对订阅配置点击登录（Codex 可选设备码）
- **THEN** 页面显示可点击的登录 URL（经平台服务打开）或可选中的设备码，状态显示登录中
- **AND** 登录完成或失败后状态自动变为已登录或需要登录；方法需要交互式终端时提示 `scripts/acp-runtimes/login.ts`

#### Scenario: Add another built-in configuration

- **WHEN** 用户在 ACP 添加页选择内置 Runtime，填写 ID 与名称（如 “Claude Code (OpenRouter)”）并保存
- **THEN** 新配置出现在 ACP 列表并使用独立私有 home；ID 已被任何内置配置或自定义 ACP Server 占用时拒绝保存

#### Scenario: Delete a configuration

- **WHEN** 用户确认删除一个非默认配置
- **THEN** Host 登出订阅（私有 home 存在时）、删除 Key 与私有 home，配置从列表消失；默认配置不可删除，
  覆盖默认 ID 的配置删除后恢复为默认值

#### Scenario: Provider change invalidates the model catalog

- **WHEN** 用户修改 Provider 预设、Base URL 或认证方式并保存
- **THEN** 旧模型目录被清空，设置页不再展示旧模型，用户再次同步后才能启用新模型

### Requirement: Declared models are native runtime models

BYOK 配置 SHALL 可声明多个模型（显示名、启停，以及该 Runtime 使用的上下文窗口、最大输出、图片输入与推理档位）。
Runtime SHALL 原生列出这些模型：Claude 使用稳定的模型槽（最多 5 个），Codex 使用只含声明模型的模型目录，Pi 使用
models.json；输入框模型选择器 SHALL 在添加后立即提供已启用的声明模型，无需同步，所选模型与推理档位 SHALL 到达
Provider 请求。未声明模型的配置沿用“同步 Agent 模型”。

#### Scenario: Add a model in Settings

- **WHEN** 用户在 OpenRouter BYOK 配置中添加 `deepseek/deepseek-v4.1-flash`
- **THEN** 该模型立即出现在输入框模型选择器中，以它创建的会话把该模型 ID 发往 Provider

#### Scenario: Reasoning levels for declared models

- **WHEN** 用户以推理档位 high 使用 Pi 或 Codex 的声明模型
- **THEN** Pi 默认按推理模型提供 off 与所选档位（不再只有 “off”），Codex 只列出声明的模型并提供其档位（OpenAI 预设
  不再出现），请求携带对应的推理参数；关闭推理的模型不携带

#### Scenario: Claude slots stay stable

- **WHEN** 用户删除或调序 Claude 配置中的其他模型
- **THEN** 其余模型保留原模型槽，既有会话恢复时不会改用另一个模型
