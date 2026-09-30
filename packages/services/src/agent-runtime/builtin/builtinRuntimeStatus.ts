import { acpAuthStateStore, type AcpAuthSnapshot } from "#src/agent-runtime/acpAuthState.js";
import {
  readAgentConfigs,
  type AgentConfig,
} from "#src/agent-runtime/builtin/agentConfigRegistry.js";
import { BUILTIN_RUNTIME_DEFINITIONS } from "#src/agent-runtime/builtin/builtinRuntimeCatalog.js";
import { isBuiltinRuntimeInstalled } from "#src/agent-runtime/builtin/builtinRuntimeInstaller.js";
import {
  builtinConfigFingerprint,
  builtinRuntimesRoot,
  loadBuiltinConfigApiKey,
} from "#src/agent-runtime/builtin/builtinRuntimeLaunch.js";
import type {
  AgentModelSettings,
  AgentProviderSettings,
} from "#src/agent-runtime/builtin/builtinProviderPresets.js";
import { configuredModels } from "#src/agent-runtime/builtin/builtinModels.js";
import {
  configuredModelOptions,
  type BuiltinModelOption,
} from "#src/agent-runtime/builtin/builtinModelOptions.js";

export interface BuiltinRuntimeStatus {
  id: string;
  name: string;
  /** 平台支持即视为可用：首次同步模型或创建会话时自动安装。 */
  installed: boolean;
  command: string;
  configPath: string;
  installHint?: string;
  reason?: string;
  fingerprint: string;
  /** Host 内部：BYOK 声明模型推出的选择器条目；listAgentRuntimes 据此生成 models，不直接回传。 */
  configuredOptions: BuiltinModelOption[];
  builtin: {
    runtime: AgentConfig["runtime"];
    version: string;
    managedInstalled: boolean;
    authMode: AgentConfig["auth"];
    authState: AcpAuthSnapshot["state"];
    authMethods: AcpAuthSnapshot["methods"];
    hasApiKey: boolean;
    provider?: AgentProviderSettings;
    /** BYOK 声明的模型（旧版单模型 `model` 视为一项）；为空时模型来自“同步 Agent 模型”。 */
    models: AgentModelSettings[];
    /** false 时该配置不出现在输入框模型选择器中。 */
    enabled: boolean;
    isDefault: boolean;
  };
}

export async function listBuiltinRuntimeStatuses(): Promise<{
  statuses: BuiltinRuntimeStatus[];
  issues: Array<{ id: string; message: string; configPath: string }>;
}> {
  const snapshot = await readAgentConfigs();
  const root = builtinRuntimesRoot();
  const statuses = await Promise.all(
    snapshot.configs.map(async (config): Promise<BuiltinRuntimeStatus> => {
      const definition = BUILTIN_RUNTIME_DEFINITIONS[config.runtime];
      const unsupported = definition.unsupportedReason(process.platform);
      const managedInstalled = await isBuiltinRuntimeInstalled(root, definition);
      // 只报告是否已保存 Key，不读出或回传 Key 本身。
      const hasApiKey =
        config.auth === "byok"
          ? Boolean(await loadBuiltinConfigApiKey(config.id).catch(() => null))
          : false;
      const auth = acpAuthStateStore.get(config.id);
      const reason =
        unsupported ??
        (config.auth === "byok" && !hasApiKey
          ? "API key is not configured"
          : auth.state === "auth-required"
            ? (auth.message ?? "Sign-in required")
            : undefined);
      return {
        id: config.id,
        name: config.name,
        installed: unsupported === null,
        command: `built-in ${definition.name} ${definition.version}`,
        configPath: snapshot.path,
        ...(managedInstalled
          ? {}
          : {
              installHint:
                config.runtime === "pi"
                  ? "Installed on first use (requires npm and git)"
                  : "Installed on first use (requires npm)",
            }),
        ...(reason ? { reason } : {}),
        fingerprint: builtinConfigFingerprint(config),
        configuredOptions: configuredModelOptions(config),
        builtin: {
          runtime: config.runtime,
          version: definition.version,
          managedInstalled,
          authMode: config.auth,
          authState:
            config.auth === "byok" ? (hasApiKey ? "authenticated" : "auth-required") : auth.state,
          authMethods: auth.methods,
          hasApiKey,
          ...(config.provider ? { provider: config.provider } : {}),
          models: config.auth === "byok" ? [...configuredModels(config.provider)] : [],
          enabled: config.enabled !== false,
          isDefault: config.builtinDefault === true,
        },
      };
    }),
  );
  return {
    statuses,
    issues: snapshot.issues.map((issue) => ({ ...issue, configPath: snapshot.path })),
  };
}
