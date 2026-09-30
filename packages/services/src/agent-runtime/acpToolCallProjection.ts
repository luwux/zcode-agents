import type { SessionNotification } from "@agentclientprotocol/sdk";
import { normalizeZCodeToolName } from "@zcode/shared";
import type { ToolCallDisplay, ToolOutput } from "@zcode/shared/zcode-protocol-v4";
import { readClaudeCodeToolName, record } from "#src/agent-runtime/acpExtensionSchemas.js";

export type AcpToolUpdate = Extract<
  SessionNotification["update"],
  { sessionUpdate: "tool_call" | "tool_call_update" }
>;

/** 工具身份：首次出现时确定，弱来源（kind/title）只允许被强来源升级一次。 */
export interface AcpToolIdentity {
  toolName: string;
  strong: boolean;
  kindFallback?: true;
  mcp?: { serverName: string; toolName: string; computerUse: boolean; codexArguments: boolean };
}

const KIND_TOOL_NAMES: Partial<Record<string, string>> = {
  execute: "Bash",
  read: "Read",
  edit: "Edit",
  search: "Grep",
  fetch: "WebFetch",
};
const MAX_INPUT_TEXT = 8_192;
const MAX_OUTPUT_TEXT = 8_192;
const MAX_IMAGE_BASE64 = 200 * 1024;

export function resolveAcpToolIdentity(
  update: AcpToolUpdate,
  previous: AcpToolIdentity | undefined,
): AcpToolIdentity {
  const next = identityFrom(update, previous !== undefined);
  if (!previous) return next ?? { toolName: "ACP tool", strong: false };
  // 修复：refine 的 tool_call_update 只带描述性 title（如 "Read src/a.ts"），不能覆盖已确定的工具名。
  if (previous.strong || !next?.strong) return previous;
  return next;
}

function identityFrom(update: AcpToolUpdate, refining: boolean): AcpToolIdentity | null {
  const mcp = readMcpIdentity(update);
  if (mcp) {
    const serverName = mcp.computerUse ? "computer-use" : mcp.serverName;
    return { toolName: `mcp__${serverName}__${mcp.toolName}`, strong: true, mcp };
  }
  const name = update.name?.trim() || readClaudeCodeToolName(update._meta);
  const known = normalizeZCodeToolName(name);
  if (known) return { toolName: known, strong: true };
  const byKind = update.kind ? KIND_TOOL_NAMES[update.kind] : undefined;
  if (byKind) return { toolName: byKind, strong: false, kindFallback: true };
  if (name) return { toolName: name, strong: true };
  // refine 更新中的 title 是描述而非身份；只有首次出现才用它兜底。
  if (!refining && update.title?.trim()) return { toolName: update.title.trim(), strong: false };
  return null;
}

function readMcpIdentity(update: AcpToolUpdate): AcpToolIdentity["mcp"] | null {
  const raw = record(update.rawInput);
  const meta = record(update._meta);
  // codex-acp：`_meta.is_mcp_tool_call` + rawInput{server, tool, arguments}，title 为 `mcp.<server>.<tool>`。
  if (
    raw &&
    typeof raw.server === "string" &&
    raw.server &&
    typeof raw.tool === "string" &&
    raw.tool &&
    (meta?.is_mcp_tool_call === true || update.title?.startsWith("mcp."))
  )
    return mcpIdentity(raw.server, raw.tool, true);
  // claude-agent-acp：程序化名称即 `mcp__<server>__<tool>`。
  const name = update.name?.trim() || readClaudeCodeToolName(update._meta);
  const match = name ? /^mcp__(.+?)__(.+)$/u.exec(name) : null;
  if (match?.[1] && match[2]) return mcpIdentity(match[1], match[2], false);
  return null;
}

function mcpIdentity(serverName: string, toolName: string, codexArguments: boolean) {
  const normalized = serverName.toLowerCase().replace(/_/gu, "-");
  return { serverName, toolName, computerUse: normalized.includes("computer-use"), codexArguments };
}

