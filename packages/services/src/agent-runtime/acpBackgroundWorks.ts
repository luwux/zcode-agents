import type { BackgroundWorkSummary } from "@zcode/shared/zcode-protocol-v4";
import type { AcpExtensionUpdate } from "#src/agent-runtime/acpExtensionSchemas.js";

/** 回合外内容可归因于 30 秒内完成的后台工作（负责人裁决的展示轮策略）。 */
export const BACKGROUND_ATTRIBUTION_WINDOW_MS = 30_000;

export interface AcpBackgroundAttribution {
  source: "bash" | "subagent";
  workId: string;
  title: string;
  startedAt: number;
  endedAt?: number;
}

type AsyncTaskUpdate = Extract<
  AcpExtensionUpdate,
  { sessionUpdate: "async_task_spawned" | "async_task_progress" | "async_task_state_update" }
>;

interface AsyncTaskEntry {
  workId: string;
  title: string;
  named: boolean;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: number;
  endedAt?: number;
  cancellable: boolean;
  toolCallId?: string;
  /** 锚点行一旦解析即缓存，避免每次 snapshot 都从尾部扫描行日志。 */
  anchorRowId?: number;
}

/**
 * AIR 异步任务（后台 Bash、Claude workflow 等）的唯一所有者。`kind` 是闭集，一律投影为 "bash"；
 * workflow 任务以工作流名为标题。completed 从 backgroundWorks 移除（等同 ZCode 已投递结果），但保留用于归因。
 */
export class AcpBackgroundWorkTracker {
  private readonly tasks = new Map<string, AsyncTaskEntry>();

  /** 返回受影响任务的 toolCallId（用于给工具行打 backgrounded/workId）。 */
  apply(update: AsyncTaskUpdate, at: number): { workId: string; toolCallId?: string } | null {
    const existing = this.tasks.get(update.asyncTaskId);
    if (update.sessionUpdate === "async_task_spawned") {
      if (existing) return null;
      const title = update.name?.trim() || update.description?.trim() || "Background task";
      const entry: AsyncTaskEntry = {
        workId: update.asyncTaskId,
        title,
        named: Boolean(update.name?.trim()),
        status: "running",
        startedAt: at,
        cancellable: update.canStop === true,
        ...(update.toolCallId ? { toolCallId: update.toolCallId } : {}),
      };
      this.tasks.set(entry.workId, entry);
      return {
        workId: entry.workId,
        ...(entry.toolCallId ? { toolCallId: entry.toolCallId } : {}),
      };
    }
    if (!existing) return null;
    if (update.toolCallId && !existing.toolCallId) existing.toolCallId = update.toolCallId;
    if (update.sessionUpdate === "async_task_progress") {
      if (!existing.named && update.description?.trim()) existing.title = update.description.trim();
    } else if (existing.status === "running") {
      // 终态单调：completed/failed/stopped 之后的 running/paused 不再恢复。
      if (update.state === "completed") existing.status = "completed";
      else if (update.state === "failed") existing.status = "failed";
      else if (update.state === "stopped") existing.status = "cancelled";
      if (existing.status !== "running") existing.endedAt = at;
    }
    return {
      workId: existing.workId,
      ...(existing.toolCallId ? { toolCallId: existing.toolCallId } : {}),
    };
  }

  summaries(anchorRowId: (toolCallId: string) => number | null): BackgroundWorkSummary[] {
    return [...this.tasks.values()].flatMap((task) => {
      if (task.status === "completed") return [];
      const status: BackgroundWorkSummary["status"] = task.status;
      return [
        {
          workId: task.workId,
          kind: "bash" as const,
          title: task.title,
          status,
          startedAt: task.startedAt,
          ...(task.endedAt !== undefined ? { endedAt: task.endedAt } : {}),
          cancellable: task.cancellable && task.status === "running",
          anchorRowId: this.anchorOf(task, anchorRowId),
        },
      ];
    });
  }

  private anchorOf(
    task: AsyncTaskEntry,
    resolve: (toolCallId: string) => number | null,
  ): number | null {
    if (task.anchorRowId !== undefined) return task.anchorRowId;
    const rowId = task.toolCallId ? resolve(task.toolCallId) : null;
    if (rowId !== null) task.anchorRowId = rowId;
    return rowId;
  }

  cancelTarget(workId: string): { cancellable: boolean; running: boolean } | null {
    const task = this.tasks.get(workId);
    return task ? { cancellable: task.cancellable, running: task.status === "running" } : null;
  }

  attributions(): AcpBackgroundAttribution[] {
    return [...this.tasks.values()].map((task) => ({
      source: "bash" as const,
      workId: task.workId,
      title: task.title,
      startedAt: task.startedAt,
      ...(task.status !== "running" && task.endedAt !== undefined ? { endedAt: task.endedAt } : {}),
    }));
  }

  /** 回放结束或进程退出：旧进程的后台任务不可能仍在运行。 */
  failRunning(at: number): void {
    for (const task of this.tasks.values()) {
      if (task.status !== "running") continue;
      task.status = "failed";
      task.endedAt = at;
    }
  }
}

/** 选择归因对象：优先 30 秒内最近完成者，否则最近启动的运行中工作。 */
export function pickBackgroundAttribution(
  candidates: readonly AcpBackgroundAttribution[],
  at: number,
): AcpBackgroundAttribution | null {
  let recent: AcpBackgroundAttribution | null = null;
  let running: AcpBackgroundAttribution | null = null;
  for (const candidate of candidates) {
    if (candidate.endedAt === undefined) {
      if (!running || candidate.startedAt >= running.startedAt) running = candidate;
    } else if (
      at - candidate.endedAt <= BACKGROUND_ATTRIBUTION_WINDOW_MS &&
      at >= candidate.endedAt &&
      (!recent || candidate.endedAt >= (recent.endedAt ?? 0))
    ) {
      recent = candidate;
    }
  }
  return recent ?? running;
}
