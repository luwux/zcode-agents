// 内置 ACP Runtime 设置的纯逻辑：由 Host 状态得到已保存配置，按用户操作生成下一份保存入参。
// Renderer 只持有未提交的输入草稿；写入一律经 saveAgentRuntimeConfig，结果以 Host 返回的状态为准。
import type {
  AgentAuthMode,
  AgentModelSettings,
  AgentProviderSettings,
  AgentRuntimeInstallStatus,
  BuiltinProviderPresetView,
  BuiltinRuntimeCatalogEntry,
  PiEndpointApi,
  ReasoningLevel,
  SaveBuiltinRuntimeConfigInput,
} from "@zcode/services";
import { agentRuntimeIdSchema } from "@zcode/shared";

export type BuiltinAcpStatus = AgentRuntimeInstallStatus & {
  builtin: NonNullable<AgentRuntimeInstallStatus["builtin"]>;
};

export function isBuiltinAcpStatus(
  status: AgentRuntimeInstallStatus | undefined,
): status is BuiltinAcpStatus {
  return Boolean(status?.builtin);
}

/** 已保存的配置：写入队列以它为基线生成下一份完整配置。 */
export interface BuiltinAcpConfig {
  id: string;
  name: string;
  runtime: BuiltinRuntimeCatalogEntry["runtime"];
  auth: AgentAuthMode;
  provider?: AgentProviderSettings;
  enabled: boolean;
}

export function configFromStatus(status: BuiltinAcpStatus): BuiltinAcpConfig {
  return {
    id: status.id,
    name: status.name,
    runtime: status.builtin.runtime,
    auth: status.builtin.authMode,
    ...(status.builtin.provider ? { provider: status.builtin.provider } : {}),
    enabled: status.builtin.enabled,
  };
}

/** `env` 不在设置页编辑，省略后 Host 保留已保存值；`apiKey` undefined 表示不改 Key。 */
export function toSaveInput(
  config: BuiltinAcpConfig,
  extra: { apiKey?: string | null; create?: boolean } = {},
): SaveBuiltinRuntimeConfigInput {
  return {
    id: config.id,
    name: config.name,
    runtime: config.runtime,
    auth: config.auth,
    ...(config.provider ? { provider: config.provider } : {}),
    enabled: config.enabled,
    ...(extra.apiKey !== undefined ? { apiKey: extra.apiKey } : {}),
    ...(extra.create ? { create: true } : {}),
  };
}

export function findPreset(
  entry: BuiltinRuntimeCatalogEntry,
  presetId: string | undefined,
): BuiltinProviderPresetView | undefined {
  return entry.presets.find((preset) => preset.id === presetId);
}

/** 新 BYOK 配置默认走 OpenRouter（三个 Runtime 都支持），否则取第一个预设。 */
export function preferredPresetId(entry: BuiltinRuntimeCatalogEntry): string {
  return (
    entry.presets.find((preset) => preset.id === "openrouter")?.id ?? entry.presets[0]?.id ?? ""
  );
}

export function currentPresetId(config: BuiltinAcpConfig, entry: BuiltinRuntimeCatalogEntry) {
  return config.provider?.preset ?? preferredPresetId(entry);
}

/** 输入框展示的端点：已保存的覆盖值，否则是预设默认端点。 */
export function effectiveBaseUrl(config: BuiltinAcpConfig, entry: BuiltinRuntimeCatalogEntry) {
  return (
    config.provider?.baseUrl ?? findPreset(entry, currentPresetId(config, entry))?.baseUrl ?? ""
  );
}

/** 声明的模型；旧版单模型 `model` 视为一项（与 Host 的 configuredModels 一致）。 */
export function configModels(config: BuiltinAcpConfig): AgentModelSettings[] {
  const provider = config.provider;
  if (provider?.models) return [...provider.models];
  return provider?.model ? [{ id: provider.model }] : [];
}

export function withAuth(config: BuiltinAcpConfig, auth: AgentAuthMode): BuiltinAcpConfig {
  return { ...config, auth };
}

export function withName(config: BuiltinAcpConfig, name: string): BuiltinAcpConfig {
  return { ...config, name: name.trim() };
}

export function withEnabled(config: BuiltinAcpConfig, enabled: boolean): BuiltinAcpConfig {
  return { ...config, enabled };
}

/**
 * 切换预设：端点、协议与只能由脚本设置的路由字段（providerId、wireApi、smallModel、timeoutMs）属于旧预设，
 * 一并丢弃；声明的模型保留。
 */
export function withPreset(config: BuiltinAcpConfig, presetId: string): BuiltinAcpConfig {
  const models = configModels(config);
  return {
    ...config,
    provider: { preset: presetId, ...(models.length ? { models } : {}) },
  };
}

