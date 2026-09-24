import { z } from "zod";
import { agentRuntimeIdSchema } from "@zcode/shared";
import { readAgentServersRegistry } from "#src/agent-runtime/agentServersRegistry.js";
import { acpAuthStateStore, type AcpAuthState } from "#src/agent-runtime/acpAuthState.js";
import {
  deleteAgentConfig,
  findAgentConfig,
  readAgentConfigs,
  saveAgentConfig,
  type AgentConfig,
  type AgentConfigInput,
} from "#src/agent-runtime/builtin/agentConfigRegistry.js";
import { mkdir, rm, stat } from "node:fs/promises";
import { saveAcpModels } from "#src/agent-runtime/acpProviderModels.js";
import {
  builtinConfigFingerprint,
  builtinConfigHome,
  resolveBuiltinLaunch,
  saveBuiltinConfigApiKey,
} from "#src/agent-runtime/builtin/builtinRuntimeLaunch.js";
import {
  logoutBuiltinRuntime,
  startBuiltinLogin,
} from "#src/agent-runtime/builtin/builtinRuntimeAuth.js";
import type { AgentProviderSettings } from "#src/agent-runtime/builtin/builtinProviderPresets.js";
import { isBuiltinAcpRuntime } from "#src/agent-runtime/builtin/builtinRuntimeCatalog.js";
import { withStableModelSlots } from "#src/agent-runtime/builtin/builtinModels.js";

/** 设置页/脚本保存内置配置的入参；`apiKey` null 删除、undefined 保持，`create` 拒绝覆盖既有 ID。 */
export type SaveBuiltinRuntimeConfigInput = AgentConfigInput & {
  apiKey?: string | null;
  create?: boolean;
};

export interface BuiltinRuntimeAuthResult {
  state: AcpAuthState;
  message?: string;
}

export interface BuiltinRuntimeAuthChange {
  runtimeId: string;
  state: AcpAuthState;
}

// RPC 入参来自 Renderer/手机 Web：先校验形状与类型，配置内容再由 parseAgentConfig 严格校验。
const saveRequestSchema = z.object({
  id: agentRuntimeIdSchema,
  name: z.string().max(200),
  runtime: z.string().max(64),
  auth: z.string().max(64),
  provider: z.record(z.string(), z.unknown()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional(),
  apiKey: z.string().max(16_384).nullable().optional(),
  create: z.boolean().optional(),
});

const loginRequestSchema = z.object({
  runtimeId: agentRuntimeIdSchema,
  methodId: z.string().min(1).max(128).optional(),
  deviceAuth: z.boolean().optional(),
});

const logoutRequestSchema = z.object({ runtimeId: agentRuntimeIdSchema });

function parseRequest<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const detail = parsed.error.issues
    .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
    .join("; ");
  throw new Error(`Invalid ${label}: ${detail}`);
}

/** agent_servers 与内置配置共享 AgentRuntimeId 命名空间；两边都拒绝占用对方的 ID。 */
export async function assertAgentServerIdAvailable(id: string): Promise<void> {
  if ((await readAgentConfigs()).configs.some((config) => config.id === id))
    throw new Error("Agent ID is used by a built-in runtime configuration");
}

export async function saveBuiltinRuntimeConfig(
  input: SaveBuiltinRuntimeConfigInput,
): Promise<AgentConfig> {
  const { apiKey, create, provider, env, ...config } = parseRequest(
    saveRequestSchema,
    input,
    "built-in runtime configuration",
  );
  if ((await readAgentServersRegistry()).servers.some((server) => server.id === config.id))
    throw new Error("Agent ID is used by a custom ACP server");
  const previous = await findAgentConfig(config.id);
  // 新建入口不得静默覆盖同 ID 的既有配置（含未落盘的默认配置），否则会接管其私有 home 与会话。
  if (create && previous)
    throw new Error("Agent ID is already used by a built-in runtime configuration");
  // 设置页不编辑 env：省略时保留已保存值，避免保存其他字段时丢失用户在文件里配置的变量。
  const keptEnv = env ?? previous?.env;
  // provider 字段内容由 parseAgentConfig 逐项校验；这里只收窄 RPC 形状，并为 Claude 模型持久化稳定槽位。
  const settings = provider as AgentProviderSettings | undefined;
  const saved = await saveAgentConfig({
    ...config,
    ...(settings
      ? {
          provider:
            settings.models && Array.isArray(settings.models) && isBuiltinAcpRuntime(config.runtime)
              ? { ...settings, models: withStableModelSlots(config.runtime, settings.models) }
              : settings,
        }
      : {}),
    ...(keptEnv ? { env: keptEnv } : {}),
  });
  if (apiKey !== undefined)
    await saveBuiltinConfigApiKey(saved.id, apiKey?.trim() ? apiKey.trim() : null);
  const routingChanged = !previous || routingKey(previous) !== routingKey(saved);
  // 新 Key/新路由需要重新判定认证；改名、启停或编辑模型列表不影响已判定的认证状态。
  if (routingChanged || apiKey !== undefined) acpAuthStateStore.reset(saved.id);
  // Provider 或认证方式变化后旧的同步模型目录不再可信。
  if (previous && routingChanged)
    await saveAcpModels(saved.id, builtinConfigFingerprint(saved), [], []);
  return saved;
}

