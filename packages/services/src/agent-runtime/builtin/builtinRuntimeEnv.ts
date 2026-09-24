import { join } from "node:path";
import type { AgentConfig } from "#src/agent-runtime/builtin/agentConfigRegistry.js";
import {
  resolveProviderSettings,
  type AgentModelSettings,
} from "#src/agent-runtime/builtin/builtinProviderPresets.js";
import {
  CLAUDE_MODEL_SLOTS,
  PI_CUSTOM_PROVIDER_ID,
  claudeSlotAssignments,
  configuredModels,
  defaultConfiguredModel,
  effectiveReasoningLevels,
} from "#src/agent-runtime/builtin/builtinModels.js";
import { codexModelCatalog } from "#src/agent-runtime/builtin/builtinCodexModelCatalog.js";

/**
 * 子进程只继承这些宿主变量。白名单天然去掉宿主里的 Provider 凭据与路由变量
 * （ANTHROPIC_*、OPENAI_*、CLAUDE_CODE_USE_* 等），再由配置显式注入。
 */
const HOST_ENV_ALLOWLIST = new Set([
  "PATH",
  "Path",
  "PATHEXT",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "USER",
  "USERNAME",
  "LOGNAME",
  "SHELL",
  "ComSpec",
  "SystemRoot",
  "SystemDrive",
  "windir",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "TERM",
  "COLORTERM",
  "LANG",
  "LANGUAGE",
  "TZ",
  "TMPDIR",
  "TEMP",
  "TMP",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "DBUS_SESSION_BUS_ADDRESS",
  "SSH_AUTH_SOCK",
  "SSH_CONNECTION",
  "SSH_CLIENT",
  "SSH_TTY",
  "NO_BROWSER",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  // Agent 执行的构建/测试命令需要用户的工具链位置，与终端行为保持一致（均非凭据）。
  "JAVA_HOME",
  "GOPATH",
  "GOROOT",
  "CARGO_HOME",
  "RUSTUP_HOME",
  "PNPM_HOME",
  "VIRTUAL_ENV",
  "CONDA_PREFIX",
  "NVM_DIR",
  "PYENV_ROOT",
  "SDKROOT",
  "DEVELOPER_DIR",
  "ANDROID_HOME",
  "ANDROID_SDK_ROOT",
  "PSModulePath",
  "PROCESSOR_ARCHITECTURE",
  "NUMBER_OF_PROCESSORS",
  "ProgramW6432",
  "CommonProgramFiles",
  "OS",
  "COMPUTERNAME",
]);
const HOST_ENV_PREFIX_ALLOWLIST = ["LC_", "XDG_"];

/** 订阅/CLI 登录模式必须去掉的路由与认证变量，避免残留 Key 覆盖订阅身份。 */
const BYOK_ROUTING_PATTERNS = [
  /^ANTHROPIC_/,
  /^CLAUDE_CODE_USE_/,
  /^CLAUDE_CODE_OAUTH_TOKEN$/,
  /^AWS_BEARER_TOKEN_BEDROCK$/,
  /^OPENAI_/,
  /^CODEX_API_KEY$/,
  /^AZURE_OPENAI_/,
  /^OPENROUTER_API_KEY$/,
  /^API_TIMEOUT_MS$/,
  /^CLAUDE_CODE_API_BASE_URL$/,
];

const LOOPBACK_NO_PROXY = ["127.0.0.1", "localhost", "::1"];
export const CODEX_PROVIDER_KEY_ENV = "CODEZ_CODEX_PROVIDER_KEY";
export const PI_PROVIDER_KEY_ENV = "CODEZ_PI_PROVIDER_KEY";
const CUSTOM_PROVIDER_ID = "custom";
// 修复原因：provider ID 与 Codex 内置 provider（openai、ollama、lmstudio、oss…）同名时，config 覆盖会与内置
// 定义冲突，session/new 返回 -32000。托管 ID 一律加前缀，与内置命名空间隔离。
const CODEX_PROVIDER_PREFIX = "codez-";
/** 私有 CODEX_HOME 中的模型目录文件名（config.toml 的 model_catalog_json 指向它）。 */
export const CODEX_MODEL_CATALOG_FILE = "codez-model-catalog.json";

export interface BuiltinLaunchEnvInput {
  config: AgentConfig;
  hostEnv: NodeJS.ProcessEnv;
  apiKey: string | null;
  /** `<数据根>/acp-homes/<configId>` */
  configHome: string;
  /** 受管原生二进制：Claude 的 claude、Codex 的 codex。 */
  nativeBinary?: string;
}

