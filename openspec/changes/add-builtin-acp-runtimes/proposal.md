## Why

CodeZ 已有通用 ACP 客户端，但只能运行用户手工登记绝对路径的 Agent。Claude Code、Codex、Pi 是最常用的
编码 Agent，用户需要：不装全局 CLI 即可使用；用自有网关/Key（BYOK，如 OpenRouter、GLM、DeepSeek）或
自己的订阅账号登录；且 CodeZ 永不读写用户真实的 `~/.claude`、`~/.codex`、`~/.pi`。

## What Changes

- 新增三个内置 ACP Runtime：`claude-code`（`@agentclientprotocol/claude-agent-acp` 0.81.2，
  `CLAUDE_CODE_EXECUTABLE` 指向其 SDK 自带的原生 `claude`）、`codex`（`@agentclientprotocol/codex-acp`
  1.13.1 + `@openai/codex` 0.156.1，`CODEX_PATH` 指向原生二进制）、`pi`（`LodyAI/acp-extension-pi` 固定
  commit + `@earendil-works/pi-coding-agent` 0.87.0，包装 `pi --mode rpc`）。
- 受管安装：首次使用时按随源码提交的 package-lock 用 `npm ci --ignore-scripts` 安装到
  `<数据根>/acp-runtimes/<runtime>/<version>/`，完成标记后原子发布；Pi 适配器从固定 commit 取源码后本地编译。
  启动一律 `process.execPath` + argv（Electron 下 `ELECTRON_RUN_AS_NODE=1`），不经 shell。
- Agent 配置 = `{runtime, auth: byok|subscription|cli-login, env, defaultModel}`，存于
  `<数据根>/v2/agent-configs.json`；秘密值只存加密凭据库，仅在 spawn 时注入子进程 env。
  内置三个默认配置（`claude-code`、`codex` 订阅，`pi` 需配置 provider），用户可再添加多个 BYOK 配置。
- BYOK：Claude 注入 `ANTHROPIC_BASE_URL/AUTH_TOKEN/DEFAULT_*_MODEL/API_TIMEOUT_MS` 并剥离宿主所有
  `ANTHROPIC_*`/`CLAUDE_CODE_USE_*`；Codex 通过 `CODEX_CONFIG` + `MODEL_PROVIDER` 注入 `model_providers`
  条目（`env_key` 指向注入的密钥变量，不改用户 `config.toml`）；Pi 使用 `--provider/--model` 与 provider env。
- 订阅登录：声明 ACP `auth.terminal` 能力，读取 `initialize.authMethods`；Claude 执行适配器公布的终端登录
  （`claude auth login --claudeai`），Codex 走 `authenticate(chat-gpt)`；无浏览器主机用
  `codex login --device-auth`。每个配置独立的 `CLAUDE_CONFIG_DIR`/`CODEX_HOME`。订阅模式剥离全部 BYOK 变量。
  `authRequired`（-32000）将配置翻转为待认证，不回退到其他 Runtime 或 BYOK。
- 隔离：环境变量白名单；私有 home；`NO_PROXY` 补 loopback。
- spawn+initialize+session/new|load 经并发闸门（2）串行化。
- 离线回放代理（Anthropic Messages SSE + OpenAI Responses SSE）、真实 CLI e2e、OpenRouter 实测、CDP 桌面 e2e。
- 设置页配置：在既有 ACP 详情内选择认证方式、BYOK Provider 预设/模型/Base URL/Key（只写，不回显），
  订阅登录/设备码/登出（实时认证状态），在 ACP 添加页新增内置 Runtime 配置，删除非默认配置。

## Capabilities

### New Capabilities

- `builtin-acp-runtimes`: 内置 Runtime 的安装、配置、认证、隔离与验证。

### Modified Capabilities

- `agent-runtime-selection`: 供应商列表额外包含内置 Runtime 配置；状态增加 `authState`。

## Impact

`packages/services/src/agent-runtime/`（新增 builtin 子模块，扩展 launch 解析返回 env、auth 状态）、
`zcodeAgent.ts` 服务接口（配置、登录、Runtime 目录与认证变化事件）、`scripts/acp-replay/`、`scripts/acp-runtimes/`、
`scripts/acp-cdp/`、`.github/workflows/acp-runtimes.yml`；设置页 ACP 详情与 ACP 添加页
（`packages/ui/src/settings/model-provider-section/`）可直接配置内置 Runtime，CLI 脚本仍可用。