/** 端点等于预设默认值或为空时不保存覆盖值，预设调整默认端点后自动跟随。 */
export function withBaseUrl(
  config: BuiltinAcpConfig,
  entry: BuiltinRuntimeCatalogEntry,
  value: string,
): BuiltinAcpConfig {
  const baseUrl = value.trim();
  const { baseUrl: _previous, ...provider } = config.provider ?? {};
  const preset = findPreset(entry, currentPresetId(config, entry));
  return {
    ...config,
    provider: {
      ...provider,
      preset: currentPresetId(config, entry),
      ...(baseUrl && baseUrl !== preset?.baseUrl ? { baseUrl } : {}),
    },
  };
}

export type BaseUrlIssue = "baseUrlRequired" | "baseUrlInvalid";

export function validateBaseUrl(
  entry: BuiltinRuntimeCatalogEntry,
  presetId: string,
  value: string,
): BaseUrlIssue | null {
  const baseUrl = value.trim();
  if (!baseUrl) return findPreset(entry, presetId)?.requiresBaseUrl ? "baseUrlRequired" : null;
  return /^https?:\/\/\S+$/.test(baseUrl) ? null : "baseUrlInvalid";
}

export function withApiFormat(config: BuiltinAcpConfig, api: PiEndpointApi): BuiltinAcpConfig {
  return { ...config, provider: { ...config.provider, api } };
}

/** 保存模型列表时去掉旧版 `model` 字段，列表成为唯一来源。 */
export function withModels(
  config: BuiltinAcpConfig,
  models: readonly AgentModelSettings[],
): BuiltinAcpConfig {
  const { model: _legacy, ...provider } = config.provider ?? {};
  return { ...config, provider: { ...provider, models: [...models] } };
}

export function reorderModels(
  models: readonly AgentModelSettings[],
  ids: readonly string[],
): AgentModelSettings[] {
  const byId = new Map(models.map((model) => [model.id, model]));
  const ordered = ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
  return [...ordered, ...models.filter((model) => !ids.includes(model.id))];
}

/** 模型编辑弹窗的草稿；数值保留字符串输入，提交时再校验。 */
export interface ModelDraft {
  id: string;
  name: string;
  contextWindow: string;
  maxTokens: string;
  vision: boolean;
  reasoning: boolean;
  reasoningLevels: ReasoningLevel[];
}

export function modelDraft(
  entry: BuiltinRuntimeCatalogEntry,
  model?: AgentModelSettings,
): ModelDraft {
  return {
    id: model?.id ?? "",
    name: model?.name ?? "",
    contextWindow: model?.contextWindow ? String(model.contextWindow) : "",
    maxTokens: model?.maxTokens ? String(model.maxTokens) : "",
    vision: model?.vision === true,
    reasoning: model?.reasoning !== false,
    reasoningLevels: [...(model?.reasoningLevels ?? entry.defaultReasoningLevels)],
  };
}

export type ModelDraftIssue =
  | "modelIdRequired"
  | "modelIdInvalid"
  | "modelIdTaken"
  | "tooManyModels"
  | "contextWindowInvalid"
  | "maxTokensInvalid"
  | "reasoningLevelsRequired";

