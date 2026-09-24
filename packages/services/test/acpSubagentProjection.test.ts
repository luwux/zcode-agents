import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { AcpConversationProjection } from "../src/agent-runtime/acpConversationProjection.js";
import type { AcpTranscriptEntry } from "../src/agent-runtime/acpTranscriptStore.js";
import { acpSubagentSessionId } from "../src/agent-runtime/acpSubagentRegistry.js";

// claude-agent-acp 0.81 native-subagents.js / codex-acp 1.13 CodexSubagentEventRouter 的真实 wire 形状。
const ROOT = "root-native";
const V = (key: string) => acpSubagentSessionId("task", key);

function rowsOf(projection: AcpConversationProjection | null): ConversationRow[] {
  assert.ok(projection);
  return projection.snapshot().rows.window;
}

function spawnedTranscript(): AcpTranscriptEntry[] {
  return [
    { v: 1, kind: "prompt", at: 1, commandId: "p1", content: [{ type: "text", text: "explore" }] },
    {
      v: 1,
      kind: "update",
      at: 2,
      update: {
        sessionUpdate: "subagent_spawned",
        subagentSessionId: "task-1",
        name: "Explore",
        task: "Find the config loader",
      },
    },
    {
      v: 1,
      kind: "update",
      at: 3,
      sessionId: "task-1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "toolu_child",
        name: "Grep",
        title: "grep loader",
        status: "completed",
        rawInput: { pattern: "loader" },
      },
    },
    {
      v: 1,
      kind: "update",
      at: 4,
      sessionId: "task-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "The loader is in src/config.ts" },
      },
    },
    {
      v: 1,
      kind: "update",
      at: 5,
      update: {
        sessionUpdate: "subagent_state_update",
        subagentSessionId: "task-1",
        state: "completed",
      },
    },
    { v: 1, kind: "turnEnd", at: 6, result: { stopReason: "end_turn" } },
  ];
}

test("native subagent spawn pairs a host Agent row, a child session and a success summary", () => {
  for (const mode of ["live", "replay"] as const) {
    const projection = new AcpConversationProjection("task");
    if (mode === "replay") projection.restore(spawnedTranscript());
    else
      for (const entry of spawnedTranscript()) {
        if (entry.kind === "prompt") projection.beginTurn(entry.commandId, "explore", undefined, 1);
        else if (entry.kind === "update")
          projection.applyUpdate(
            { sessionId: entry.sessionId ?? ROOT, update: entry.update },
            entry.at,
          );
        else projection.finishTurn(entry.result, entry.at);
      }
    const rows = rowsOf(projection);
    const host = rows.find((row) => row.kind === "toolCall");
    const subagent = rows.find((row) => row.kind === "subagent");
    assert.equal(host?.kind === "toolCall" && host.toolName, "Agent", mode);
    assert.equal(host?.kind === "toolCall" && host.status, "success");
    assert.equal(subagent?.kind === "subagent" && subagent.parentToolCallId, "acp-subagent:task-1");
    assert.equal(subagent?.turnId, host?.turnId);
    assert.equal(subagent?.kind === "subagent" && subagent.status, "success");
    assert.equal(
      subagent?.kind === "subagent" && subagent.summaryText,
      "The loader is in src/config.ts",
    );
    assert.equal(subagent?.kind === "subagent" && subagent.childSessionId, V("task-1"));
    // 子会话行只出现在子投影中，根会话不混入子工具与文本。
    assert.equal(rows.filter((row) => row.kind === "assistantText").length, 0);
    const child = projection.childProjection(V("task-1"));
    const childRows = rowsOf(child);
    assert.deepEqual(
      childRows.map((row) => row.kind),
      ["turnHeader", "userInput", "toolCall", "assistantText"],
    );
    assert.equal(childRows[1]?.kind === "userInput" && childRows[1].origin, "synthetic");
    const childSnapshot = child!.snapshot();
    assert.equal(childSnapshot.inputRouting.mode, "reject");
    assert.equal(childSnapshot.control.phase, "completedSuccess");
    const state = projection.snapshot().subagents;
    assert.deepEqual(state?.childSessionIds, [V("task-1")]);
    assert.equal(state?.running.length, 0);
    assert.equal(state?.endedTotal, 1);
    assert.equal(projection.listSubagents("task", undefined, 20).ended.items[0]?.status, "success");
  }
});

