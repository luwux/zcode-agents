import type { PromptResponse } from "@agentclientprotocol/sdk";
import type { ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import type { AcpBackgroundAttribution } from "#src/agent-runtime/acpBackgroundWorks.js";
import type { AcpLodyTaskMeta } from "#src/agent-runtime/acpExtensionSchemas.js";
import type { AcpRowLog } from "#src/agent-runtime/acpRowLog.js";
import {
  acpSubagentSessionId,
  boundedSummary,
  type AcpSubagentEntry,
  type AcpSubagentRegistry,
  type AcpSubagentStatus,
} from "#src/agent-runtime/acpSubagentRegistry.js";
import { boundedJson } from "#src/agent-runtime/acpToolCallProjection.js";

/** 子会话生命周期所需的投影能力（由 AcpConversationProjection 实现）。 */
export interface AcpSubagentHost {
  readonly taskId: string;
  readonly log: AcpRowLog;
  lifecycleTurn(at: number, fallback: AcpBackgroundAttribution | null): string | null;
  findToolRow(toolCallId: string): ToolCallRow | undefined;
  createChild(virtualId: string, title: string, model: string): this;
  beginTurn(
    commandId: string,
    text: string,
    attachments: undefined,
    at: number,
    origin: "synthetic",
  ): void;
  finishTurn(result: PromptResponse | { error: string }, at: number): void;
}

export function lodyTaskKey(taskId: string): string {
  return `lody-task:${taskId}`;
}

/** 原生子会话：宿主 Agent 工具行 + subagent 行 + 只读子投影（幂等；generation 视为新子会话）。 */
export function spawnNativeSubagent<P extends AcpSubagentHost>(
  host: P,
  registry: AcpSubagentRegistry<P>,
  spawn: { key: string; name?: string; task?: string },
  at: number,
): void {
  if (registry.get(spawn.key)) return;
  const name = spawn.name?.trim() || "Agent";
  const task = spawn.task?.trim() ?? "";
  const virtualId = acpSubagentSessionId(registry.rootTaskId, spawn.key);
  const turnId = host.lifecycleTurn(at, {
    source: "subagent",
    workId: virtualId,
    title: name,
    startedAt: at,
  });
  if (!turnId) return;
  const hostToolCallId = `acp-subagent:${spawn.key}`;
  const input = { description: name, prompt: task, subagent_type: name };
  const hostRow = host.log.push({
    kind: "toolCall",
    turnId,
    toolCallId: hostToolCallId,
    toolName: "Agent",
    status: "running",
    inputText: boundedJson(input),
    input,
    startedAt: at,
  });
  const row = host.log.push({
    kind: "subagent",
    turnId,
    parentToolCallId: hostToolCallId,
    subagentType: name,
    status: "running",
    summaryText: boundedSummary(task || name),
    childSessionId: virtualId,
    startedAt: at,
  });
  const child = host.createChild(virtualId, name, "");
  child.beginTurn(hostToolCallId, task || name, undefined, at, "synthetic");
  registry.add({
    key: spawn.key,
    kind: "native",
    virtualId,
    projection: child,
    parent: host,
    parentTaskId: host.taskId,
    hostToolCallId,
    hostRowId: hostRow.rowId,
    subagentRowId: row.rowId,
    anchorRowId: hostRow.rowId,
    name,
    type: name,
    task,
    status: "running",
    startedAt: at,
  });
}

/** Pi：`_meta.lody.task` → 与 Pi `subagent` 工具行配对的 subagent 行（无原生子转录）。 */
export function applyLodyTask<P extends AcpSubagentHost>(
  host: P,
  registry: AcpSubagentRegistry<P>,
  task: AcpLodyTaskMeta,
  at: number,
): void {
  const key = lodyTaskKey(task.taskId);
  let entry = registry.get(key);
  if (!entry) {
    const hostRow = task.parentToolCallId ? host.findToolRow(task.parentToolCallId) : undefined;
    const description = task.description?.trim() || "Subagent";
    const virtualId = acpSubagentSessionId(registry.rootTaskId, key);
    const turnId =
      hostRow?.turnId ??
      host.lifecycleTurn(at, {
        source: "subagent",
        workId: virtualId,
        title: description,
        startedAt: at,
      });
    if (!turnId) return;
    const type = task.modelId?.trim() || "Pi";
    const row = host.log.push({
      kind: "subagent",
      turnId,
      ...(task.parentToolCallId ? { parentToolCallId: task.parentToolCallId } : {}),
      subagentType: type,
      status: "running",
      summaryText: boundedSummary(description),
      childSessionId: virtualId,
      startedAt: at,
    });
    const child = host.createChild(virtualId, description, type);
    child.beginTurn(key, description, undefined, at, "synthetic");
    registry.add({
      key,
      kind: "lodyTask",
      lodyTaskId: task.taskId,
      virtualId,
      projection: child,
      parent: host,
      parentTaskId: host.taskId,
      hostToolCallId: task.parentToolCallId ?? key,
      subagentRowId: row.rowId,
      anchorRowId: hostRow?.rowId ?? row.rowId,
      name: description,
      type,
      task: description,
      status: "running",
      startedAt: at,
    });
    entry = registry.get(key);
  }
  if (!entry || task.status === "in_progress") return;
  settleSubagent(
    registry,
    entry,
    task.status === "completed" ? "success" : "failed",
    at,
    task.error,
    task.error,
  );
}

/** Claude 异步启动的子智能体：宿主行与 subagent 行标记为后台运行（不改变其状态）。 */
export function markSubagentBackgrounded<P extends AcpSubagentHost>(entry: AcpSubagentEntry<P>) {
  const parent = entry.parent.log;
  for (const rowId of [entry.subagentRowId, entry.hostRowId]) {
    const row = parent.at(rowId);
    if ((row?.kind === "subagent" || row?.kind === "toolCall") && row.backgrounded !== true)
      parent.replace({ ...row, backgrounded: true, workId: entry.virtualId });
  }
}

/** 由持有宿主行的父投影收口子会话；终态单调，摘要取子会话最后一段回复。 */
export function settleSubagent<P extends AcpSubagentHost>(
  registry: AcpSubagentRegistry<P>,
  entry: AcpSubagentEntry<P>,
  status: Exclude<AcpSubagentStatus, "running">,
  at: number,
  reason?: string,
  summaryOverride?: string,
): void {
  if (!registry.settle(entry, status, at)) return;
  const parent = entry.parent.log;
  const summary = boundedSummary(
    summaryOverride?.trim() || entry.projection.log.lastAssistantText() || entry.task || entry.name,
  );
  entry.summary = summary;
  const row = parent.at(entry.subagentRowId);
  if (row?.kind === "subagent")
    parent.replace({ ...row, status, summaryText: summary, endedAt: at });
  const hostRow = parent.at(entry.hostRowId);
  if (hostRow?.kind === "toolCall") {
    parent.replace({
      ...hostRow,
      status: status === "success" ? "success" : status === "cancelled" ? "cancelled" : "error",
      ...(status === "success" ? { output: { text: summary } } : {}),
      ...(status === "failed"
        ? { error: { code: "acpSubagentFailed", message: reason ?? "Subagent failed" } }
        : {}),
      endedAt: at,
    });
  }
  entry.projection.finishTurn(
    status === "success"
      ? { stopReason: "end_turn" }
      : status === "cancelled"
        ? { stopReason: "cancelled" }
        : { error: reason ?? "Subagent failed" },
    at,
  );
  registry.onSettle?.(entry);
}
