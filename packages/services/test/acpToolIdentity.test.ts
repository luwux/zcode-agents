import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationRow, ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import { AcpConversationProjection } from "../src/agent-runtime/acpConversationProjection.js";
import type { AcpSessionUpdate } from "../src/agent-runtime/acpExtensionSchemas.js";

function run(updates: AcpSessionUpdate[]): ToolCallRow[] {
  const projection = new AcpConversationProjection("task");
  projection.beginTurn("command", "go", undefined, 1);
  for (const update of updates) projection.applyUpdate({ sessionId: "root", update }, 2);
  return projection
    .snapshot()
    .rows.window.filter((row: ConversationRow): row is ToolCallRow => row.kind === "toolCall");
}

test("Claude refine update title never overwrites the programmatic tool name", () => {
  // claude-agent-acp 0.81：tool_call 带 name，refine 的 tool_call_update 只带描述性 title。
  const [row] = run([
    {
      sessionUpdate: "tool_call",
      toolCallId: "toolu_1",
      name: "Read",
      title: "Read",
      kind: "read",
      status: "pending",
      rawInput: { file_path: "/repo/src/a.ts" },
      _meta: { claudeCode: { toolName: "Read" } },
    },
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "toolu_1",
      title: "Read src/a.ts",
      rawInput: { file_path: "/repo/src/a.ts", limit: 20 },
      _meta: { claudeCode: { toolName: "Read" } },
    },
    { sessionUpdate: "tool_call_update", toolCallId: "toolu_1", status: "completed" },
  ]);
  assert.equal(row?.toolName, "Read");
  assert.deepEqual(row?.input, { file_path: "/repo/src/a.ts", limit: 20 });
  assert.equal(row?.status, "success");
});

test("claudeCode meta names a tool without the standard name field", () => {
  const [row] = run([
    {
      sessionUpdate: "tool_call",
      toolCallId: "toolu_2",
      title: "ls -la",
      kind: "execute",
      rawInput: { command: "ls -la", description: "List files" },
      _meta: { claudeCode: { toolName: "Bash", title: "List files" } },
    },
  ]);
  assert.equal(row?.toolName, "Bash");
  assert.deepEqual(row?.input, { command: "ls -la", description: "List files" });
});

test("kind fallback names Codex and Pi tools and fills renderer keys", () => {
  const rows = run([
    // codex-acp 1.13：unified exec 带 name "exec_command"（非已知工具名）+ kind execute。
    {
      sessionUpdate: "tool_call",
      toolCallId: "call_exec",
      name: "exec_command",
      kind: "execute",
      title: "git status",
      status: "in_progress",
      rawInput: { command: "git status", cwd: "/repo" },
    },
    {
      sessionUpdate: "tool_call",
      toolCallId: "call_read",
      kind: "read",
      title: "Read file 'src/a.ts'",
      status: "completed",
      locations: [{ path: "/repo/src/a.ts" }],
    },
    // acp-extension-pi：title 为小写工具名，find 走 search。
    {
      sessionUpdate: "tool_call",
      toolCallId: "pi_bash",
      title: "bash",
      kind: "execute",
      status: "in_progress",
      rawInput: { command: "pwd" },
    },
    {
      sessionUpdate: "tool_call",
      toolCallId: "pi_find",
      title: "find",
      kind: "search",
      status: "in_progress",
      rawInput: { pattern: "*.ts" },
    },
    {
      sessionUpdate: "tool_call",
      toolCallId: "codex_fetch",
      kind: "fetch",
      title: "https://example.test/doc",
      status: "completed",
    },
  ]);
  assert.deepEqual(
    rows.map((row) => row.toolName),
    ["Bash", "Read", "Bash", "Grep", "WebFetch"],
  );
  assert.deepEqual(rows[1]?.input, { file_path: "/repo/src/a.ts" });
  assert.deepEqual(rows[3]?.input, { pattern: "*.ts" });
  assert.deepEqual(rows[4]?.input, { url: "https://example.test/doc" });
});

test("a weak title identity is upgraded once by a later programmatic name", () => {
  const [row] = run([
    { sessionUpdate: "tool_call", toolCallId: "t", title: "Working", kind: "other" },
    { sessionUpdate: "tool_call_update", toolCallId: "t", title: "Still working" },
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "t",
      title: "Skill: review",
      _meta: { claudeCode: { toolName: "Skill" } },
    },
    { sessionUpdate: "tool_call_update", toolCallId: "t", title: "Other" },
  ]);
  assert.equal(row?.toolName, "Skill");
});

test("MCP tools use mcp__<server>__<tool> with an mcp_tool display", () => {
  const rows = run([
    {
      sessionUpdate: "tool_call",
      toolCallId: "mcp_1",
      kind: "execute",
      title: "mcp.github.search_issues",
      status: "in_progress",
      rawInput: { server: "github", tool: "search_issues", arguments: { q: "bug" } },
      _meta: { is_mcp_tool_call: true },
    },
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "mcp_1",
      status: "completed",
      rawOutput: { result: { content: [{ type: "text", text: "3 issues" }] }, error: null },
    },
    {
      sessionUpdate: "tool_call",
      toolCallId: "toolu_mcp",
      name: "mcp__linear__list_issues",
      title: "List issues",
      status: "pending",
      rawInput: { team: "core" },
    },
  ]);
  assert.equal(rows[0]?.toolName, "mcp__github__search_issues");
  assert.deepEqual(rows[0]?.input, { q: "bug" });
  assert.deepEqual(rows[0]?.display, {
    kind: "mcp_tool",
    serverName: "github",
    toolName: "search_issues",
  });
  assert.equal(rows[0]?.output?.text, "3 issues");
  assert.equal(rows[1]?.toolName, "mcp__linear__list_issues");
  assert.deepEqual(rows[1]?.display, {
    kind: "mcp_tool",
    serverName: "linear",
    toolName: "list_issues",
  });
});

test("Codex computer-use MCP calls render as CUA with bounded screenshots", () => {
  const small = Buffer.alloc(1_000, 1).toString("base64");
  const huge = "A".repeat(200 * 1024 + 4);
  const rows = run([
    {
      sessionUpdate: "tool_call",
      toolCallId: "cua_1",
      kind: "execute",
      title: "mcp.computer-use.screenshot",
      status: "in_progress",
      rawInput: { server: "computer-use", tool: "screenshot", arguments: { app: "Finder" } },
      _meta: { is_mcp_tool_call: true },
    },
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "cua_1",
      status: "completed",
      rawOutput: {
        result: {
          content: [
            { type: "text", text: "captured" },
            { type: "image", data: small, mimeType: "image/png" },
            { type: "image", data: huge, mimeType: "image/png" },
          ],
        },
        error: null,
      },
    },
    {
      sessionUpdate: "tool_call",
      toolCallId: "repl_1",
      name: "mcp__node_repl__js",
      title: "js",
      status: "completed",
      content: [
        { type: "content", content: { type: "image", data: small, mimeType: "image/png" } },
      ],
    },
  ]);
  const cua = rows[0];
  assert.equal(cua?.toolName, "mcp__computer-use__screenshot");
  assert.equal(cua?.display, undefined);
  const display = cua?.output?.display;
  assert.equal(display?.kind, "cua");
  if (display?.kind !== "cua") return;
  assert.equal(display.status, "success");
  assert.equal(display.toolName, "screenshot");
  assert.equal(display.media?.length, 1);
  assert.equal(display.truncated, true);
  assert.equal(rows[1]?.display?.kind, "node_repl_images");
});
