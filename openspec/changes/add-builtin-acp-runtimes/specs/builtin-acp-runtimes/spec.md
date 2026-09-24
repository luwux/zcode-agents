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
