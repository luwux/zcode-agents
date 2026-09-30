/**
 * ACP Agent 会话模式 → CodeZ 模式类别，只决定图标与完全访问的警示色。
 *
 * 模式名称与说明始终使用 Agent 原文（Claude “Manual / Accept edits / Bypass permissions”，
 * Codex “Ask for approval / Approve for me / Full access”），不改名、不翻译；
 * 类别按 ACP `_meta.kind` 与已知 id 判断，无法识别的归为 custom。
 */
export type AcpModeCategory = "plan" | "build" | "edit" | "autoReview" | "yolo" | "custom";

export interface AcpModeInfo {
  id: string;
  name: string;
  description?: string;
  kind?: string;
}

const FULL_ACCESS_IDS = new Set([
  "bypasspermissions",
  "agent-full-access",
  "danger-full-access",
  "full-access",
  "yolo",
]);
const ASK_IDS = new Set(["default", "manual", "ask", "build"]);
// Codex 的 “read-only” 实为 workspace-write 沙箱 + on-request：工作区内直接修改，越界才询问，
// 与 CodeZ 的「自动编辑」语义一致，而不是「修改前询问」。
const EDIT_IDS = new Set(["acceptedits", "edit", "read-only"]);

export function classifyAcpMode(mode: Pick<AcpModeInfo, "id" | "kind">): AcpModeCategory {
  const id = mode.id.trim().toLowerCase();
  const kind = mode.kind?.trim().toLowerCase();
  if (kind === "plan" || id === "plan") return "plan";
  if (kind === "full_access" || FULL_ACCESS_IDS.has(id)) return "yolo";
  if (kind === "auto_review") return "autoReview";
  if (EDIT_IDS.has(id)) return "edit";
  if (ASK_IDS.has(id)) return "build";
  return "custom";
}