/** 认证方式 + Provider 路由（不含声明的模型列表：它们由 Runtime 原生列出，不进入同步目录）。 */
function routingKey(config: AgentConfig): string {
  const { models: _models, ...provider } = config.provider ?? {};
  return JSON.stringify([config.auth, provider]);
}

async function pathExists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/**
 * 删除落盘配置、Key 与私有 home。修复原因：私有 home 保存订阅凭据（Codex auth.json、Claude
 * .credentials.json；macOS Keychain 条目按 home 路径哈希命名），同 ID 重建会继承旧登录。
 * 订阅配置先尽力登出（清 Keychain），再删除 home；cli-login 不使用私有 home，不触碰全局登录。
 */
export async function deleteBuiltinRuntimeConfig(id: string): Promise<void> {
  const configId = parseRequest(agentRuntimeIdSchema, id, "built-in runtime configuration id");
  const config = await findAgentConfig(configId);
  const home = builtinConfigHome(configId);
  // 修复原因：登出需要解析启动（首次会安装数百 MB 的 Runtime）；私有 home 不存在说明该配置从未启动或登录，
  // 不可能留下凭据或按 home 路径命名的 Keychain 条目，直接跳过，避免删除一个未使用的订阅配置也触发安装。
  if (config?.auth === "subscription" && (await pathExists(home)))
    await logoutBuiltinRuntime(config, {
      resolveLaunch: (current) => resolveBuiltinLaunch(current),
      cwd: home,
    }).catch(() => {});
  await deleteAgentConfig(configId);
  await saveBuiltinConfigApiKey(configId, null);
  await rm(home, { recursive: true, force: true });
  acpAuthStateStore.reset(configId);
}

async function requireConfig(id: string): Promise<AgentConfig> {
  const config = await findAgentConfig(id);
  if (!config) throw new Error(`Built-in ACP configuration is not available: ${id}`);
  return config;
}

/**
 * 登录/登出进程的 cwd。修复原因：设置页传来的 workspacePath 可能是远程 workspace 的路径或为空，
 * 在 Local Host 上作为 cwd 会 spawn ENOENT；登录与工作区无关，统一使用该配置自己的目录。
 */
async function authProcessCwd(id: string): Promise<string> {
  const home = builtinConfigHome(id);
  await mkdir(home, { recursive: true, mode: 0o700 });
  return home;
}

const LOGIN_ANNOUNCE_TIMEOUT_MS = 20_000;

export async function loginBuiltinRuntime(params: {
  runtimeId: string;
  methodId?: string;
  deviceAuth?: boolean;
}): Promise<BuiltinRuntimeAuthResult> {
  const request = parseRequest(loginRequestSchema, params, "sign-in request");
  const config = await requireConfig(request.runtimeId);
  const handle = startBuiltinLogin(
    config,
    { methodId: request.methodId, deviceAuth: request.deviceAuth },
    {
      resolveLaunch: (current) => resolveBuiltinLaunch(current),
      cwd: await authProcessCwd(config.id),
    },
  );
  void handle.completion.catch(() => {});
  // 只等待登录 URL/设备码出现（或登录结束）以便返回提示；完成状态由 authState 继续呈现。
  let timer: ReturnType<typeof setTimeout> | undefined;
  const announced = await Promise.race([
    handle.started,
    new Promise<{ message?: string }>((resolve) => {
      timer = setTimeout(() => resolve({}), LOGIN_ANNOUNCE_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
  const snapshot = acpAuthStateStore.get(config.id);
  return {
    state: snapshot.state,
    ...(announced.message
      ? { message: announced.message }
      : snapshot.message
        ? { message: snapshot.message }
        : {}),
  };
}

export async function logoutBuiltinRuntimeConfig(params: {
  runtimeId: string;
}): Promise<BuiltinRuntimeAuthResult> {
  const request = parseRequest(logoutRequestSchema, params, "sign-out request");
  const config = await requireConfig(request.runtimeId);
  const snapshot = await logoutBuiltinRuntime(config, {
    resolveLaunch: (current) => resolveBuiltinLaunch(current),
    cwd: await authProcessCwd(config.id),
  });
  return { state: snapshot.state, ...(snapshot.message ? { message: snapshot.message } : {}) };
}

/** 认证状态变化只作为重新读取状态的触发信号：不携带消息（可能含登录 URL/设备码）或任何秘密。 */
export function onBuiltinRuntimeAuthChange(
  listener: (change: BuiltinRuntimeAuthChange) => void,
): () => void {
  return acpAuthStateStore.onDidChange((runtimeId, snapshot) =>
    listener({ runtimeId, state: snapshot.state }),
  );
}