export interface BuiltinLaunchEnvPlan {
  env: Record<string, string>;
  /** 追加到适配器入口后的参数。 */
  args: string[];
  /** 启动前写入私有 home 的非秘密文件（Pi models.json）。 */
  files: Array<{ path: string; content: string }>;
  /** 原生会话存储身份；用于 fingerprint，不含秘密。 */
  nativeHome: string;
  /** 不能启动的原因（例如缺少 Key）。 */
  problem?: string;
}

export function isByokRoutingEnv(name: string): boolean {
  return BYOK_ROUTING_PATTERNS.some((pattern) => pattern.test(name));
}

export function buildBuiltinLaunchEnv(input: BuiltinLaunchEnvInput): BuiltinLaunchEnvPlan {
  const { config } = input;
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.hostEnv)) {
    if (value === undefined) continue;
    if (HOST_ENV_ALLOWLIST.has(name) || HOST_ENV_PREFIX_ALLOWLIST.some((p) => name.startsWith(p)))
      env[name] = value;
  }
  Object.assign(env, config.env ?? {});
  const plan: BuiltinLaunchEnvPlan = { env, args: [], files: [], nativeHome: "global" };
  const byok = config.auth === "byok";
  if (!byok) {
    for (const name of Object.keys(env)) if (isByokRoutingEnv(name)) delete env[name];
  }
  const privateHome = config.auth !== "cli-login";
  switch (config.runtime) {
    case "claude-code":
      applyClaude(input, plan, privateHome, byok);
      break;
    case "codex":
      applyCodex(input, plan, privateHome, byok);
      break;
    case "pi":
      applyPi(input, plan, privateHome, byok);
      break;
  }
  // 修复原因：Pi 与各 Node 适配器使用 Node 内置 fetch，默认忽略 HTTP(S)_PROXY；企业代理下会表现为
  // "Connection error"。Node 24 以 NODE_USE_ENV_PROXY=1 显式启用；原生 claude/codex 本身读取代理变量。
  if (["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"].some((name) => env[name]))
    env.NODE_USE_ENV_PROXY = "1";
  for (const name of ["NO_PROXY", "no_proxy"]) {
    const entries = (env[name] ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    for (const loopback of LOOPBACK_NO_PROXY)
      if (!entries.includes(loopback)) entries.push(loopback);
    env[name] = entries.join(",");
  }
  return plan;
}

function applyClaude(
  input: BuiltinLaunchEnvInput,
  plan: BuiltinLaunchEnvPlan,
  privateHome: boolean,
  byok: boolean,
): void {
  const { env } = plan;
  if (privateHome) {
    const home = join(input.configHome, "claude");
    env.CLAUDE_CONFIG_DIR = home;
    plan.nativeHome = home;
  }
  if (input.nativeBinary) env.CLAUDE_CODE_EXECUTABLE = input.nativeBinary;
  // 受管二进制版本由 lockfile 固定，禁止自行更新到别的位置。
  env.DISABLE_AUTOUPDATER = "1";
  // 注意：CLAUDE_CODE_SUBPROCESS_ENV_SCRUB 在 Linux 需要 bubblewrap，缺失时 Claude 直接拒绝启动；
  // 因此不默认开启，由用户按需在配置 env 中启用（见 docs/acp-runtimes.md 的密钥暴露说明）。
  if (!byok) return;
  const settings = resolveProviderSettings("claude-code", input.config.provider);
  if (!input.apiKey) plan.problem = "API key is required for this configuration";
  if (settings.baseUrl) {
    env.ANTHROPIC_BASE_URL = settings.baseUrl;
    env.ANTHROPIC_AUTH_TOKEN = input.apiKey ?? "";
    // 网关使用 Bearer token；空 API Key 防止 CLI 改走 x-api-key 或登录态。
    env.ANTHROPIC_API_KEY = "";
    // 非 Anthropic 端点不需要遥测、自动更新等附带流量。
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  } else {
    env.ANTHROPIC_API_KEY = input.apiKey ?? "";
  }
  const models = configuredModels(settings);
  // 声明的模型依次占用 opus/sonnet/haiku/fable/自定义选项槽，适配器据此列出这些模型（上限 5 个）。
  // 不写 `<槽>_SUPPORTED_CAPABILITIES`：2.1.280 对网关模型总是发送 adaptive thinking 与所选 effort，
  // 该变量不改变请求（回放代理记录的请求体已验证），推理档位由 Claude 自己的 effort 选项控制。
  const slots = claudeSlotAssignments(models);
  models.forEach((model, index) => {
    const slot = CLAUDE_MODEL_SLOTS[slots[index]!]?.env;
    if (!slot) return;
    env[slot] = model.id;
    env[`${slot}_NAME`] = model.name ?? model.id;
  });
  const primary = defaultConfiguredModel(models)?.id;
  // 未占用的 opus/sonnet 槽指向默认模型，避免别名（含 “Default”）落到网关不认识的 Claude 官方模型名；
  // haiku 槽同时承担后台小任务（标题、摘要），缺省使用 smallModel 或默认模型。
  if (primary) {
    env.ANTHROPIC_DEFAULT_OPUS_MODEL ??= primary;
    env.ANTHROPIC_DEFAULT_SONNET_MODEL ??= primary;
  }
  const small = settings.smallModel ?? primary;
  if (small) {
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL ??= small;
    env.ANTHROPIC_SMALL_FAST_MODEL = small;
  }
  if (settings.timeoutMs) env.API_TIMEOUT_MS = String(settings.timeoutMs);
}

