import { ACP_DEFAULT_MODEL_ID, type AgentRuntimeId } from "@zcode/shared";
import type { AgentRuntimeConfigPreview } from "#src/zcode-agent/zcodeAgent.js";
import { AcpConnection } from "#src/agent-runtime/acpConnection.js";
import {
  resolveAcpRuntimeSpec,
  isolateAcpNativeAutoMemory,
  type AcpRuntimeSpec,
} from "#src/agent-runtime/acpRuntimeCatalog.js";
import { acpStartupGate } from "#src/agent-runtime/acpStartupGate.js";
import type { AcpLaunch } from "#src/agent-runtime/builtin/builtinRuntimeLaunch.js";

/** 草稿会话使用临时 ACP 进程读取模型与思考选项，不留下空会话绑定。 */
export async function discoverAcpRuntimeConfig(input: {
  runtimeId: AgentRuntimeId;
  workspacePath: string;
  modelId?: string;
  includeAllModelThoughtLevels?: boolean;
  resolveLaunch: (spec: AcpRuntimeSpec) => Promise<AcpLaunch>;
  onInitialized?: (connection: AcpConnection) => void;
}): Promise<AgentRuntimeConfigPreview> {
  const spec = await resolveAcpRuntimeSpec(input.runtimeId);
  if (!spec) throw new Error(`Unsupported ACP Runtime ${input.runtimeId}`);
  const launch = await input.resolveLaunch(spec);
  const isolated = isolateAcpNativeAutoMemory(spec, launch.env ?? process.env, launch.args);
  const connection = await acpStartupGate.run(async () => {
    const opened = await AcpConnection.open(
      {
        executable: launch.executable,
        args: isolated.args,
        cwd: input.workspacePath,
        env: isolated.env,
      },
      {
        onUpdate: () => {},
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      },
    );
    input.onInitialized?.(opened);
    try {
      await opened.createSession(input.workspacePath);
      return opened;
    } catch (error) {
      await opened.close();
      throw error;
    }
  });
  try {
    if (input.modelId && input.modelId !== ACP_DEFAULT_MODEL_ID)
      await connection.setModel(input.modelId);
    const models = connection.modelOptions();
    const levels = connection.thinkingLevels();
    const selectedModel = models.find((model) => model.selected)?.id ?? "";
    const modelThoughtLevels = new Map<string, Array<{ value: string; name: string }>>();
    if (input.includeAllModelThoughtLevels) {
      for (const model of models) {
        await connection.setModel(model.id);
        modelThoughtLevels.set(
          model.id,
          connection.thinkingLevels().map(({ value, name }) => ({ value, name })),
        );
      }
      if (selectedModel) await connection.setModel(selectedModel);
    } else if (selectedModel) {
      modelThoughtLevels.set(
        selectedModel,
        levels.map(({ value, name }) => ({ value, name })),
      );
    }
    return {
      models: models.map(({ id, name, description }) => ({
        id,
        name,
        ...(description ? { description } : {}),
        thoughtLevels: modelThoughtLevels.get(id) ?? [],
      })),
      selectedModel,
      thoughtLevels: levels.map(({ value, name }) => ({ value, name })),
      selectedThought: levels.find((level) => level.selected)?.value ?? "",
      modes:
        connection.modeState()?.availableModes.map(({ id, name, description }) => ({
          id,
          name,
          ...(description ? { description } : {}),
        })) ?? [],
      selectedMode: connection.modeState()?.currentModeId ?? "",
    };
  } finally {
    await connection.close();
  }
}