/** 结构化 input：保留 rawInput；kind 回退时补齐渲染器所需的最小键。 */
export function projectAcpToolInput(
  update: AcpToolUpdate,
  identity: AcpToolIdentity,
  previousInput: unknown,
): unknown {
  let input: unknown = update.rawInput ?? previousInput;
  if (identity.mcp?.codexArguments && update.rawInput !== undefined)
    input = record(update.rawInput)?.arguments ?? {};
  if (!identity.kindFallback) return input;
  const base = record(input) ?? {};
  const location = update.locations?.[0]?.path;
  const title = update.title?.trim();
  switch (identity.toolName) {
    case "Bash":
      return typeof base.command === "string" || !title ? input : { ...base, command: title };
    case "Read":
    case "Edit": {
      const filePath = base.file_path ?? base.path ?? location ?? diffPath(update);
      return typeof filePath === "string" ? { ...base, file_path: filePath } : input;
    }
    case "Grep":
      return typeof base.pattern === "string" || !title
        ? input
        : { ...base, pattern: base.query ?? title };
    case "WebFetch":
      return typeof base.url === "string" || !title ? input : { ...base, url: title };
    default:
      return input;
  }
}

function diffPath(update: AcpToolUpdate): string | undefined {
  for (const item of update.content ?? []) if (item.type === "diff") return item.path;
  return undefined;
}

export function boundedJson(value: unknown, limit = MAX_INPUT_TEXT): string {
  if (value === undefined) return "";
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  return (serialized ?? "").slice(0, limit);
}

/** row 顶层 display：MCP 工具卡（与 ZCode CLI 投影一致，运行中即可识别）。 */
export function projectAcpToolDisplay(identity: AcpToolIdentity): ToolCallDisplay | undefined {
  if (!identity.mcp || identity.mcp.computerUse) return undefined;
  if (identity.toolName.startsWith("mcp__node_repl__")) return undefined;
  return {
    kind: "mcp_tool",
    serverName: identity.mcp.serverName.slice(0, 256),
    toolName: identity.mcp.toolName.slice(0, 256),
  };
}

interface AcpImage {
  data: string;
  mimeType: string;
}

/** 输出：文本优先；CUA 截图进入 output.display.kind="cua"，node_repl 截图进入 row.display。 */
export function projectAcpToolOutput(
  update: AcpToolUpdate,
  identity: AcpToolIdentity,
  terminal: "success" | "error" | null,
): { output?: ToolOutput; imageDisplay?: ToolCallDisplay } {
  const texts: string[] = [];
  const images: AcpImage[] = [];
  for (const item of update.content ?? []) {
    if (item.type !== "content") continue;
    if (item.content.type === "text") texts.push(item.content.text);
    else if (item.content.type === "image")
      images.push({ data: item.content.data, mimeType: item.content.mimeType });
  }
  const mcpTexts: string[] = [];
  const mcpResult = record(record(update.rawOutput)?.result);
  if (Array.isArray(mcpResult?.content)) {
    for (const block of mcpResult.content) {
      const entry = record(block);
      if (entry?.type === "text" && typeof entry.text === "string") mcpTexts.push(entry.text);
      if (
        entry?.type === "image" &&
        typeof entry.data === "string" &&
        typeof entry.mimeType === "string"
      )
        images.push({ data: entry.data, mimeType: entry.mimeType });
    }
  }
  const text = (
    texts.join("\n") ||
    mcpTexts.join("\n") ||
    boundedJson(update.rawOutput, MAX_OUTPUT_TEXT)
  ).slice(0, MAX_OUTPUT_TEXT);
  const bounded = images.filter(
    (image) => image.data.length > 0 && image.data.length <= MAX_IMAGE_BASE64,
  );
  const truncated = bounded.length < images.length;
  if (identity.mcp?.computerUse && terminal) {
    const media = bounded.slice(0, 4).map(({ data, mimeType }) => ({ data, mimeType }));
    return {
      output: {
        text,
        display: {
          kind: "cua",
          schemaVersion: 1,
          toolName: identity.mcp.toolName,
          status: terminal === "success" ? "success" : "failed",
          ...(text ? { text } : {}),
          ...(media.length ? { media } : {}),
          ...(truncated || bounded.length > 4 ? { truncated: true } : {}),
        },
      },
    };
  }
  const replImages = identity.toolName.startsWith("mcp__node_repl__")
    ? bounded.filter((image) => /^image\/[a-z0-9.+-]+$/iu.test(image.mimeType))
    : [];
  return {
    ...(text ? { output: { text } } : {}),
    ...(replImages.length > 0
      ? {
          imageDisplay: {
            kind: "node_repl_images",
            images: replImages
              .slice(0, 2)
              .map(({ data, mimeType }) => ({ base64: data, mimeType })),
            ...(truncated || replImages.length > 2 ? { truncated: true } : {}),
          },
        }
      : {}),
  };
}
