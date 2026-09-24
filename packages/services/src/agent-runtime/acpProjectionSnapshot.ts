import {
  conversationSnapshotSchema,
  type BackgroundWorkSummary,
  type ConversationRow,
  type ConversationSnapshot,
  type GoalState,
  type PendingInteraction,
  type PlanState,
  type SubagentProjectionState,
} from "@zcode/shared/zcode-protocol-v4";
import type { AgentRuntimeId } from "@zcode/shared";
import type { SessionModeState } from "@agentclientprotocol/sdk";

const HISTORY_WINDOW_ROWS = 60;
const UNSUPPORTED = { allowed: false as const, reasonCode: "acpCapabilityUnsupported" };
const READ_ONLY = { allowed: false as const, reasonCode: "acpSubagentReadOnly" };

/** 将 ACP 持有的只读状态映射到现有 V4 会话视图。 */
export function buildAcpProjectionSnapshot(input: {
  taskId: string;
  logEpoch: string;
  seq: number;
  revision: number;
  phase: ConversationSnapshot["control"]["phase"];
  title: string;
  runtimeId?: AgentRuntimeId;
  model: string;
  thought: string;
  thoughtLevels: string[];
  modelOptions: Array<{ id: string; name: string }>;
  modes?: SessionModeState | null;
  permissions: PendingInteraction[];
  plan: PlanState | null;
  goal?: GoalState | null;
  rows: ConversationRow[];
  /** 子智能体虚拟会话：只读，不接纳输入与配置命令。 */
  readOnly?: boolean;
  /** Agent 支持运行中 steering（_session/steering 或 _lody/session/steer）。 */
  steering?: boolean;
  backgroundWorks?: BackgroundWorkSummary[];
  subagents?: SubagentProjectionState;
  unavailableReason?: string | null;
  lastError?: {
    code: string;
    message: string;
    recoverable: boolean;
    at: number;
    source: "runtime";
  } | null;
}): ConversationSnapshot {
  const { phase } = input;
  const readOnly = input.readOnly === true;
  return conversationSnapshotSchema.parse({
    protocolVersion: 1,
    sessionId: input.taskId,
    logEpoch: input.logEpoch,
    seq: input.seq,
    revision: input.revision,
    control: {
      phase,
      sessionEnded: phase !== "draft" && phase !== "running",
      canStop: phase === "running" && !readOnly,
      stopState: phase === "running" && !readOnly ? "stoppable" : "idle",
      stopTargetKind: phase === "running" ? "assistant" : "unknown",
      activeWorks: [],
      lastError: input.unavailableReason
        ? {
            code: "acpRuntimeUnavailable",
            message: input.unavailableReason,
            recoverable: false,
            at: Date.now(),
            source: "runtime",
          }
        : (input.lastError ?? null),
      apiRetry: null,
    },
    availability: {
      fork: UNSUPPORTED,
      compact: UNSUPPORTED,
      // 运行中也允许切换模型/思考等级：Host 立即转发，Agent 拒绝时在本 turn 结束后应用。
      switchModelConfig: readOnly
        ? READ_ONLY
        : input.unavailableReason
          ? { allowed: false, reasonCode: "acpRuntimeUnavailable" }
          : { allowed: true },
      setFollowupMode: UNSUPPORTED,
      queueEdit: UNSUPPORTED,
      sendQueuedNow: UNSUPPORTED,
      pauseGoal: UNSUPPORTED,
      resumeGoal: UNSUPPORTED,
    },
    inputRouting: readOnly
      ? { mode: "reject", reasonCode: "acpSubagentReadOnly" }
      : input.unavailableReason
        ? { mode: "reject", reasonCode: "acpRuntimeUnavailable" }
        : phase === "running"
          ? input.steering
            ? { mode: "guide" }
            : { mode: "reject", reasonCode: "acpTurnRunning" }
          : { mode: "startNow" },
    meta: {
      title: input.title,
      titleSource: "default",
      ...(input.runtimeId ? { runtimeId: input.runtimeId } : {}),
    },
    config: {
      provider: input.runtimeId ?? "acp",
      model: input.model,
      thought: input.thought,
      ...(input.runtimeId && input.model
        ? {
            modelSelection: {
              providerId: input.runtimeId,
              modelId: input.model,
              ...(input.thought ? { options: { reasoningLevel: input.thought } } : {}),
            },
          }
        : {}),
      thoughtLevels: input.thoughtLevels,
      acpModelOptions: input.modelOptions,
      ...(input.modes
        ? {
            acpModeOptions: input.modes.availableModes.map(({ id, name, description }) => ({
              id,
              name,
              ...(description ? { description } : {}),
            })),
            acpModeId: input.modes.currentModeId,
          }
        : {}),
      followupMode: "queue",
      mode: "build",
    },
    modelTransition: null,
    usage: {
      contextWindow: null,
      cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    queue: { items: [], autoDrain: true },
    pendingInteractions: input.permissions,
    pendingCommands: [],
    backgroundWorks: input.backgroundWorks ?? [],
    subagents: input.subagents ?? { revision: 0, childSessionIds: [], running: [], endedTotal: 0 },
    goal: input.goal ?? null,
    plan: input.plan,
    workspaceHookAdmission: null,
    rows: {
      window: input.rows.slice(-HISTORY_WINDOW_ROWS),
      totalCount: input.rows.length,
      firstRowId: input.rows[0]?.rowId ?? null,
    },
  });
}
