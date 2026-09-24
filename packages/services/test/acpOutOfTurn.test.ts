import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { AcpConversationProjection } from "../src/agent-runtime/acpConversationProjection.js";
import type { AcpSessionUpdate } from "../src/agent-runtime/acpExtensionSchemas.js";
import type { AcpTranscriptEntry } from "../src/agent-runtime/acpTranscriptStore.js";

const ROOT = "root-native";
const text = (value: string): AcpSessionUpdate => ({
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text: value },
});

/** 一轮：Bash 转入后台（AIR 标记 + async_task_spawned），回合结束后任务完成。 */
function backgroundBashEntries(): AcpTranscriptEntry[] {
  return [
    { v: 1, kind: "prompt", at: 1_000, commandId: "p1", content: [{ type: "text", text: "run" }] },
    {
      v: 1,
      kind: "update",
      at: 1_100,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "toolu_bash",
        name: "Bash",
        title: "npm test",
        status: "pending",
        rawInput: { command: "npm test", run_in_background: true },
      },
    },
    {
      v: 1,
      kind: "update",
      at: 1_200,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "toolu_bash",
        status: "completed",
        _meta: { jetbrains: { air: { version: 1, asyncTasks: { backgrounded: true } } } },
      },
    },
    {
      v: 1,
      kind: "update",
      at: 1_300,
      update: {
        sessionUpdate: "async_task_spawned",
        asyncTaskId: "bg-1",
        name: "npm test",
        taskType: "shell",
        canStop: true,
        toolCallId: "toolu_bash",
      },
    },
    { v: 1, kind: "turnEnd", at: 1_400, result: { stopReason: "end_turn" } },
    {
      v: 1,
      kind: "update",
      at: 10_000,
      update: { sessionUpdate: "async_task_state_update", asyncTaskId: "bg-1", state: "completed" },
    },
    // Claude 在后台完成后自主续写：回合外内容。
    { v: 1, kind: "update", at: 15_000, update: text("Tests passed.") },
    { v: 1, kind: "update", at: 50_000, update: text("late and unattributable") },
  ];
}

function rows(projection: AcpConversationProjection): ConversationRow[] {
  return projection.snapshot().rows.window;
}

test("background bash lifecycle and attributable out-of-turn content (live equals replay)", () => {
  const live = new AcpConversationProjection("task");
  for (const entry of backgroundBashEntries()) {
    if (entry.kind === "prompt") live.beginTurn(entry.commandId, "run", undefined, entry.at);
    else if (entry.kind === "update")
      live.applyUpdate({ sessionId: ROOT, update: entry.update }, entry.at);
    else live.finishTurn(entry.result, entry.at);
    if (entry.kind === "update" && entry.update.sessionUpdate === "async_task_spawned") {
      const works = live.snapshot().backgroundWorks;
      assert.equal(works[0]?.workId, "bg-1");
      assert.equal(works[0]?.kind, "bash");
      assert.equal(works[0]?.status, "running");
      assert.equal(works[0]?.cancellable, true);
      const bash = rows(live).find((row) => row.kind === "toolCall");
      assert.equal(works[0]?.anchorRowId, bash?.rowId);
      assert.equal(bash?.kind === "toolCall" && bash.backgrounded, true);
      assert.equal(bash?.kind === "toolCall" && bash.workId, "bg-1");
    }
  }
  const replay = new AcpConversationProjection("task");
  replay.restore(backgroundBashEntries());
  for (const projection of [live, replay]) {
    const snapshot = projection.snapshot();
    // completed 从 backgroundWorks 移除（结果已投递）；展示轮不改变 phase 与输入路由。
    assert.equal(snapshot.backgroundWorks.length, 0);
    assert.equal(snapshot.control.phase, "completedSuccess");
    assert.equal(snapshot.inputRouting.mode, "startNow");
    const headers = snapshot.rows.window.filter((row) => row.kind === "turnHeader");
    assert.equal(headers.length, 2);
    const display = headers[1];
    assert.equal(display?.kind === "turnHeader" && display.origin, "backgroundResult");
    assert.equal(display?.kind === "turnHeader" && display.state, "completedSuccess");
    assert.deepEqual(display?.kind === "turnHeader" && display.originMeta, {
      backgroundSource: "bash",
      workId: "bg-1",
      title: "npm test",
    });
    const texts = snapshot.rows.window.filter((row) => row.kind === "assistantText");
    assert.deepEqual(
      texts.map((row) => row.kind === "assistantText" && [row.text, row.state, row.turnId]),
      [["Tests passed.", "complete", display?.turnId]],
    );
  }
});

