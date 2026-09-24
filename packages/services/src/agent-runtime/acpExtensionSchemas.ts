import type { SessionNotification } from "@agentclientprotocol/sdk";
import { z } from "zod";
import { createServiceLogger } from "#src/logger/serviceLogger.js";

/**
 * ACP 扩展更新的运行时 schema。
 *
 * 这些形状只存在于 Agent ↔ Host 的 ACP wire（claude-agent-acp 0.81 / codex-acp 1.13 / acp-extension-pi），
 * SDK 1.4 没有类型也不接受它们；UI 只看到既有 V4 行与 snapshot，因此 schema 留在 Host 的 ACP 适配层，
 * 不进入 packages/shared 的公共协议。
 */
export const acpExtensionLogger = createServiceLogger("acpExtension");

const nonEmpty = z.string().trim().min(1);

export const subagentSpawnedUpdateSchema = z.object({
  sessionUpdate: z.literal("subagent_spawned"),
  subagentSessionId: nonEmpty,
  name: z.string().optional(),
  task: z.string().optional(),
});

export const subagentStateUpdateSchema = z.object({
  sessionUpdate: z.literal("subagent_state_update"),
  subagentSessionId: nonEmpty,
  state: z.enum(["completed", "failed", "disconnected", "cancelled"]),
});

export const asyncTaskSpawnedUpdateSchema = z.object({
  sessionUpdate: z.literal("async_task_spawned"),
  asyncTaskId: nonEmpty,
  name: z.string().optional(),
  taskType: z.string().optional(),
  description: z.string().optional(),
  canStop: z.boolean().optional(),
  toolCallId: z.string().optional(),
});

export const asyncTaskProgressUpdateSchema = z.object({
  sessionUpdate: z.literal("async_task_progress"),
  asyncTaskId: nonEmpty,
  description: z.string().optional(),
  summary: z.string().optional(),
  toolCallId: z.string().optional(),
});

export const asyncTaskStateUpdateSchema = z.object({
  sessionUpdate: z.literal("async_task_state_update"),
  asyncTaskId: nonEmpty,
  state: z.enum(["running", "paused", "completed", "failed", "stopped"]),
  summary: z.string().optional(),
  toolCallId: z.string().optional(),
});

export const acpExtensionUpdateSchema = z.discriminatedUnion("sessionUpdate", [
  subagentSpawnedUpdateSchema,
  subagentStateUpdateSchema,
  asyncTaskSpawnedUpdateSchema,
  asyncTaskProgressUpdateSchema,
  asyncTaskStateUpdateSchema,
]);
export type AcpExtensionUpdate = z.infer<typeof acpExtensionUpdateSchema>;

export const ACP_EXTENSION_UPDATE_KINDS: ReadonlySet<string> = new Set([
  "subagent_spawned",
  "subagent_state_update",
  "async_task_spawned",
  "async_task_progress",
  "async_task_state_update",
]);

/** 标准 ACP update 与经校验的扩展 update 的并集；观察者、转录与投影共用。 */
export type AcpSessionUpdate = SessionNotification["update"] | AcpExtensionUpdate;
export interface AcpUpdateNotification {
  sessionId: string;
  update: AcpSessionUpdate;
}

export function isAcpExtensionUpdate(update: AcpSessionUpdate): update is AcpExtensionUpdate {
  return ACP_EXTENSION_UPDATE_KINDS.has(update.sessionUpdate);
}

/** 非法扩展事件只丢弃并记 debug；原始载荷不进入 info 日志。 */
export function parseAcpExtensionUpdate(value: unknown): AcpExtensionUpdate | null {
  const parsed = acpExtensionUpdateSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  acpExtensionLogger.debug(undefined, "drop invalid ACP extension update", {
    kind: readKind(value),
    issues: parsed.error.issues.slice(0, 3).map((issue) => issue.path.join(".")),
  });
  return null;
}

