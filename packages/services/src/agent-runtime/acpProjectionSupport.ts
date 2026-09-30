import type { PromptResponse, ToolCallStatus } from "@agentclientprotocol/sdk";
import type { GoalState } from "@zcode/shared/zcode-protocol-v4";
import type { AcpGoalMeta } from "#src/agent-runtime/acpExtensionSchemas.js";

/** ACP refusal can carry a provider failure in metadata while the transport call itself succeeds. */
export function acpPromptFailure(result: PromptResponse | { error: string }): string | null {
  if ("error" in result) return sanitizeAcpFailureMessage(result.error);
  const meta = result._meta as Record<string, unknown> | undefined;
  const knownFailure = meta?.["codebuddy.ai/outcome"] === "FAILED_MODEL_REQUEST";
  if (!knownFailure && result.stopReason !== "refusal") return null;
  const raw = meta?.["codebuddy.ai/errorMessage"];
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        parsed &&
        typeof parsed === "object" &&
        "message" in parsed &&
        typeof parsed.message === "string"
      )
        return sanitizeAcpFailureMessage(parsed.message);
    } catch {
      return sanitizeAcpFailureMessage(raw);
    }
  }
  return knownFailure ? "ACP Agent 请求失败" : "ACP Agent 拒绝了本次请求";
}

function sanitizeAcpFailureMessage(message: string): string {
  return message
    .replace(/https?:\/\/[^\s)]+/gu, "[URL]")
    .replace(/[\r\n\t]+/gu, " ")
    .slice(0, 500);
}

export function mapAcpToolStatus(
  status: ToolCallStatus | null | undefined,
): "inputStreaming" | "running" | "success" | "error" | null {
  switch (status) {
    case "pending":
      return "inputStreaming";
    case "in_progress":
      return "running";
    case "completed":
      return "success";
    case "failed":
      return "error";
    default:
      return null;
  }
}

/** `_meta.goal` → snapshot.goal；未知状态按 active 呈现，不猜测为已完成。 */
export function projectAcpGoal(goal: AcpGoalMeta): GoalState {
  const status = goal.status?.toLowerCase();
  return {
    targetId: "acp",
    objective: goal.objective,
    summaryTitle: null,
    timeUsedSeconds: Math.floor(goal.timeUsedSeconds ?? 0),
    activeRunStartedAtMs: null,
    status:
      status === "complete" || status === "completed"
        ? "verified"
        : status === "paused" || status === "blocked" || status === "limited"
          ? "paused"
          : "active",
    iteration: goal.iterations ?? 0,
    verifications: [],
    iterations: [],
  };
}
