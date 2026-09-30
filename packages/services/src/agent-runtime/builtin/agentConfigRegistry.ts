import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWritePrivateTextFile, withFileLock } from "@zcode/shared/node";
import { agentRuntimeIdSchema } from "@zcode/shared";
import { getAppConfigDir } from "#src/paths.js";
import {
  BUILTIN_RUNTIME_DEFINITIONS,
  RESERVED_AGENT_IDS,
  isBuiltinAcpRuntime,
  type AgentAuthMode,
  type BuiltinAcpRuntime,
} from "#src/agent-runtime/builtin/builtinRuntimeCatalog.js";
import {
  REASONING_LEVELS,
  findProviderPreset,
  type AgentModelSettings,
  type AgentProviderSettings,
  type ReasoningLevel,
} from "#src/agent-runtime/builtin/builtinProviderPresets.js";

export interface AgentConfig {
  id: string;
  name: string;
  runtime: BuiltinAcpRuntime;
  auth: AgentAuthMode;
  provider?: AgentProviderSettings;
  /** 非秘密的附加变量；含 KEY/TOKEN/SECRET/PASSWORD 的名字必须改用加密的 apiKey。 */
  env?: Record<string, string>;
  /** false 时不在输入框模型选择器中提供该配置；缺省为 true。 */
  enabled?: boolean;
  /** 是否来自默认内置条目（未落盘）。 */
  builtinDefault?: boolean;
}

export interface AgentConfigIssue {
  id: string;
  message: string;
}

export interface AgentConfigSnapshot {
  path: string;
  configs: readonly AgentConfig[];
  issues: readonly AgentConfigIssue[];
}

const DEFAULT_CONFIGS: readonly AgentConfig[] = [
  { id: "claude-code", name: "Claude Code", runtime: "claude-code", auth: "subscription" },
  { id: "codex", name: "Codex", runtime: "codex", auth: "subscription" },
  { id: "pi", name: "Pi", runtime: "pi", auth: "byok", provider: { preset: "openrouter" } },
].map((config) => ({ ...config, builtinDefault: true }) as AgentConfig);

/** 未落盘也存在的默认配置 ID；设置页据此区分“删除”与“恢复默认”。 */
export const DEFAULT_AGENT_CONFIG_IDS: readonly string[] = DEFAULT_CONFIGS.map(
  (config) => config.id,
);

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
// 只拦截形如密钥的名字；MAX_THINKING_TOKENS、CLAUDE_CODE_MAX_OUTPUT_TOKENS 等普通变量放行。
const SECRET_LIKE = /(^|_)(API_)?KEY$|(^|_)TOKEN$|SECRET|PASSWORD|CREDENTIAL/;
/** 这些变量由 Host 负责构造，配置不得覆盖，否则可以绕过 home 隔离或改写启动方式。 */
export const RESERVED_ENV = new Set([
  "PATH",
  "HOME",
  "USERPROFILE",
  "NODE_OPTIONS",
  "ELECTRON_RUN_AS_NODE",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_EXECUTABLE",
  "CODEX_HOME",
  "CODEX_PATH",
  "CODEX_CONFIG",
  "MODEL_PROVIDER",
  "DEFAULT_AUTH_REQUEST",
  "PI_CODING_AGENT_DIR",
  "PI_CODING_AGENT_SESSION_DIR",
  "NO_PROXY",
  "no_proxy",
]);

export function getAgentConfigsPath(): string {
  return join(getAppConfigDir(), "agent-configs.json");
}

export function secretCredentialKey(id: string): string {
  return `acp-agent-config/${id}/apiKey`;
}

export async function readAgentConfigs(path = getAgentConfigsPath()): Promise<AgentConfigSnapshot> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { path, configs: DEFAULT_CONFIGS, issues: [] };
    // 修复原因：文件不可读时若回退到默认条目，用户的 BYOK 覆盖会静默变成订阅执行；失败即关闭。
    return {
      path,
      configs: [],
      issues: [{ id: "agents", message: `Configuration could not be read: ${String(error)}` }],
    };
  }
  if (!isRecord(raw) || !isRecord(raw.agents))
    return {
      path,
      configs: [],
      issues: [{ id: "agents", message: "Expected an agents object" }],
    };
  const configs = new Map(DEFAULT_CONFIGS.map((config) => [config.id, config]));
  const issues: AgentConfigIssue[] = [];
  for (const [id, value] of Object.entries(raw.agents)) {
    const parsed = parseAgentConfig(id, value);
    if (typeof parsed === "string") {
      issues.push({ id, message: parsed });
      // 覆盖默认 ID 的条目无效时，该 ID 不可用，而不是复活默认配置（同 fingerprint 会接管旧会话）。
      configs.delete(id);
    } else configs.set(id, parsed);
  }
  return { path, configs: [...configs.values()], issues };
}

