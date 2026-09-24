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
import {
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

/** 删除落盘配置与其 Key；默认 ID 随后回到内置默认值，不能继承旧 Key。 */
export async function deleteBuiltinRuntimeConfig(id: string): Promise<void> {
  await deleteAgentConfig(id);
  await saveBuiltinConfigApiKey(id, null);
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