test("nested, duplicate and generation spawns keep one registry and per-parent directories", () => {
  const projection = new AcpConversationProjection("task");
  projection.beginTurn("p1", "go", undefined, 1);
  const spawn = (sessionId: string, key: string) =>
    projection.applyUpdate(
      {
        sessionId,
        update: { sessionUpdate: "subagent_spawned", subagentSessionId: key, name: "Plan" },
      },
      2,
    );
  spawn(ROOT, "task-1");
  spawn(ROOT, "task-1");
  spawn("task-1", "grandchild");
  spawn(ROOT, "task-1:generation:2");
  const rootState = projection.snapshot().subagents;
  assert.deepEqual(rootState?.childSessionIds, [V("task-1"), V("task-1:generation:2")]);
  assert.equal(rowsOf(projection).filter((row) => row.kind === "subagent").length, 2);
  const child = projection.childProjection(V("task-1"));
  assert.deepEqual(child?.snapshot().subagents?.childSessionIds, [V("grandchild")]);
  assert.ok(rowsOf(child).some((row) => row.kind === "subagent"));
  // 子会话的更新按登记表路由到孙会话，而不是根会话。
  projection.applyUpdate(
    {
      sessionId: "grandchild",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "deep" } },
    },
    3,
  );
  assert.ok(
    rowsOf(projection.childProjection(V("grandchild"))).some(
      (row) => row.kind === "assistantText" && row.text === "deep",
    ),
  );
  // 根回合被取消时，仍运行的子智能体随之以 cancelled 收口。
  projection.finishTurn({ stopReason: "cancelled" }, 4);
  assert.ok(
    rowsOf(projection)
      .filter((row) => row.kind === "subagent")
      .every((row) => row.kind === "subagent" && row.status === "cancelled"),
  );
  assert.equal(
    projection.childProjection(V("task-1"))?.snapshot().control.phase,
    "completedInterrupted",
  );
});

test("child permission is pending on the root with a subagent origin and blocks the child", () => {
  const projection = new AcpConversationProjection("task");
  projection.beginTurn("p1", "go", undefined, 1);
  projection.applyUpdate(
    {
      sessionId: ROOT,
      update: {
        sessionUpdate: "subagent_spawned",
        subagentSessionId: "task-1",
        name: "Explore",
        task: "t",
      },
    },
    2,
  );
  const id = projection.requestPermission(
    {
      sessionId: "task-1",
      toolCall: { toolCallId: "toolu_edit", title: "Edit file" },
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
    },
    "acp-subagent:task-1:toolu_edit",
    "task-1",
  );
  const snapshot = projection.snapshot();
  const pending = snapshot.pendingInteractions[0];
  const host = snapshot.rows.window.find((row) => row.kind === "toolCall");
  assert.equal(pending?.interactionId, id);
  assert.equal(pending?.anchorRowId, host?.rowId);
  assert.equal(
    pending?.payload.kind === "permission" && pending.payload.origin?.childSessionId,
    V("task-1"),
  );
  assert.equal(
    pending?.payload.kind === "permission" && pending.payload.origin?.parentSessionId,
    "task",
  );
  assert.equal(snapshot.subagents?.running[0]?.status, "blocked");
  // 子会话终结后其交互从根会话消失。
  projection.applyUpdate(
    {
      sessionId: ROOT,
      update: {
        sessionUpdate: "subagent_state_update",
        subagentSessionId: "task-1",
        state: "failed",
      },
    },
    3,
  );
  assert.equal(projection.snapshot().pendingInteractions.length, 0);
  const failedHost = rowsOf(projection).find((row) => row.kind === "toolCall");
  assert.equal(failedHost?.kind === "toolCall" && failedHost.status, "error");
});