function readKind(value: unknown): string | undefined {
  return typeof value === "object" && value !== null && "sessionUpdate" in value
    ? String((value as { sessionUpdate: unknown }).sessionUpdate)
    : undefined;
}

// ── _meta 读取器：只接受经校验的形状，其余视为缺省 ──

const lodyTaskMetaSchema = z.object({
  taskId: nonEmpty,
  kind: z.literal("subagent"),
  parentToolCallId: z.string().optional(),
  description: z.string().optional(),
  modelId: z.string().optional(),
  status: z.enum(["in_progress", "completed", "failed"]),
  error: z.string().optional(),
});
export type AcpLodyTaskMeta = z.infer<typeof lodyTaskMetaSchema>;

/** Pi（acp-extension-pi）的子任务生命周期载体：`tool_call._meta.lody.task`。 */
export function readLodyTaskMeta(meta: unknown): AcpLodyTaskMeta | null {
  const task = record(record(record(meta)?.lody)?.task);
  if (!task) return null;
  const parsed = lodyTaskMetaSchema.safeParse(task);
  if (parsed.success) return parsed.data;
  acpExtensionLogger.debug(undefined, "drop invalid _meta.lody.task", {
    issues: parsed.error.issues.slice(0, 3).map((issue) => issue.path.join(".")),
  });
  return null;
}

const goalMetaSchema = z.object({
  objective: nonEmpty,
  status: z.string().optional(),
  iterations: z.number().int().nonnegative().optional(),
  timeUsedSeconds: z.number().nonnegative().optional(),
});
export type AcpGoalMeta = z.infer<typeof goalMetaSchema>;

/** `session_info_update._meta.goal`：缺省 = 不变；null = 清除；非法 = 丢弃（不变）。 */
export function readAcpGoalMeta(
  meta: unknown,
): { present: false } | { present: true; goal: AcpGoalMeta | null } {
  const container = record(meta);
  if (!container || !("goal" in container)) return { present: false };
  if (container.goal === null) return { present: true, goal: null };
  const parsed = goalMetaSchema.safeParse(container.goal);
  if (parsed.success) return { present: true, goal: parsed.data };
  acpExtensionLogger.debug(undefined, "drop invalid _meta.goal", {
    issues: parsed.error.issues.slice(0, 3).map((issue) => issue.path.join(".")),
  });
  return { present: false };
}

/** claude-agent-acp 的 `_meta.claudeCode.toolName`（程序化工具名）。 */
export function readClaudeCodeToolName(meta: unknown): string | undefined {
  const value = record(record(meta)?.claudeCode)?.toolName;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * claude-agent-acp 原生子会话模式下的 Agent/Task 控制更新（`_meta.claudeCode.subagent` 或工具名）。
 * 异步启动的回执携带 `toolResponse{isAsync, agentId}`，agentId 即子会话 id。
 */
export function readClaudeCodeSubagentControl(meta: unknown): {
  control: boolean;
  asyncAgentId?: string;
} {
  const claude = record(record(meta)?.claudeCode);
  const toolName = claude?.toolName;
  const control = claude?.subagent === true || toolName === "Agent" || toolName === "Task";
  const response = record(claude?.toolResponse);
  const agentId = response?.isAsync === true ? response.agentId : undefined;
  return {
    control,
    ...(control && typeof agentId === "string" && agentId ? { asyncAgentId: agentId } : {}),
  };
}

/** AIR：`_meta.jetbrains.air.asyncTasks.backgrounded === true` 表示该 Bash 已转入后台。 */
export function readAirBackgrounded(meta: unknown): boolean {
  return record(record(record(record(meta)?.jetbrains)?.air)?.asyncTasks)?.backgrounded === true;
}

/** Pi 公布 `_meta.lody.subagents.cancel` 时才可经 `_lody/subagents/cancel` 停止子任务。 */
export function readLodySubagentCancel(agentCapabilities: unknown): boolean {
  return record(record(record(record(agentCapabilities)?._meta)?.lody)?.subagents)?.cancel === true;
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
