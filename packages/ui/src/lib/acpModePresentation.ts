/**
 * ACP Agent 会话模式 → CodeZ 统一的权限模式类别。
 *
 * 各 Agent 自带的模式名称各不相同（Claude “Manual / Accept edits / Auto / Bypass permissions”，
 * Codex “Ask for approval / Approve for me / Full access”），直接展示会让同一个选择器在不同 Agent 下
 * 长得完全不一样。这里按 ACP `_meta.kind` 与已知 id 归入 CodeZ 的类别，由 UI 复用原生模式的图标、
 * 文案与说明；无法识别的模式保留 Agent 原文。
 */
export type AcpModeCategory = "plan" | "build" | "edit" | "autoReview" | "yolo" | "custom";

export interface AcpModeInfo {
  id: string;
  name: string;
  description?: string;
  kind?: string;
}

export interface AcpModePresentation {
  mode: AcpModeInfo;
  category: AcpModeCategory;
  /** 同一类别出现多次时只有第一个使用统一文案，其余保留 Agent 原文以便区分。 */
  useAgentText: boolean;
}

const CATEGORY_ORDER: readonly AcpModeCategory[] = [
  "plan",
  "build",
  "edit",
  "autoReview",
  "yolo",
  "custom",
];

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

/** 按 CodeZ 的模式顺序排列，并标记重复类别。 */
export function presentAcpModes(modes: readonly AcpModeInfo[]): AcpModePresentation[] {
  const seen = new Set<AcpModeCategory>();
  return modes
    .map((mode) => ({ mode, category: classifyAcpMode(mode) }))
    .sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category))
    .map(({ mode, category }) => {
      const useAgentText = category === "custom" || seen.has(category);
      seen.add(category);
      return { mode, category, useAgentText };
    });
}
