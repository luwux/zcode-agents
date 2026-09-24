import { readAgentServersRegistry } from "#src/agent-runtime/agentServersRegistry.js";
import { acpAuthStateStore } from "#src/agent-runtime/acpAuthState.js";
import {
  deleteAgentConfig,
  findAgentConfig,
  readAgentConfigs,
  saveAgentConfig,
  type AgentConfig,
  type AgentConfigInput,
} from "#src/agent-runtime/builtin/agentConfigRegistry.js";
import { rm } from "node:fs/promises";
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

/** agent_servers 与内置配置共享 AgentRuntimeId 命名空间；两边都拒绝占用对方的 ID。 */
export async function assertAgentServerIdAvailable(id: string): Promise<void> {
  if ((await readAgentConfigs()).configs.some((config) => config.id === id))
    throw new Error("Agent ID is used by a built-in runtime configuration");
}

export async function saveBuiltinRuntimeConfig(
  input: AgentConfigInput & { apiKey?: string | null },
): Promise<AgentConfig> {
  const { apiKey, ...config } = input;
  if ((await readAgentServersRegistry()).servers.some((server) => server.id === config.id))
    throw new Error("Agent ID is used by a custom ACP server");
  const saved = await saveAgentConfig(config);
  if (apiKey !== undefined)
    await saveBuiltinConfigApiKey(saved.id, apiKey?.trim() ? apiKey.trim() : null);
  return saved;
}

/**
 * 删除落盘配置、Key 与私有 home。修复原因：私有 home 保存订阅凭据（Codex auth.json、Claude
 * .credentials.json；macOS Keychain 条目按 home 路径哈希命名），同 ID 重建会继承旧登录。
 * 订阅配置先尽力登出（清 Keychain），再删除 home；cli-login 不使用私有 home，不触碰全局登录。
 */
export async function deleteBuiltinRuntimeConfig(
  id: string,
  workspacePath?: string,
): Promise<void> {
  const config = await findAgentConfig(id);
  if (config?.auth === "subscription")
    await logoutBuiltinRuntime(config, {
      resolveLaunch: (current) => resolveBuiltinLaunch(current),
      cwd: workspacePath ?? builtinConfigHome(id),
    }).catch(() => {});
  await deleteAgentConfig(id);
  await saveBuiltinConfigApiKey(id, null);
  await rm(builtinConfigHome(id), { recursive: true, force: true });
  acpAuthStateStore.reset(id);
}

async function requireConfig(id: string): Promise<AgentConfig> {
  const config = await findAgentConfig(id);
  if (!config) throw new Error(`Built-in ACP configuration is not available: ${id}`);
  return config;
}

const LOGIN_ANNOUNCE_TIMEOUT_MS = 20_000;

export async function loginBuiltinRuntime(params: {
  runtimeId: string;
  workspacePath: string;
  methodId?: string;
  deviceAuth?: boolean;
}): Promise<{ state: string; message?: string }> {
  const config = await requireConfig(params.runtimeId);
  const handle = startBuiltinLogin(
    config,
    { methodId: params.methodId, deviceAuth: params.deviceAuth },
    { resolveLaunch: (current) => resolveBuiltinLaunch(current), cwd: params.workspacePath },
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
  workspacePath: string;
}): Promise<{ state: string; message?: string }> {
  const config = await requireConfig(params.runtimeId);
  const snapshot = await logoutBuiltinRuntime(config, {
    resolveLaunch: (current) => resolveBuiltinLaunch(current),
    cwd: params.workspacePath,
  });
  return { state: snapshot.state, ...(snapshot.message ? { message: snapshot.message } : {}) };
}
