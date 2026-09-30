import type { SessionMode } from "@agentclientprotocol/sdk";

export interface AcpModeOption {
  id: string;
  name: string;
  description?: string;
  kind?: string;
}

/**
 * ACP 会话模式 → 快照/预览中的模式选项。
 * 保留 `_meta.kind`（claude-agent-acp / codex-acp 使用 standard、plan、auto_review、full_access），
 * UI 据此把不同 Agent 的模式统一成 CodeZ 的模式图标、文案与说明，而不是逐个 Agent 硬编码名称。
 */
export function toAcpModeOption({ id, name, description, _meta }: SessionMode): AcpModeOption {
  const kind = _meta?.kind;
  return {
    id,
    name,
    ...(description ? { description } : {}),
    ...(typeof kind === "string" && kind ? { kind } : {}),
  };
}