export async function findAgentConfig(id: string): Promise<AgentConfig | null> {
  return (await readAgentConfigs()).configs.find((config) => config.id === id) ?? null;
}

/** 返回错误信息字符串或规范化配置；与 agent_servers 一样按 ID 隔离无效项。 */
export function parseAgentConfig(id: string, value: unknown): AgentConfig | string {
  if (!agentRuntimeIdSchema.safeParse(id).success || RESERVED_AGENT_IDS.has(id))
    return "Invalid or reserved Agent ID";
  if (!isRecord(value)) return "Expected an object";
  const allowed = ["name", "runtime", "auth", "provider", "env", "enabled"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) return "Unknown configuration key";
  if (typeof value.name !== "string" || !value.name.trim()) return "Expected a name";
  if (typeof value.runtime !== "string" || !isBuiltinAcpRuntime(value.runtime))
    return "Unknown runtime";
  const runtime = value.runtime;
  const definition = BUILTIN_RUNTIME_DEFINITIONS[runtime];
  if (!definition.authModes.includes(value.auth as AgentAuthMode))
    return `Auth mode must be one of ${definition.authModes.join(", ")}`;
  const provider =
    value.provider === undefined ? undefined : parseProvider(runtime, value.provider);
  if (typeof provider === "string") return provider;
  const env = value.env === undefined ? undefined : parseEnv(value.env);
  if (typeof env === "string") return env;
  if (value.enabled !== undefined && typeof value.enabled !== "boolean")
    return "enabled must be a boolean";
  return {
    id,
    name: value.name.trim(),
    runtime,
    auth: value.auth as AgentAuthMode,
    ...(provider ? { provider } : {}),
    ...(env ? { env } : {}),
    ...(value.enabled === false ? { enabled: false } : {}),
  };
}

function parseProvider(runtime: BuiltinAcpRuntime, value: unknown): AgentProviderSettings | string {
  if (!isRecord(value)) return "provider must be an object";
  const strings = ["preset", "baseUrl", "model", "smallModel", "providerId"] as const;
  const result: AgentProviderSettings = {};
  for (const key of Object.keys(value)) {
    if (![...strings, "wireApi", "api", "timeoutMs", "models"].includes(key))
      return `Unknown provider key ${key}`;
  }
  for (const key of strings) {
    const field = value[key];
    if (field === undefined) continue;
    if (typeof field !== "string" || !field.trim()) return `provider.${key} must be a string`;
    result[key] = field.trim();
  }
  if (result.preset && !findProviderPreset(runtime, result.preset))
    return `Unknown ${runtime} provider preset ${result.preset}`;
  if (result.baseUrl && !/^https?:\/\/[^\s]+$/.test(result.baseUrl))
    return "provider.baseUrl must be an absolute http(s) URL";
  if (result.providerId && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(result.providerId))
    return "provider.providerId must be a lowercase identifier";
  if (value.wireApi !== undefined) {
    if (value.wireApi !== "responses" && value.wireApi !== "chat")
      return "provider.wireApi must be responses or chat";
    result.wireApi = value.wireApi;
  }
  if (value.api !== undefined) {
    if (
      !["anthropic-messages", "openai-responses", "openai-completions"].includes(String(value.api))
    )
      return "provider.api is not supported";
    result.api = value.api as AgentProviderSettings["api"];
  }
  if (value.timeoutMs !== undefined) {
    if (
      typeof value.timeoutMs !== "number" ||
      !Number.isInteger(value.timeoutMs) ||
      value.timeoutMs <= 0
    )
      return "provider.timeoutMs must be a positive integer";
    result.timeoutMs = value.timeoutMs;
  }
  if (value.models !== undefined) {
    const models = parseModels(runtime, value.models);
    if (typeof models === "string") return models;
    result.models = models;
  }
  return result;
}

