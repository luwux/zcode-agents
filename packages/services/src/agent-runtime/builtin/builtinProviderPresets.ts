import type { BuiltinAcpRuntime } from "#src/agent-runtime/builtin/builtinRuntimeCatalog.js";

/** 各 Runtime 都能表达的推理档位（Codex effort / Pi thinking level / Claude effort 能力）。 */
export const REASONING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];
/** 未单独设置时提供的档位；OpenRouter 等网关对不推理的模型会忽略 effort。 */
export const DEFAULT_REASONING_LEVELS: readonly ReasoningLevel[] = ["low", "medium", "high"];

/** BYOK 配置中用户声明的模型；Runtime 会原生列出这些模型（Pi models.json、Codex 模型目录、Claude 模型槽）。 */
export interface AgentModelSettings {
  /** 发送给 Provider 的模型 ID，如 `deepseek/deepseek-v4.1-flash`。 */
  id: string;
  name?: string;
  /** false 时不在输入框模型选择器中提供；缺省为 true。 */
  enabled?: boolean;
  /** 是否支持推理/思考；缺省为 true。 */
  reasoning?: boolean;
  /** 提供的推理档位；缺省为 DEFAULT_REASONING_LEVELS。 */
  reasoningLevels?: ReasoningLevel[];
  contextWindow?: number;
  maxTokens?: number;
  /** 是否接受图片输入。 */
  vision?: boolean;
  /** 仅 Claude：占用的模型槽（0-4），保存时分配并保持稳定，避免删改其他模型时别名改指。 */
  slot?: number;
}

/** 非秘密的 Provider 路由设置；密钥只以 `apiKey` 秘密单独保存。 */
export interface AgentProviderSettings {
  preset?: string;
  baseUrl?: string;
  /** 旧版单模型字段；`models` 缺省时视为只含该模型的列表。 */
  model?: string;
  models?: AgentModelSettings[];
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
    // 修复原因：Pi 内置 openrouter provider 对目录外模型（如 xiaomi/mimo-v2.6-flash）会挂起直到超时；
    // 走 OpenAI 兼容端点（models.json 自定义 provider）已在实测中完成任务。
    id: "openrouter",
    name: "OpenRouter",
    settings: { baseUrl: "https://openrouter.ai/api/v1", api: "openai-completions" },
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
