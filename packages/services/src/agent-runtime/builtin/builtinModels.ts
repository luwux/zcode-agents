// BYOK 配置声明的模型：各 Runtime 原生列出这些模型的方式（纯函数，供 env 构造与状态投影共用）。
import type { BuiltinAcpRuntime } from "#src/agent-runtime/builtin/builtinRuntimeCatalog.js";
import {
  DEFAULT_REASONING_LEVELS,
  type AgentModelSettings,
  type AgentProviderSettings,
  type ReasoningLevel,
} from "#src/agent-runtime/builtin/builtinProviderPresets.js";

/** Pi 自定义端点在 models.json 中的 provider 名；模型选项值为 `codez/<模型 ID>`。 */
export const PI_CUSTOM_PROVIDER_ID = "codez";

/**
 * Claude Code 2.1.x 的模型槽：四个别名（opus/sonnet/haiku/fable）与一个自定义选项。每个槽可设
 * `<槽>_NAME` 与 `<槽>_SUPPORTED_CAPABILITIES`；适配器把别名列为模型选项，自定义选项的值即模型 ID。
 */
export const CLAUDE_MODEL_SLOTS = [
  { env: "ANTHROPIC_DEFAULT_OPUS_MODEL", alias: "opus" },
  { env: "ANTHROPIC_DEFAULT_SONNET_MODEL", alias: "sonnet" },
  { env: "ANTHROPIC_DEFAULT_HAIKU_MODEL", alias: "haiku" },
  { env: "ANTHROPIC_DEFAULT_FABLE_MODEL", alias: "fable" },
  { env: "ANTHROPIC_CUSTOM_MODEL_OPTION", alias: null },
] as const;

/** 设置页可按模型编辑的字段：只列出该 Runtime 生成的配置真正使用的字段。 */
export interface ModelFieldSupport {
  contextWindow: boolean;
  maxTokens: boolean;
  vision: boolean;
  /** 按模型开关推理并选择档位（Claude 自行决定网关模型的思考方式，不提供）。 */
  reasoning: boolean;
}

export const MODEL_FIELD_SUPPORT: Readonly<Record<BuiltinAcpRuntime, ModelFieldSupport>> = {
  "claude-code": { contextWindow: false, maxTokens: false, vision: false, reasoning: false },
  codex: { contextWindow: true, maxTokens: false, vision: true, reasoning: true },
  pi: { contextWindow: true, maxTokens: true, vision: true, reasoning: true },
};

/** 声明的模型列表；旧版单模型 `model` 视为只含一项的列表，`models`（含空数组）存在时以其为准。 */
export function configuredModels(
  provider: AgentProviderSettings | undefined,
): readonly AgentModelSettings[] {
  if (provider?.models) return provider.models;
  return provider?.model ? [{ id: provider.model }] : [];
}

/**
 * Claude 模型槽分配：先保留已持久化的槽，其余模型按顺序占用空闲槽。选项 ID 是槽别名，
 * 槽必须稳定，否则删除/调序会让既有会话的别名改指另一个模型。
 */
export function claudeSlotAssignments(models: readonly AgentModelSettings[]): number[] {
  const taken = new Set<number>();
  const slots = models.map((model) => {
    const slot = model.slot;
    if (slot === undefined || slot < 0 || slot >= CLAUDE_MODEL_SLOTS.length || taken.has(slot))
      return -1;
    taken.add(slot);
    return slot;
  });
  let next = 0;
  return slots.map((slot) => {
    if (slot >= 0) return slot;
    while (taken.has(next)) next += 1;
    taken.add(next);
    return next;
  });
}

/** 保存前为 Claude 模型持久化槽位；其他 Runtime 的选项 ID 基于模型 ID，本身稳定。 */
export function withStableModelSlots(
  runtime: BuiltinAcpRuntime,
  models: readonly AgentModelSettings[],
): AgentModelSettings[] {
  if (runtime !== "claude-code") return models.map(({ slot: _slot, ...model }) => model);
  const slots = claudeSlotAssignments(models);
  return models.map((model, index) => ({ ...model, slot: slots[index]! }));
}

/** 新会话未显式选择模型时的默认模型：第一个启用的模型。 */
export function defaultConfiguredModel(
  models: readonly AgentModelSettings[],
): AgentModelSettings | undefined {
  return models.find((model) => model.enabled !== false) ?? models[0];
}

/** 该模型提供的推理档位；关闭推理时为空。 */
export function effectiveReasoningLevels(model: AgentModelSettings): readonly ReasoningLevel[] {
  if (model.reasoning === false) return [];
  return model.reasoningLevels ?? DEFAULT_REASONING_LEVELS;
}

/** Pi 模型选项的 provider 前缀：有端点时走 models.json 自定义 provider，否则是 Pi 内置 provider。 */
export function piProviderName(settings: AgentProviderSettings): string {
  return settings.baseUrl ? PI_CUSTOM_PROVIDER_ID : (settings.providerId ?? "openrouter");
}

/**
 * 第 index 个声明模型在 ACP `model` 选项中的值（与 builtinRuntimeEnv 写入的配置一一对应，
 * 由真实适配器的 e2e 断言校验）：Claude 为槽别名、Codex 为模型 slug、Pi 为 `<provider>/<id>`。
 * `settings` 必须是 resolveProviderSettings 合并预设后的结果。
 */
export function configuredModelOptionValue(
  runtime: BuiltinAcpRuntime,
  settings: AgentProviderSettings,
  index: number,
): string {
  const model = configuredModels(settings)[index];
  if (!model) throw new Error(`Configured model ${index} does not exist`);
  switch (runtime) {
    case "claude-code":
      return (
        CLAUDE_MODEL_SLOTS[claudeSlotAssignments(configuredModels(settings))[index]!]?.alias ??
        model.id
      );
    case "codex":
      return model.id;
    case "pi":
      return `${piProviderName(settings)}/${model.id}`;
  }
}
