import type { ContentBlock, InitializeResponse } from "@agentclientprotocol/sdk";

/**
 * 运行中输入的投递方式：
 * - `session-steering`：`_session/steering`（claude-agent-acp、codex-acp，顶层 `_meta.steering.supported`）
 * - `lody-steer`：`_lody/session/steer`（acp-extension-pi，`agentCapabilities._meta.lody.steering`）
 */
export type AcpSteeringKind = "session-steering" | "lody-steer";

export const SESSION_STEERING_METHOD = "_session/steering";
export const LODY_STEER_METHOD = "_lody/session/steer";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function detectAcpSteering(response: InitializeResponse): AcpSteeringKind | null {
  const topLevel = record(record(response._meta)?.steering);
  if (topLevel?.supported === true) return "session-steering";
  const lody = record(record(record(response.agentCapabilities?._meta)?.lody)?.steering);
  if (lody && lody.transport === "request") return "lody-steer";
  return null;
}

/** injected：已进入运行中的 turn；promptRequired：Agent 已空闲，内容仍归 Host，需按普通 prompt 提交。 */
export type AcpSteerOutcome = "injected" | "promptRequired";

export interface AcpExtCaller {
  extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export async function steerAcpSession(
  caller: AcpExtCaller,
  kind: AcpSteeringKind,
  input: { sessionId: string; steerId: string; prompt: ContentBlock[] },
): Promise<AcpSteerOutcome> {
  if (kind === "session-steering") {
    // promptRequired：空闲时不让 Agent 自行起一个脱离 Host 生命周期的新 turn（其默认 startedNewTurn）。
    const response = await caller.extMethod(SESSION_STEERING_METHOD, {
      sessionId: input.sessionId,
      prompt: input.prompt,
      _meta: { steering: { idleBehavior: "promptRequired" } },
    });
    if (response.outcome === "injected") return "injected";
    if (response.outcome === "promptRequired") return "promptRequired";
    throw new Error(`Unexpected steering outcome ${JSON.stringify(response.outcome)}`);
  }
  // Pi 只在有已开始、未结束的 run 时接受 steer，否则拒绝；拒绝即交回 Host 作为下一轮。
  try {
    await caller.extMethod(LODY_STEER_METHOD, {
      sessionId: input.sessionId,
      steerId: input.steerId,
      prompt: input.prompt,
    });
    return "injected";
  } catch (error) {
    // SDK 以 JSON-RPC error 对象（非 Error 实例）拒绝，读取其 message 字段。
    const message = (error as { message?: unknown } | null)?.message;
    if (/No available Pi turn/i.test(typeof message === "string" ? message : String(error)))
      return "promptRequired";
    throw error;
  }
}