test("a failed spawn fallback is an ordinary failed Agent tool row without a subagent row", () => {
  const projection = new AcpConversationProjection("task");
  projection.beginTurn("p1", "go", undefined, 1);
  // native-subagents.js failedControlFallback：控制 tool_call 以普通失败工具行重发。
  projection.applyUpdate({
    sessionId: ROOT,
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "toolu_agent",
      name: "Agent",
      title: "Agent",
      status: "failed",
      rawInput: { description: "Explore", prompt: "x" },
      _meta: { claudeCode: { toolName: "Agent" } },
    },
  });
  const rows = rowsOf(projection);
  assert.equal(rows.filter((row) => row.kind === "subagent").length, 0);
  const agent = rows.find((row) => row.kind === "toolCall");
  assert.equal(agent?.kind === "toolCall" && agent.toolName, "Agent");
  assert.equal(agent?.kind === "toolCall" && agent.status, "error");
});

test("invalid extension updates are dropped without affecting the session", () => {
  const projection = new AcpConversationProjection("task");
  projection.beginTurn("p1", "go", undefined, 1);
  projection.applyUpdate({
    sessionId: ROOT,
    update: { sessionUpdate: "subagent_spawned", name: "missing id" } as never,
  });
  projection.applyUpdate({
    sessionId: ROOT,
    update: {
      sessionUpdate: "async_task_state_update",
      asyncTaskId: "a",
      state: "exploded",
    } as never,
  });
  assert.equal(rowsOf(projection).length, 2);
  assert.equal(projection.snapshot().control.phase, "running");
});

test("Pi lody task lifecycle pairs a subagent row with the Pi subagent tool row", () => {
  const projection = new AcpConversationProjection("task");
  projection.setLodySubagentCancel(true);
  projection.beginTurn("p1", "delegate", undefined, 1);
  projection.applyUpdate({
    sessionId: ROOT,
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "pi_call_1",
      title: "subagent",
      kind: "other",
      status: "in_progress",
      rawInput: { task: "Count files", description: "Count files" },
    },
  });
  const lody = (status: "in_progress" | "failed", error?: string) => ({
    sessionId: ROOT,
    update: {
      sessionUpdate:
        status === "in_progress" ? ("tool_call" as const) : ("tool_call_update" as const),
      toolCallId: "task-uuid",
      title: "Count files",
      status,
      _meta: {
        lody: {
          task: {
            version: 1,
            taskId: "task-uuid",
            kind: "subagent",
            parentToolCallId: "pi_call_1",
            description: "Count files",
            modelId: "openrouter/mimo",
            status,
            startedAtEpochSeconds: 1,
            ...(error ? { error, endedAtEpochSeconds: 2 } : {}),
          },
        },
      },
    },
  });
  projection.applyUpdate(lody("in_progress"), 2);
  let rows = rowsOf(projection);
  assert.deepEqual(
    rows
      .filter((row) => row.kind === "toolCall")
      .map((row) => row.kind === "toolCall" && row.toolName),
    ["subagent"],
  );
  const subagent = rows.find((row) => row.kind === "subagent");
  assert.equal(subagent?.kind === "subagent" && subagent.parentToolCallId, "pi_call_1");
  assert.equal(subagent?.kind === "subagent" && subagent.subagentType, "openrouter/mimo");
  const work = projection.snapshot().backgroundWorks[0];
  assert.equal(work?.kind, "subagent");
  assert.equal(work?.workId, "task-uuid");
  assert.equal(work?.cancellable, true);
  assert.deepEqual(projection.backgroundWorkTarget("task-uuid"), {
    kind: "lodyTask",
    running: true,
    cancellable: true,
  });
  projection.applyUpdate(lody("failed", "cancelled by user"), 3);
  rows = rowsOf(projection);
  const ended = rows.find((row) => row.kind === "subagent");
  assert.equal(ended?.kind === "subagent" && ended.status, "failed");
  assert.equal(ended?.kind === "subagent" && ended.summaryText, "cancelled by user");
  assert.equal(projection.snapshot().backgroundWorks.length, 0);
});