const positiveInteger = (value: string) => {
  const parsed = Number(value.trim());
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

export function validateModelDraft(params: {
  draft: ModelDraft;
  entry: BuiltinRuntimeCatalogEntry;
  models: readonly AgentModelSettings[];
  editingIndex?: number;
}): ModelDraftIssue | null {
  const { draft, entry, models, editingIndex } = params;
  const id = draft.id.trim();
  if (!id) return "modelIdRequired";
  if (/\s/.test(id)) return "modelIdInvalid";
  if (models.some((model, index) => model.id === id && index !== editingIndex))
    return "modelIdTaken";
  if (editingIndex === undefined && models.length >= entry.maxModels) return "tooManyModels";
  const fields = entry.modelFields;
  if (fields.contextWindow && draft.contextWindow.trim() && !positiveInteger(draft.contextWindow))
    return "contextWindowInvalid";
  if (fields.maxTokens && draft.maxTokens.trim() && !positiveInteger(draft.maxTokens))
    return "maxTokensInvalid";
  if (fields.reasoning && draft.reasoning && !draft.reasoningLevels.length)
    return "reasoningLevelsRequired";
  return null;
}

/** 由草稿得到模型设置：只写该 Runtime 使用的字段，保留启停与 Host 分配的槽位。 */
export function modelFromDraft(
  draft: ModelDraft,
  entry: BuiltinRuntimeCatalogEntry,
  previous?: AgentModelSettings,
): AgentModelSettings {
  const id = draft.id.trim();
  const name = draft.name.trim();
  const fields = entry.modelFields;
  const levels = entry.reasoningLevels.filter((level) => draft.reasoningLevels.includes(level));
  const defaultLevels =
    levels.length === entry.defaultReasoningLevels.length &&
    levels.every((level) => entry.defaultReasoningLevels.includes(level));
  return {
    id,
    ...(name && name !== id ? { name } : {}),
    ...(previous?.enabled === false ? { enabled: false } : {}),
    ...(previous?.slot === undefined ? {} : { slot: previous.slot }),
    ...(fields.reasoning && !draft.reasoning ? { reasoning: false } : {}),
    ...(fields.reasoning && draft.reasoning && !defaultLevels ? { reasoningLevels: levels } : {}),
    ...(fields.contextWindow && positiveInteger(draft.contextWindow)
      ? { contextWindow: positiveInteger(draft.contextWindow)! }
      : {}),
    ...(fields.maxTokens && positiveInteger(draft.maxTokens)
      ? { maxTokens: positiveInteger(draft.maxTokens)! }
      : {}),
    ...(fields.vision && draft.vision ? { vision: true } : {}),
  };
}

/** 添加页的草稿（Runtime、ID、名称与首次连接设置）。 */
export interface CreateDraft {
  runtime: BuiltinRuntimeCatalogEntry["runtime"];
  id: string;
  name: string;
  /** 用户改过 ID/名称后不再自动建议。 */
  idTouched: boolean;
  nameTouched: boolean;
  auth: AgentAuthMode;
  preset: string;
  baseUrl: string;
  api: PiEndpointApi | "";
  apiKey: string;
  model: string;
}

export function createDraft(entry: BuiltinRuntimeCatalogEntry): CreateDraft {
  const preset = preferredPresetId(entry);
  return {
    runtime: entry.runtime,
    id: "",
    name: "",
    idTouched: false,
    nameTouched: false,
    auth: entry.authModes.includes("byok") ? "byok" : entry.authModes[0]!,
    preset,
    baseUrl: findPreset(entry, preset)?.baseUrl ?? "",
    api: findPreset(entry, preset)?.defaultApi ?? "",
    apiKey: "",
    model: "",
  };
}

/** 建议如 `claude-code-openrouter` / “Claude Code (OpenRouter)”，并避开已占用的 ID。 */
export function suggestIdentity(
  entry: BuiltinRuntimeCatalogEntry,
  draft: Pick<CreateDraft, "auth" | "preset">,
  detailLabel: string,
  existingIds: readonly string[],
): { id: string; name: string } {
  const suffix = draft.auth === "byok" ? draft.preset : draft.auth;
  const base = `${entry.runtime}-${suffix}`.replace(/[^a-z0-9-]+/g, "-").slice(0, 60);
  let id = base;
  for (let index = 2; existingIds.includes(id); index += 1) id = `${base}-${index}`;
  return { id, name: `${entry.name} (${detailLabel})` };
}

export type CreateIssue =
  | "nameRequired"
  | "idInvalid"
  | "idTaken"
  | BaseUrlIssue
  | "modelRequired"
  | "apiKeyRequired";

export function validateCreate(
  draft: CreateDraft,
  entry: BuiltinRuntimeCatalogEntry,
  existingIds: readonly string[],
): CreateIssue | null {
  const id = draft.id.trim();
  if (!agentRuntimeIdSchema.safeParse(id).success) return "idInvalid";
  if (existingIds.includes(id)) return "idTaken";
  if (!draft.name.trim()) return "nameRequired";
  if (draft.auth !== "byok") return null;
  const baseUrlIssue = validateBaseUrl(entry, draft.preset, draft.baseUrl);
  if (baseUrlIssue) return baseUrlIssue;
  if (findPreset(entry, draft.preset)?.requiresModel && !draft.model.trim()) return "modelRequired";
  // 新建的 BYOK 配置没有 Key 无法使用；Key 只在此刻提交，之后不会回显。
  if (!draft.apiKey.trim()) return "apiKeyRequired";
  return null;
}

export function createInput(
  draft: CreateDraft,
  entry: BuiltinRuntimeCatalogEntry,
): SaveBuiltinRuntimeConfigInput {
  let config: BuiltinAcpConfig = {
    id: draft.id.trim(),
    name: draft.name.trim(),
    runtime: entry.runtime,
    auth: draft.auth,
    enabled: true,
  };
  if (draft.auth === "byok") {
    config = withBaseUrl(withPreset(config, draft.preset), entry, draft.baseUrl);
    const preset = findPreset(entry, draft.preset);
    if (preset?.apiOptions) config = withApiFormat(config, draft.api || preset.defaultApi!);
    if (draft.model.trim()) config = withModels(config, [{ id: draft.model.trim() }]);
  }
  return toSaveInput(config, {
    create: true,
    ...(draft.auth === "byok" ? { apiKey: draft.apiKey.trim() } : {}),
  });
}

/**
 * 认证方式 + Provider 路由（不含声明的模型）。与 Host 清空同步模型目录的条件一致：
 * 它变化后依赖旧目录的界面（同步结果、开关）需要重新初始化。
 */
export function routingKey(config: BuiltinAcpConfig): string {
  const { models: _models, ...provider } = config.provider ?? {};
  return JSON.stringify([config.auth, provider]);
}
