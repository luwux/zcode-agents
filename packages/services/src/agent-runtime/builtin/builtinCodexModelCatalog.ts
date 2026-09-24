// Codex BYOK 模型目录（`model_catalog_json`）。字段结构对应 codex 0.156.1 的
// codex-rs/protocol/src/openai_models.rs `ModelsResponse`/`ModelInfo`；未设置的字段沿用 Codex 对目录外
// 模型的兜底元数据（codex-rs/models-manager/src/model_info.rs `model_info_from_slug`），只补上推理档位、
// 上下文窗口与输入模态，其余行为与此前使用兜底元数据时一致。
import codexBaseInstructions from "./manifests/codex-base-instructions.json" with { type: "json" };
import type { AgentModelSettings, ReasoningLevel } from "./builtinProviderPresets.js";
import { effectiveReasoningLevels } from "./builtinModels.js";

/** Codex 兜底元数据的上下文窗口。 */
const FALLBACK_CONTEXT_WINDOW = 272_000;

const EFFORT_DESCRIPTIONS: Record<ReasoningLevel, string> = {
  minimal: "Minimal reasoning for the fastest responses",
  low: "Fast responses with lighter reasoning",
  medium: "Balances speed and reasoning depth for everyday tasks",
  high: "Greater reasoning depth for complex problems",
  xhigh: "Extra high reasoning depth for complex problems",
  max: "Maximum reasoning depth for the hardest problems",
};

/** 默认档位优先 medium（与 Codex 预设一致），否则取第一个。 */
function defaultEffort(levels: readonly ReasoningLevel[]): ReasoningLevel | undefined {
  return levels.includes("medium") ? "medium" : levels[0];
}

function codexModelInfo(model: AgentModelSettings, priority: number): Record<string, unknown> {
  const levels = effectiveReasoningLevels(model);
  const effort = defaultEffort(levels);
  const contextWindow = model.contextWindow ?? FALLBACK_CONTEXT_WINDOW;
  return {
    slug: model.id,
    display_name: model.name ?? model.id,
    description: null,
    ...(effort ? { default_reasoning_level: effort } : {}),
    supported_reasoning_levels: levels.map((level) => ({
      effort: level,
      description: EFFORT_DESCRIPTIONS[level],
    })),
    shell_type: "unified_exec",
    visibility: "list",
    supported_in_api: true,
    priority,
    additional_speed_tiers: [],
    service_tiers: [],
    availability_nux: null,
    upgrade: null,
    base_instructions: codexBaseInstructions.text,
    include_skills_usage_instructions: false,
    include_plugin_usage_instructions: false,
    include_apps_usage_instructions: false,
    default_reasoning_summary: "auto",
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: null,
    web_search_tool_type: "text",
    truncation_policy: { mode: "bytes", limit: 10_000 },
    supports_image_detail_original: false,
    context_window: contextWindow,
    max_context_window: contextWindow,
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    // 兜底元数据默认接受文本与图片；只有明确关闭视觉时收窄为纯文本。
    input_modalities: model.vision === false ? ["text"] : ["text", "image"],
    supports_search_tool: false,
  };
}

/** 只列出用户声明的模型（顺序即 priority），Codex 不再列出 OpenAI 预设。 */
export function codexModelCatalog(models: readonly AgentModelSettings[]): {
  models: Array<Record<string, unknown>>;
} {
  return { models: models.map((model, index) => codexModelInfo(model, index)) };
}