function applyCodex(
  input: BuiltinLaunchEnvInput,
  plan: BuiltinLaunchEnvPlan,
  privateHome: boolean,
  byok: boolean,
): void {
  const { env } = plan;
  const configToml = privateHome ? join(input.configHome, "codex", "config.toml") : null;
  if (privateHome) {
    const home = join(input.configHome, "codex");
    env.CODEX_HOME = home;
    plan.nativeHome = home;
  }
  if (input.nativeBinary) env.CODEX_PATH = input.nativeBinary;
  if (!byok) {
    // 修复原因：同一配置从 BYOK 改为订阅后，旧 config.toml（requires_openai_auth=false）会让 codex-acp 跳过
    // 登录并继续把请求发往旧网关；私有 home 的托管文件每次启动都按当前模式重写。
    if (configToml)
      plan.files.push({
        path: configToml,
        content: `${MANAGED_TOML_HEADER}\n# Subscription sign-in: no model provider override.\n`,
      });
    return;
  }
  const settings = resolveProviderSettings("codex", input.config.provider);
  if (!input.apiKey) plan.problem = "API key is required for this configuration";
  const models = configuredModels(settings);
  const defaultModel = defaultConfiguredModel(models)?.id;
  const providerId = `${CODEX_PROVIDER_PREFIX}${settings.providerId ?? CUSTOM_PROVIDER_ID}`;
  const baseUrl = settings.baseUrl ?? "https://api.openai.com/v1";
  // 通过 codex-acp 的 CODEX_CONFIG 注入会话级覆盖；密钥只经 env_key 指向的变量传递，不写入 config.toml。
  const codexConfig: Record<string, unknown> = {
    model_provider: providerId,
    model_providers: {
      [providerId]: {
        name: input.config.name,
        base_url: baseUrl,
        env_key: CODEX_PROVIDER_KEY_ENV,
        wire_api: settings.wireApi ?? "responses",
        requires_openai_auth: false,
      },
    },
    ...(defaultModel ? { model: defaultModel } : {}),
  };
  env.CODEX_CONFIG = JSON.stringify(codexConfig);
  env.MODEL_PROVIDER = providerId;
  env[CODEX_PROVIDER_KEY_ENV] = input.apiKey ?? "";
  // 修复原因：codex-acp 的登录判定读 app-server 自身配置（当前 provider 的 requires_openai_auth），
  // CODEX_CONFIG 只作用于会话线程，导致 BYOK 被误判为需要 ChatGPT 登录。这里在该配置私有的
  // CODEX_HOME 写入同样的非秘密路由（密钥仍只经 env_key 引用），从不触碰用户的 ~/.codex。
  if (!configToml) return;
  // 修复原因：Codex 对目录外的模型使用兜底元数据（无推理档位，界面只剩“关闭”），并继续列出 OpenAI 预设
  // （按其 slug 发往网关必然失败）。BYOK 配置在私有 CODEX_HOME 写入只含声明模型的目录，
  // 由 config.toml 的 model_catalog_json 指向它：预设消失，推理档位按每个模型的设置提供。
  const catalog = models.length ? join(input.configHome, "codex", CODEX_MODEL_CATALOG_FILE) : null;
  if (catalog)
    plan.files.push({
      path: catalog,
      content: `${JSON.stringify(codexModelCatalog(models), null, 2)}\n`,
    });
  plan.files.push({ path: configToml, content: codexConfigToml(providerId, codexConfig, catalog) });
}

const MANAGED_TOML_HEADER =
  "# Managed by CodeZ for this agent configuration. Changes are overwritten.";

