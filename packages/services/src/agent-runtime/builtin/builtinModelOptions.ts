// BYOK 声明模型在输入框模型选择器中的条目：选项 ID 与推理档位直接由配置推出，无需先“同步 Agent 模型”。
// 推出的值与真实适配器公布的一致（test/e2e/builtinModelsReplay.e2e.ts 以固定版本的 CLI 校验）。
import { encodeModelOption } from "#src/agent-runtime/acpConnection.js";
import type { AgentConfig } from "#src/agent-runtime/builtin/agentConfigRegistry.js";
import {
  resolveProviderSettings,
  type AgentModelSettings,
  type ReasoningLevel,
} from "#src/agent-runtime/builtin/builtinProviderPresets.js";
import {
  configuredModelOptionValue,
  configuredModels,
  effectiveReasoningLevels,
} from "#src/agent-runtime/builtin/builtinModels.js";

/** 三个内置适配器的模型会话配置项 ID 都是 `model`。 */
const MODEL_CONFIG_OPTION_ID = "model";

export interface BuiltinModelOption {
  /** 工作台模型 ID（`acp:model:model:<值>`），创建会话时经 session/set_config_option 选中。 */
  id: string;
  /** 发送给 Provider 的模型 ID。 */
  modelId: string;
  name: string;
  enabled: boolean;
  thoughtLevels: Array<{ value: string; name: string }>;
}

const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

/** Claude 2.1.x 适配器对所有模型公布的 effort 选项（不受模型设置影响）。 */
const CLAUDE_EFFORT_LEVELS = ["default", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * 与各适配器公布的思考选项一致：Codex 为模型目录中的 effort（首字母大写），Pi 为 off + thinkingLevelMap
 * 允许的档位，Claude 为其固定的 effort 列表（它自行决定网关模型的思考方式，模型设置不改变该列表）。
 */
function thoughtLevels(
  runtime: AgentConfig["runtime"],
  model: AgentModelSettings,
): Array<{ value: string; name: string }> {
  const named = (items: readonly string[], name: (level: string) => string) =>
    items.map((level) => ({ value: level, name: name(level) }));
  if (runtime === "claude-code") return named(CLAUDE_EFFORT_LEVELS, capitalize);
  const levels: readonly ReasoningLevel[] = effectiveReasoningLevels(model);
  if (!levels.length) return [];
  return runtime === "codex"
    ? named(levels, capitalize)
    : [{ value: "off", name: "off" }, ...named(levels, (level) => level)];
}

/** BYOK 配置声明的模型（含已禁用的，便于设置页展示）；非 BYOK 或未声明模型时为空。 */
export function configuredModelOptions(config: AgentConfig): BuiltinModelOption[] {
  if (config.auth !== "byok") return [];
  const settings = resolveProviderSettings(config.runtime, config.provider);
  return configuredModels(settings).map((model, index) => ({
    id: encodeModelOption(
      MODEL_CONFIG_OPTION_ID,
      configuredModelOptionValue(config.runtime, settings, index),
    ),
    modelId: model.id,
    name: model.name ?? model.id,
    enabled: model.enabled !== false,
    thoughtLevels: thoughtLevels(config.runtime, model),
  }));
}

interface PickerModel {
  id: string;
  name: string;
  description?: string;
  thoughtLevels?: Array<{ value: string; name: string }>;
}

/**
 * 某配置在输入框模型选择器中提供的模型（models）与设置页可见的全部模型（availableModels）。
 * BYOK 声明了模型时以声明为准（不依赖同步缓存）；否则沿用“同步 Agent 模型”的缓存。停用的配置不提供模型。
 */
export async function projectBuiltinModels(params: {
  enabled: boolean;
  configured: readonly BuiltinModelOption[];
  catalog: () => Promise<{
    models: readonly PickerModel[];
    availableModels: readonly PickerModel[];
  }>;
}): Promise<{ models: PickerModel[]; availableModels: PickerModel[] }> {
  if (params.configured.length) {
    const toModel = ({ id, name, thoughtLevels: levels }: BuiltinModelOption): PickerModel => ({
      id,
      name,
      thoughtLevels: levels,
    });
    return {
      models: params.enabled ? params.configured.filter((model) => model.enabled).map(toModel) : [],
      availableModels: params.configured.map(toModel),
    };
  }
  const catalog = await params.catalog();
  return {
    models: params.enabled ? [...catalog.models] : [],
    availableModels: [...catalog.availableModels],
  };
}