const MODEL_KEYS = [
  "id",
  "name",
  "enabled",
  "reasoning",
  "reasoningLevels",
  "contextWindow",
  "maxTokens",
  "vision",
  "slot",
];

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** 用户声明的模型列表：ID 唯一，数量受 Runtime 能原生列出的上限约束。 */
function parseModels(runtime: BuiltinAcpRuntime, value: unknown): AgentModelSettings[] | string {
  if (!Array.isArray(value)) return "provider.models must be an array";
  const limit = BUILTIN_RUNTIME_DEFINITIONS[runtime].maxConfiguredModels;
  if (value.length > limit) return `${runtime} supports at most ${limit} models per configuration`;
  const seen = new Set<string>();
  const models: AgentModelSettings[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return "provider.models entries must be objects";
    if (Object.keys(entry).some((key) => !MODEL_KEYS.includes(key)))
      return "Unknown provider.models key";
    if (typeof entry.id !== "string" || !entry.id.trim() || /\s/.test(entry.id.trim()))
      return "provider.models[].id must be a model ID without spaces";
    const id = entry.id.trim();
    if (seen.has(id)) return `Duplicate model ${id}`;
    seen.add(id);
    const model: AgentModelSettings = { id };
    if (entry.name !== undefined) {
      if (typeof entry.name !== "string") return "provider.models[].name must be a string";
      if (entry.name.trim() && entry.name.trim() !== id) model.name = entry.name.trim();
    }
    for (const key of ["enabled", "reasoning", "vision"] as const) {
      if (entry[key] === undefined) continue;
      if (typeof entry[key] !== "boolean") return `provider.models[].${key} must be a boolean`;
      model[key] = entry[key];
    }
    for (const key of ["contextWindow", "maxTokens"] as const) {
      if (entry[key] === undefined) continue;
      if (!isPositiveInteger(entry[key]))
        return `provider.models[].${key} must be a positive integer`;
      model[key] = entry[key];
    }
    if (entry.slot !== undefined) {
      const slot = entry.slot;
      if (runtime !== "claude-code" || typeof slot !== "number" || !Number.isInteger(slot))
        return "provider.models[].slot is only valid for Claude Code";
      if (slot < 0 || slot >= limit || models.some((model) => model.slot === slot))
        return "provider.models[].slot must be a unique Claude model slot";
      model.slot = slot;
    }
    if (entry.reasoningLevels !== undefined) {
      const levels = entry.reasoningLevels;
      if (
        !Array.isArray(levels) ||
        levels.some((level) => !(REASONING_LEVELS as readonly unknown[]).includes(level)) ||
        new Set(levels).size !== levels.length
      )
        return `provider.models[].reasoningLevels must be unique values of ${REASONING_LEVELS.join(", ")}`;
      // 按固定顺序保存，便于比较与生成各 Runtime 的档位列表。
      model.reasoningLevels = REASONING_LEVELS.filter((level) =>
        (levels as ReasoningLevel[]).includes(level),
      );
    }
    models.push(model);
  }
  return models;
}

function parseEnv(value: unknown): Record<string, string> | string {
  if (!isRecord(value)) return "env must be an object";
  const result: Record<string, string> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (!ENV_NAME.test(name)) return `Invalid env name ${name}`;
    if (RESERVED_ENV.has(name)) return `env ${name} is managed by CodeZ`;
    if (SECRET_LIKE.test(name)) return `env ${name} looks secret; store it as the config API key`;
    if (typeof entry !== "string") return `env ${name} must be a string`;
    result[name] = entry;
  }
  return result;
}

export interface AgentConfigInput {
  id: string;
  name: string;
  runtime: string;
  auth: string;
  provider?: AgentProviderSettings;
  env?: Record<string, string>;
  enabled?: boolean;
}

/** 只改指定 ID；格式错误的现有文件拒绝覆盖。 */
export async function saveAgentConfig(input: AgentConfigInput): Promise<AgentConfig> {
  const { id, ...value } = input;
  const parsed = parseAgentConfig(id, JSON.parse(JSON.stringify(value)) as unknown);
  if (typeof parsed === "string") throw new Error(parsed);
  const path = getAgentConfigsPath();
  await withFileLock(path, async () => {
    const document = await readDocument(path);
    document.agents[id] = serialize(parsed);
    await atomicWritePrivateTextFile(path, `${JSON.stringify(document, null, 2)}\n`);
  });
  return parsed;
}

/** 删除落盘条目；默认条目随后恢复为内置默认值。 */
export async function deleteAgentConfig(id: string): Promise<void> {
  const path = getAgentConfigsPath();
  await withFileLock(path, async () => {
    const document = await readDocument(path);
    if (!Object.hasOwn(document.agents, id)) throw new Error("Agent config is not saved");
    delete document.agents[id];
    await atomicWritePrivateTextFile(path, `${JSON.stringify(document, null, 2)}\n`);
  });
}

async function readDocument(path: string): Promise<{ agents: Record<string, unknown> }> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!isRecord(raw) || !isRecord(raw.agents))
      throw new Error("Existing agent configs are invalid");
    return { agents: { ...raw.agents } };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { agents: {} };
    throw error;
  }
}

function serialize(config: AgentConfig): Record<string, unknown> {
  return {
    name: config.name,
    runtime: config.runtime,
    auth: config.auth,
    ...(config.provider ? { provider: config.provider } : {}),
    ...(config.env ? { env: config.env } : {}),
    ...(config.enabled === false ? { enabled: false } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
