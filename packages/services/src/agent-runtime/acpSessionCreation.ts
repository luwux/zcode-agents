import { ACP_DEFAULT_MODEL_ID, type AgentRuntimeId, type ZCodeTaskMeta } from "@zcode/shared";
import { getZCodeDataRootDir } from "#src/paths.js";
import { AcpConnection, type AcpSessionObserver } from "#src/agent-runtime/acpConnection.js";
import { AcpConversationProjection } from "#src/agent-runtime/acpConversationProjection.js";
import {
  createAcpPendingInteractions,
  createManagedAcpSession,
  type AcpPendingInteractions,
  type ManagedAcpSession,
} from "#src/agent-runtime/acpManagedSession.js";
import {
  isolateAcpNativeAutoMemory,
  type AcpRuntimeSpec,
} from "#src/agent-runtime/acpRuntimeCatalog.js";
import { AcpTranscriptStore } from "#src/agent-runtime/acpTranscriptStore.js";
import { acpStartupGate } from "#src/agent-runtime/acpStartupGate.js";
import type { AcpLaunch } from "#src/agent-runtime/builtin/builtinRuntimeLaunch.js";

/** 建立 ACP 原生会话、持久绑定和工作台投影；失败时回收进程。 */
export async function createAcpManagedSession(input: {
  taskId: string;
  runtimeId: AgentRuntimeId;
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceKey: string;
  modelId?: string;
  thoughtLevel?: string;
  modeId?: string;
  projectWorkspacePath?: string;
  parentTaskId?: string;
  spec: AcpRuntimeSpec;
  resolveLaunch: (spec: AcpRuntimeSpec) => Promise<AcpLaunch>;
  isMemoryEnabled: () => boolean | Promise<boolean>;
  /** 握手完成后回调（记录 authMethods）；在 session/new 之前触发，失败时仍可用于认证提示。 */
  onInitialized?: (connection: AcpConnection) => void;
  syncTaskMetaAtGroupedTop: (meta: ZCodeTaskMeta) => Promise<void>;
  makeObserver: (
    projection: AcpConversationProjection,
    transcript: AcpTranscriptStore,
    pending: AcpPendingInteractions,
    current: () => ManagedAcpSession | null,
  ) => AcpSessionObserver;
}): Promise<ManagedAcpSession> {
  const projection = new AcpConversationProjection(input.taskId, "", input.runtimeId);
  const transcript = new AcpTranscriptStore(
    input.workspaceKey,
    input.taskId,
    getZCodeDataRootDir(),
  );
  const pending = createAcpPendingInteractions();
  let managed: ManagedAcpSession | null = null;
  const observer = input.makeObserver(projection, transcript, pending, () => managed);
  const launch = await input.resolveLaunch(input.spec);
  const isolated = isolateAcpNativeAutoMemory(input.spec, launch.env ?? process.env, launch.args);
  // 闸门覆盖 spawn → initialize → session/new；模型/模式设置在已建立的会话上，不占名额。
  const { connection, nativeSessionId } = await acpStartupGate.run(async () => {
    const opened = await AcpConnection.open(
      {
        executable: launch.executable,
        args: isolated.args,
        cwd: input.workspacePath,
        env: isolated.env,
        memory: { workspaceIdentity: input.workspaceIdentity, isEnabled: input.isMemoryEnabled },
      },
      observer,
    );
    input.onInitialized?.(opened);
    try {
      return {
        connection: opened,
        nativeSessionId: await opened.createSession(input.workspacePath),
      };
    } catch (error) {
      await opened.close();
      throw error;
    }
  });
  try {
    if (input.modelId && input.modelId !== ACP_DEFAULT_MODEL_ID)
      await connection.setModel(input.modelId);
    if (input.thoughtLevel) await connection.setThinkingLevel(input.thoughtLevel);
    if (input.modeId) await connection.setMode(input.modeId);
    projection.setModelOptions(connection.modelOptions());
    projection.setThinkingLevels(connection.thinkingLevels());
    projection.setModes(connection.modeState());
    await transcript.initialize();
    const now = Date.now();
    const confirmedModeId = connection.modeState()?.currentModeId;
    const meta: ZCodeTaskMeta = {
      taskId: input.taskId,
      runtimeId: input.runtimeId,
      nativeSessionId,
      ...(confirmedModeId ? { acpModeId: confirmedModeId } : {}),
      ...(input.spec.fingerprint ? { agentServerFingerprint: input.spec.fingerprint } : {}),
      traceId: input.taskId,
      title: "New session",
      workspacePath: input.workspacePath,
      ...(input.projectWorkspacePath ? { projectWorkspacePath: input.projectWorkspacePath } : {}),
      model: connection.modelOptions().find((model) => model.selected)?.id,
      thoughtLevel: connection.thinkingLevels().find((level) => level.selected)?.value,
      ...(input.parentTaskId ? { forkedFromTaskId: input.parentTaskId } : {}),
      ...(input.workspaceIdentity ? { workspaceIdentity: input.workspaceIdentity } : {}),
      createdAt: now,
      updatedAt: now,
      mode: "build",
      status: "completed",
    };
    await input.syncTaskMetaAtGroupedTop(meta);
    managed = createManagedAcpSession({
      connection,
      meta,
      projection,
      transcript,
      acceptedCommandIds: new Set(),
      pending,
    });
    return managed;
  } catch (error) {
    await connection.close();
    throw error;
  }
}