test("out-of-turn content is dropped without background work and attributed to running work", () => {
  const projection = new AcpConversationProjection("task");
  projection.beginTurn("p1", "go", undefined, 1);
  projection.finishTurn({ stopReason: "end_turn" }, 2);
  projection.applyUpdate({ sessionId: ROOT, update: text("nobody asked") }, 3);
  assert.equal(rows(projection).filter((row) => row.kind === "assistantText").length, 0);
  // 生命周期更新在回合外同样生效。
  projection.applyUpdate(
    {
      sessionId: ROOT,
      update: {
        sessionUpdate: "async_task_spawned",
        asyncTaskId: "wf-1",
        name: "nightly-review",
        taskType: "workflow",
        canStop: true,
      },
    },
    100_000,
  );
  projection.applyUpdate(
    {
      sessionId: ROOT,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "toolu_late",
        name: "Read",
        title: "Read",
        status: "in_progress",
        rawInput: { file_path: "/repo/a.ts" },
      },
    },
    200_000,
  );
  const snapshot = projection.snapshot();
  assert.equal(snapshot.backgroundWorks[0]?.title, "nightly-review");
  const header = snapshot.rows.window.at(-2);
  assert.equal(header?.kind === "turnHeader" && header.origin, "backgroundResult");
  assert.equal(snapshot.rows.window.at(-1)?.kind, "toolCall");
  // 新回合开始时，展示轮中未收口的工具行被标记为 cancelled。
  projection.beginTurn("p2", "next", undefined, 200_001);
  const late = rows(projection).find(
    (row) => row.kind === "toolCall" && row.toolCallId === "toolu_late",
  );
  assert.equal(late?.kind === "toolCall" && late.status, "cancelled");
  projection.applyUpdate(
    {
      sessionId: ROOT,
      update: { sessionUpdate: "async_task_state_update", asyncTaskId: "wf-1", state: "stopped" },
    },
    200_002,
  );
  assert.equal(projection.snapshot().backgroundWorks[0]?.status, "cancelled");
  // 终态不回到运行中：stopped 之后的 running 不会恢复。
  projection.applyUpdate(
    {
      sessionId: ROOT,
      update: { sessionUpdate: "async_task_state_update", asyncTaskId: "wf-1", state: "running" },
    },
    200_003,
  );
  assert.equal(projection.snapshot().backgroundWorks[0]?.status, "cancelled");
  // 实录（claude-agent-acp 0.81.2）：尽力而为的 "stopped" 之后由权威的 "completed" 更正，后到终态为准。
  projection.applyUpdate(
    {
      sessionId: ROOT,
      update: { sessionUpdate: "async_task_state_update", asyncTaskId: "wf-1", state: "completed" },
    },
    200_004,
  );
  assert.equal(projection.snapshot().backgroundWorks.length, 0);
});

test("session goal meta projects to snapshot.goal with a goalSet marker inside a turn", () => {
  const projection = new AcpConversationProjection("task");
  projection.beginTurn("p1", "/goal ship it", undefined, 1);
  projection.applyUpdate({
    sessionId: ROOT,
    update: {
      sessionUpdate: "session_info_update",
      _meta: {
        goal: {
          objective: "Ship the release",
          status: "active",
          timeUsedSeconds: 12.7,
          iterations: 2,
          controlMethod: "_session/goal",
        },
      },
    },
  });
  let snapshot = projection.snapshot();
  assert.equal(snapshot.goal?.objective, "Ship the release");
  assert.equal(snapshot.goal?.status, "active");
  assert.equal(snapshot.goal?.timeUsedSeconds, 12);
  assert.equal(snapshot.goal?.iteration, 2);
  const marker = snapshot.rows.window.find((row) => row.kind === "timelineMarker");
  assert.equal(marker?.kind === "timelineMarker" && marker.marker.type, "goalSet");
  projection.finishTurn({ stopReason: "end_turn" });
  // 回合外：Codex complete → verified；null 清除；缺省不变。
  projection.applyUpdate({
    sessionId: ROOT,
    update: {
      sessionUpdate: "session_info_update",
      _meta: { goal: { objective: "Ship the release", status: "complete" } },
    },
  });
  assert.equal(projection.snapshot().goal?.status, "verified");
  projection.applyUpdate({
    sessionId: ROOT,
    update: { sessionUpdate: "session_info_update", title: "t" },
  });
  assert.equal(projection.snapshot().goal?.status, "verified");
  projection.applyUpdate({
    sessionId: ROOT,
    update: { sessionUpdate: "session_info_update", _meta: { goal: null } },
  });
  snapshot = projection.snapshot();
  assert.equal(snapshot.goal, null);
  assert.equal(snapshot.rows.window.filter((row) => row.kind === "timelineMarker").length, 1);
});

test("restore fails background work and subagents orphaned by the old process", () => {
  const projection = new AcpConversationProjection("task");
  projection.restore([
    { v: 1, kind: "prompt", at: 1, commandId: "p1", content: [{ type: "text", text: "go" }] },
    {
      v: 1,
      kind: "update",
      at: 2,
      update: {
        sessionUpdate: "async_task_spawned",
        asyncTaskId: "bg",
        name: "watch",
        canStop: true,
      },
    },
    {
      v: 1,
      kind: "update",
      at: 3,
      update: { sessionUpdate: "subagent_spawned", subagentSessionId: "bg-agent", name: "Explore" },
    },
    { v: 1, kind: "turnEnd", at: 4, result: { stopReason: "end_turn" } },
  ]);
  const snapshot = projection.snapshot();
  assert.equal(snapshot.backgroundWorks[0]?.status, "failed");
  assert.equal(snapshot.subagents?.running.length, 0);
  const subagent = snapshot.rows.window.find((row) => row.kind === "subagent");
  assert.equal(subagent?.kind === "subagent" && subagent.status, "failed");
});
