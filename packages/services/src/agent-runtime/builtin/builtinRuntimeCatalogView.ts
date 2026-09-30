import { DEFAULT_AGENT_CONFIG_IDS } from "#src/agent-runtime/builtin/agentConfigRegistry.js";
import {
  supportsDeviceSignIn,
  supportsSubscriptionSignIn,
} from "#src/agent-runtime/builtin/builtinRuntimeAuth.js";
import {
  BUILTIN_ACP_RUNTIMES,
  BUILTIN_RUNTIME_DEFINITIONS,
  type AgentAuthMode,
  type BuiltinAcpRuntime,
} from "#src/agent-runtime/builtin/builtinRuntimeCatalog.js";
import {
  DEFAULT_REASONING_LEVELS,
  PROVIDER_PRESETS,
  REASONING_LEVELS,
  type AgentProviderSettings,
  type ProviderPreset,
  type ReasoningLevel,
} from "#src/agent-runtime/builtin/builtinProviderPresets.js";
import {
  MODEL_FIELD_SUPPORT,
  type ModelFieldSupport,
} from "#src/agent-runtime/builtin/builtinModels.js";

export type PiEndpointApi = NonNullable<AgentProviderSettings["api"]>;

const PI_ENDPOINT_APIS: readonly PiEndpointApi[] = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
];
const CUSTOM_PRESET_ID = "custom";

/** 设置页可展示的 Provider 预设；只含代码常量，不含秘密。 */
export interface BuiltinProviderPresetView {
  id: string;
  name: string;
  /** 预设默认端点（作为输入提示）；无默认端点的预设不展示 Base URL。 */
  baseUrl?: string;
  /** 自定义预设必须由用户提供端点。 */
  requiresBaseUrl: boolean;
  /** Pi 内置 provider（无端点的预设）改写端点会切到自定义端点路由，不允许在该预设下修改。 */
  baseUrlEditable: boolean;
  /** Pi 经 OpenAI/Anthropic 兼容端点（models.json）时必须指定模型。 */
  requiresModel: boolean;
  /** Pi 自定义端点可选协议；缺省表示不可选。 */
  apiOptions?: readonly PiEndpointApi[];
  defaultApi?: PiEndpointApi;
}

export interface BuiltinRuntimeCatalogEntry {
  runtime: BuiltinAcpRuntime;
  name: string;
  version: string;
  authModes: readonly AgentAuthMode[];
  presets: readonly BuiltinProviderPresetView[];
  /** 订阅/CLI 登录模式下是否可由 CodeZ 发起登录。 */
  signIn: boolean;
  /** 是否提供设备码登录（无浏览器回调的主机）。 */
  deviceSignIn: boolean;
  /** BYOK 可声明的模型数上限。 */
  maxModels: number;
  /** 模型编辑器中可用的字段。 */
  modelFields: ModelFieldSupport;
  /** 可选的推理档位与未设置时的默认档位。 */
  reasoningLevels: readonly ReasoningLevel[];
  defaultReasoningLevels: readonly ReasoningLevel[];
  /** 当前 Host 平台不支持时的原因。 */
  unsupportedReason?: string;
}

export interface BuiltinRuntimeCatalogView {
  runtimes: BuiltinRuntimeCatalogEntry[];
  /** 未落盘也存在的默认配置 ID：不可删除，覆盖后删除即恢复默认。 */
  defaultConfigIds: string[];
}

function describePreset(
  runtime: BuiltinAcpRuntime,
  preset: ProviderPreset,
): BuiltinProviderPresetView {
  const custom = preset.id === CUSTOM_PRESET_ID;
  // 与 builtinRuntimeEnv.applyPi 一致：有端点即走 models.json 自定义 provider，必须给出模型。
  const piEndpoint = runtime === "pi" && (custom || Boolean(preset.settings.baseUrl));
  return {
    id: preset.id,
    name: preset.name,
    ...(preset.settings.baseUrl ? { baseUrl: preset.settings.baseUrl } : {}),
    requiresBaseUrl: custom,
    baseUrlEditable: runtime !== "pi" || piEndpoint,
    requiresModel: piEndpoint,
    ...(runtime === "pi" && custom
      ? { apiOptions: PI_ENDPOINT_APIS, defaultApi: preset.settings.api ?? "openai-completions" }
      : {}),
  };
}

export function describeBuiltinRuntimeCatalog(
  platform: NodeJS.Platform = process.platform,
): BuiltinRuntimeCatalogView {
  return {
    runtimes: BUILTIN_ACP_RUNTIMES.map((runtime) => {
      const definition = BUILTIN_RUNTIME_DEFINITIONS[runtime];
      const unsupported = definition.unsupportedReason(platform);
      return {
        runtime,
        name: definition.name,
        version: definition.version,
        authModes: [...definition.authModes],
        presets: PROVIDER_PRESETS[runtime].map((preset) => describePreset(runtime, preset)),
        signIn: supportsSubscriptionSignIn(runtime),
        deviceSignIn: supportsDeviceSignIn(runtime),
        maxModels: definition.maxConfiguredModels,
        modelFields: MODEL_FIELD_SUPPORT[runtime],
        reasoningLevels: REASONING_LEVELS,
        defaultReasoningLevels: DEFAULT_REASONING_LEVELS,
        ...(unsupported ? { unsupportedReason: unsupported } : {}),
      };
    }),
    defaultConfigIds: [...DEFAULT_AGENT_CONFIG_IDS],
  };
}
