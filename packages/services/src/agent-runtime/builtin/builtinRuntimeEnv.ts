import { join } from "node:path";
import type { AgentConfig } from "#src/agent-runtime/builtin/agentConfigRegistry.js";
import { resolveProviderSettings } from "#src/agent-runtime/builtin/builtinProviderPresets.js";

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
];

const LOOPBACK_NO_PROXY = ["127.0.0.1", "localhost", "::1"];
export const CODEX_PROVIDER_KEY_ENV = "CODEZ_CODEX_PROVIDER_KEY";
export const PI_PROVIDER_KEY_ENV = "CODEZ_PI_PROVIDER_KEY";
const CUSTOM_PROVIDER_ID = "codez";

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
  if (settings.model) {
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = settings.model;
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = settings.model;
  }
  const small = settings.smallModel ?? settings.model;
  if (small) {
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = small;
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
  if (privateHome) {
    const home = join(input.configHome, "codex");
    env.CODEX_HOME = home;
    plan.nativeHome = home;
  }
  if (input.nativeBinary) env.CODEX_PATH = input.nativeBinary;
  if (!byok) return;
  const settings = resolveProviderSettings("codex", input.config.provider);
  if (!input.apiKey) plan.problem = "API key is required for this configuration";
  const providerId = settings.providerId ?? CUSTOM_PROVIDER_ID;
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
    ...(settings.model ? { model: settings.model } : {}),
  };
  env.CODEX_CONFIG = JSON.stringify(codexConfig);
  env.MODEL_PROVIDER = providerId;
  env[CODEX_PROVIDER_KEY_ENV] = input.apiKey ?? "";
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
  if (settings.baseUrl) {
    if (!agentDir) {
      plan.problem = "Custom Pi endpoints require a private CodeZ home";
      return;
    }
    if (!settings.model) plan.problem = "A model is required for a custom Pi endpoint";
    // models.json 只含 `$VAR` 引用，密钥在 spawn 时经 env 注入，不落盘。
    plan.files.push({
      path: join(agentDir, "models.json"),
      content: `${JSON.stringify(
        {
          providers: {
            [CUSTOM_PROVIDER_ID]: {
              baseUrl: settings.baseUrl,
              api: settings.api ?? "openai-completions",
              apiKey: `$${PI_PROVIDER_KEY_ENV}`,
              models: settings.model ? [{ id: settings.model }] : [],
            },
          },
        },
        null,
        2,
      )}\n`,
    });
    env[PI_PROVIDER_KEY_ENV] = input.apiKey ?? "";
    plan.args.push("--provider", CUSTOM_PROVIDER_ID);
  } else {
    const provider = settings.providerId ?? "openrouter";
    const keyEnv = settings.piKeyEnv ?? `${provider.toUpperCase().replaceAll("-", "_")}_API_KEY`;
    env[keyEnv] = input.apiKey ?? "";
    plan.args.push("--provider", provider);
  }
  if (settings.model) plan.args.push("--model", settings.model);
}