/** 只序列化本模块生成的固定结构；字符串用 JSON 转义（与 TOML basic string 兼容）。 */
function codexConfigToml(
  providerId: string,
  config: Record<string, unknown>,
  modelCatalog: string | null,
): string {
  const provider = (config.model_providers as Record<string, Record<string, unknown>>)[providerId]!;
  const value = (entry: unknown) =>
    typeof entry === "string" ? JSON.stringify(entry) : String(entry);
  const lines = [MANAGED_TOML_HEADER, ""];
  lines.push(`model_provider = ${value(providerId)}`);
  if (typeof config.model === "string") lines.push(`model = ${value(config.model)}`);
  if (modelCatalog) lines.push(`model_catalog_json = ${value(modelCatalog)}`);
  lines.push("", `[model_providers.${JSON.stringify(providerId)}]`);
  for (const [key, entry] of Object.entries(provider)) lines.push(`${key} = ${value(entry)}`);
  return `${lines.join("\n")}\n`;
}

function applyPi(
  input: BuiltinLaunchEnvInput,
  plan: BuiltinLaunchEnvPlan,
  privateHome: boolean,
  byok: boolean,
): void {
  const { env } = plan;
  const agentDir = privateHome ? join(input.configHome, "pi") : null;
  if (agentDir) {
    env.PI_CODING_AGENT_DIR = agentDir;
    plan.nativeHome = agentDir;
  }
  // Pi 默认在无终端时也可能检查更新；受管版本不自更新。
  env.PI_SKIP_VERSION_CHECK = "1";
  if (!byok) return;
  const settings = resolveProviderSettings("pi", input.config.provider);
  if (!input.apiKey) plan.problem = "API key is required for this configuration";
  const models = configuredModels(settings);
  const defaultModel = defaultConfiguredModel(models)?.id;
  if (settings.baseUrl) {
    if (!agentDir) {
      plan.problem ??= "Custom Pi endpoints require a private CodeZ home";
      return;
    }
    if (!defaultModel) plan.problem ??= "A model is required for a custom Pi endpoint";
    // models.json 只含 `$VAR` 引用，密钥在 spawn 时经 env 注入，不落盘。
    plan.files.push({
      path: join(agentDir, "models.json"),
      content: `${JSON.stringify(
        {
          providers: {
            [PI_CUSTOM_PROVIDER_ID]: {
              baseUrl: settings.baseUrl,
              api: settings.api ?? "openai-completions",
              apiKey: `$${PI_PROVIDER_KEY_ENV}`,
              models: models.map(piModelEntry),
            },
          },
        },
        null,
        2,
      )}\n`,
    });
    env[PI_PROVIDER_KEY_ENV] = input.apiKey ?? "";
    plan.args.push("--provider", PI_CUSTOM_PROVIDER_ID);
  } else {
    const provider = settings.providerId ?? "openrouter";
    const keyEnv = settings.piKeyEnv ?? `${provider.toUpperCase().replaceAll("-", "_")}_API_KEY`;
    env[keyEnv] = input.apiKey ?? "";
    plan.args.push("--provider", provider);
  }
  if (defaultModel) plan.args.push("--model", defaultModel);
}

const PI_STANDARD_LEVELS = ["minimal", "low", "medium", "high"] as const;
const PI_EXTENDED_LEVELS = ["xhigh", "max"] as const;

/**
 * Pi models.json 的模型条目。修复原因：`reasoning` 缺省为 false，Pi 因而只提供 “off” 思考档位，
 * 输入框推理选择器对 deepseek/deepseek-v4.1-flash 等推理模型也只剩“关闭”。自定义端点的模型默认按支持推理
 * 写入（OpenRouter 对不推理的模型会忽略 reasoning_effort），并按用户设置收窄档位、上下文与输入模态。
 */
function piModelEntry(model: AgentModelSettings): Record<string, unknown> {
  const levels = effectiveReasoningLevels(model);
  // thinkingLevelMap：省略的标准档位走 Pi 默认映射，null 表示不提供；xhigh/max 需要显式给出取值才可用。
  const thinkingLevelMap = Object.fromEntries([
    ...PI_STANDARD_LEVELS.filter((level) => !levels.includes(level)).map((level) => [level, null]),
    ...PI_EXTENDED_LEVELS.filter((level) => levels.includes(level)).map((level) => [level, level]),
  ]);
  return {
    id: model.id,
    ...(model.name ? { name: model.name } : {}),
    reasoning: levels.length > 0,
    ...(levels.length && Object.keys(thinkingLevelMap).length ? { thinkingLevelMap } : {}),
    ...(model.vision === undefined ? {} : { input: model.vision ? ["text", "image"] : ["text"] }),
    ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
    ...(model.maxTokens ? { maxTokens: model.maxTokens } : {}),
  };
}
