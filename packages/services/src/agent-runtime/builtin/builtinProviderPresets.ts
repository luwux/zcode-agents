import type { BuiltinAcpRuntime } from "#src/agent-runtime/builtin/builtinRuntimeCatalog.js";

/** 非秘密的 Provider 路由设置；密钥只以 `apiKey` 秘密单独保存。 */
export interface AgentProviderSettings {
  preset?: string;
  baseUrl?: string;
  model?: string;
  /** Claude 的 haiku/small-fast 模型；缺省与 model 相同。 */
  smallModel?: string;
  /** Codex `model_providers` 的 ID / Pi 内置 provider 名。 */
  providerId?: string;
  /** Codex wire API。 */
  wireApi?: "responses" | "chat";
  /** Pi 自定义端点协议。 */
  api?: "anthropic-messages" | "openai-responses" | "openai-completions";
  timeoutMs?: number;
}

export interface ProviderPreset {
  id: string;
  name: string;
  settings: AgentProviderSettings;
  /** Pi 内置 provider 读取的密钥变量。 */
  piKeyEnv?: string;
}

/** Anthropic 兼容网关；模型名由用户或配置的 model 决定。 */
const CLAUDE_PRESETS: readonly ProviderPreset[] = [
  { id: "anthropic", name: "Anthropic API", settings: {} },
  { id: "openrouter", name: "OpenRouter", settings: { baseUrl: "https://openrouter.ai/api" } },
  {
    id: "glm",
    name: "GLM (BigModel)",
    settings: { baseUrl: "https://open.bigmodel.cn/api/anthropic", timeoutMs: 3_000_000 },
  },
  {
    id: "zai",
    name: "Z.ai",
    settings: { baseUrl: "https://api.z.ai/api/anthropic", timeoutMs: 3_000_000 },
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    settings: { baseUrl: "https://api.deepseek.com/anthropic", timeoutMs: 600_000 },
  },
  {
    id: "kimi",
    name: "Kimi (Moonshot)",
    settings: { baseUrl: "https://api.moonshot.cn/anthropic" },
  },
  { id: "custom", name: "Custom Anthropic-compatible", settings: {} },
];

const CODEX_PRESETS: readonly ProviderPreset[] = [
  { id: "openai", name: "OpenAI API", settings: {} },
  {
    id: "openrouter",
    name: "OpenRouter",
    settings: {
      baseUrl: "https://openrouter.ai/api/v1",
      providerId: "openrouter",
      wireApi: "responses",
    },
  },
  { id: "custom", name: "Custom OpenAI-compatible", settings: { wireApi: "responses" } },
];

const PI_PRESETS: readonly ProviderPreset[] = [
  {
    id: "openrouter",
    name: "OpenRouter",
    settings: { providerId: "openrouter" },
    piKeyEnv: "OPENROUTER_API_KEY",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    settings: { providerId: "anthropic" },
    piKeyEnv: "ANTHROPIC_API_KEY",
  },
  { id: "openai", name: "OpenAI", settings: { providerId: "openai" }, piKeyEnv: "OPENAI_API_KEY" },
  { id: "zai", name: "Z.ai", settings: { providerId: "zai" }, piKeyEnv: "ZAI_API_KEY" },
  {
    id: "deepseek",
    name: "DeepSeek",
    settings: { providerId: "deepseek" },
    piKeyEnv: "DEEPSEEK_API_KEY",
  },
  { id: "custom", name: "Custom endpoint", settings: { api: "openai-completions" } },
];

export const PROVIDER_PRESETS: Readonly<Record<BuiltinAcpRuntime, readonly ProviderPreset[]>> = {
  "claude-code": CLAUDE_PRESETS,
  codex: CODEX_PRESETS,
  pi: PI_PRESETS,
};

export function findProviderPreset(
  runtime: BuiltinAcpRuntime,
  presetId: string | undefined,
): ProviderPreset | undefined {
  return presetId ? PROVIDER_PRESETS[runtime].find((preset) => preset.id === presetId) : undefined;
}

/** 预设只补默认值；用户显式设置覆盖预设。 */
export function resolveProviderSettings(
  runtime: BuiltinAcpRuntime,
  settings: AgentProviderSettings | undefined,
): AgentProviderSettings & { piKeyEnv?: string } {
  const preset = findProviderPreset(runtime, settings?.preset);
  return {
    ...preset?.settings,
    ...Object.fromEntries(
      Object.entries(settings ?? {}).filter(([, value]) => value !== undefined),
    ),
    ...(preset?.piKeyEnv ? { piKeyEnv: preset.piKeyEnv } : {}),
  };
}
