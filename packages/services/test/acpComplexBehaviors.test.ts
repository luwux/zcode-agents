import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  CommandEnvelope,
  ConversationSnapshot,
  ConversationTopicWireCandidate,
} from "@zcode/shared/zcode-protocol-v4";
import { AcpV4Bridge } from "../src/agent-runtime/acpV4Bridge.js";
import { saveAgentServerConfig } from "../src/agent-runtime/agentServersRegistry.js";
import { acpSubagentSessionId } from "../src/agent-runtime/acpSubagentRegistry.js";
import { setDataBaseDir } from "../src/paths.js";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";
import { COMPLEX_AGENT } from "./acpComplexAgentFixture.js";

async function waitFor(predicate: () => boolean, label: string, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function snapshotOf(frame: ConversationTopicWireCandidate): ConversationSnapshot | null {
  const logical = frame as {
    kind?: string;
    frame?: { payload?: { kind?: string; snapshot?: ConversationSnapshot } };
  };
  return logical.kind === "complete" && logical.frame?.payload?.kind === "snapshot"
    ? (logical.frame.payload.snapshot ?? null)
    : null;
}

let commandCounter = 0;
function envelope(
  sessionId: string,
  type: CommandEnvelope["type"],
  payload: unknown,
): CommandEnvelope {
  return {
    commandId: `command-${++commandCounter}`,
    clientId: "test-client",
    sessionId,
    type,
    payload,
    issuedAt: Date.now(),
  } as CommandEnvelope;
}

test("ACP complex behaviors round-trip through connection, coordinator and V4 bridge", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codez-acp-complex-"));
  setDataBaseDir(dir);
  const repo = new TaskIndexRepo(join(dir, "tasks.sqlite"));
  const agentFile = join(dir, "agent.mjs");
  const target = { workspacePath: dir, workspaceIdentity: "remote:host:/repo" };
  const task = { ...target, taskId: "complex-task" };
  const child = { ...target, taskId: acpSubagentSessionId(task.taskId, "task-1") };
  const frames: ConversationTopicWireCandidate[] = [];
  let bridge = new AcpV4Bridge(
    repo,
    (_target, frame) => frames.push(frame),
    () => false,
  );
  const snap = () => bridge.coordinator.snapshot(task);
  const prompt = async (text: string) => {
    await bridge.coordinator.sendPrompt({ ...task, commandId: `prompt-${++commandCounter}`, text });
  };
  const idle = (label: string) => waitFor(() => snap()?.control.phase !== "running", label);
  try {
    await writeFile(agentFile, COMPLEX_AGENT);
    await saveAgentServerConfig({
      id: "complex-agent",
      name: "Complex Agent",
      command: process.execPath,
      args: [agentFile],
    });
    await bridge.coordinator.create({
      ...task,
      commandId: task.taskId,
      runtimeId: "complex-agent",
    });

    // 能力声明：subagents、AIR nativeSubagentSessions/asyncTasks、elicitation.form。
    await prompt("caps");
    await idle("caps turn");
    const capsText = snap()?.rows.window.find((row) => row.kind === "assistantText");
    const caps = JSON.parse(capsText?.kind === "assistantText" ? capsText.text : "{}");
    assert.deepEqual(caps.subagents, {});
    assert.deepEqual(caps.elicitation, { form: {} });
    assert.deepEqual(caps._meta.jetbrains.air.capabilities, [
      "nativeSubagentSessions",
      "asyncTasks",
    ]);

    // 子智能体：spawn → 子工具 → 子权限（经 V4 resolveInteraction）→ 终态。
    await prompt("subagent");
    // SDK 的 request 处理链比 notification 短：权限可能先于 spawn 被投影应用，origin 在 spawn 应用后的
    // 下一帧解析出来（AcpInteractionBook 在生成 snapshot 时按登记表解析），这里等待该最终态。
    await waitFor(
      () =>
        snap()?.pendingInteractions.some(
          (item) => item.payload.kind === "permission" && item.payload.origin !== undefined,
        ) === true,
      "child permission with origin",
    );
    const pending = snap()!.pendingInteractions[0]!;
    assert.equal(
      pending.payload.kind === "permission" && pending.payload.origin?.childSessionId,
      child.taskId,
    );
    // 手机/桌面在子会话运行中打开只读子会话：初始帧与恢复帧都是完整 snapshot。
    const subscribed = await bridge.subscribe(child);
    assert.equal(snapshotOf(frames.at(-1)!)?.sessionId, child.taskId);
    assert.equal((frames.at(-1) as { deliveryKind?: string }).deliveryKind, "initial");
    assert.equal(bridge.resync(subscribed.ack.subscriptionId)?.ack.mode, "snapshot");
    assert.equal((frames.at(-1) as { deliveryKind?: string }).deliveryKind, "recovery");
    assert.equal(
      (await bridge.command(target, envelope(child.taskId, "sendText", { text: "hi" }))).reasonCode,
      "acpSubagentReadOnly",
    );
    const framesBefore = frames.length;
    const resolved = await bridge.command(
      target,
      envelope(task.taskId, "resolveInteraction", {
        interactionId: pending.interactionId,
        answer: { optionId: "allow" },
      }),
    );
    assert.equal(resolved.status, "accepted");
    await idle("subagent turn");
    // 子会话变化推送到虚拟订阅（revision 去重，只推变化）。
    assert.ok(
      frames
        .slice(framesBefore)
        .some((frame) => (frame as { topic?: string }).topic === `conversation/${child.taskId}`),
    );
    const rootRows = snap()!.rows.window;
    assert.ok(
      rootRows.some((row) => row.kind === "assistantText" && row.text === "ghost:cancelled"),
    );
    assert.ok(!rootRows.some((row) => row.kind === "assistantText" && row.text === "ghost text"));
    const subagentRow = rootRows.find((row) => row.kind === "subagent");
    assert.equal(subagentRow?.kind === "subagent" && subagentRow.status, "success");
    assert.equal(
      subagentRow?.kind === "subagent" && subagentRow.summaryText,
      "child:selected:allow",
    );
    const childRows = bridge.coordinator.rowsRange({ ...child, limit: 20 }).rows;
    assert.ok(childRows.some((row) => row.kind === "toolCall" && row.toolName === "Grep"));
    const listed = await bridge.listSubagents({ ...task, endedLimit: 10 });
    assert.equal(listed.ended.items[0]?.childSessionId, child.taskId);
    assert.equal(listed.ended.items[0]?.status, "success");

    // 后台 Bash：AIR 标记 + async_task_*；停止走 _session/async_task/stop，回合外续写进展示轮。
    await prompt("async");
    await idle("async turn");
    let works = snap()!.backgroundWorks;
    assert.deepEqual(
      works.map((work) => [work.workId, work.status, work.cancellable]),
      [
        ["bg-1", "running", true],
        ["bg-2", "running", true],
      ],
    );
    const rejected = await bridge.command(
      target,
      envelope(task.taskId, "cancelBackgroundWork", { workId: "bg-2" }),
    );
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.reasonCode, "fault.command.backgroundWorkCancelRejected.not_running");
    const stopped = await bridge.command(
      target,
      envelope(task.taskId, "cancelBackgroundWork", { workId: "bg-1" }),
    );
    assert.equal(stopped.status, "accepted");
    await waitFor(
      () => snap()!.backgroundWorks.find((work) => work.workId === "bg-1")?.status === "cancelled",
      "stopped state",
    );
    await waitFor(
      () =>
        snap()!.rows.window.some(
          (row) => row.kind === "assistantText" && row.text === "Background sleep was stopped.",
        ),
      "out-of-turn follow-up",
    );
    const display = snap()!
      .rows.window.filter((row) => row.kind === "turnHeader")
      .at(-1);
    assert.equal(display?.kind === "turnHeader" && display.origin, "backgroundResult");
    assert.equal(snap()!.control.phase, "completedSuccess");

    // 表单问答：AskUserQuestion 形状 → userInput questions → 按原 schema 键回写。
    await prompt("ask");
    await waitFor(() => (snap()?.pendingInteractions.length ?? 0) > 0, "elicitation");
    const question = snap()!.pendingInteractions[0]!;
    assert.equal(question.kind, "userInput");
    const payload = question.payload.kind === "userInput" ? question.payload : undefined;
    assert.deepEqual(
      payload?.questions?.map((item) => [item.header, item.question, item.multiSelect ?? false]),
      [
        ["Cache", "Which cache?", false],
        ["Checks", "Which checks?", true],
      ],
    );
    await bridge.command(
      target,
      envelope(task.taskId, "resolveInteraction", {
        interactionId: question.interactionId,
        answer: {
          action: "accept",
          content: { answer_0: "Redis", answer_1: ["lint", "e2e only"] },
        },
      }),
    );
    await idle("ask turn");
    const echoed = snap()!.rows.window.findLast((row) => row.kind === "assistantText");
    assert.deepEqual(
      JSON.parse(echoed?.kind === "assistantText" ? echoed.text.replace("elicitation:", "") : "{}"),
      {
        action: "accept",
        content: { question_0: "Redis", question_1: ["lint"], question_1_custom: "e2e only" },
      },
    );

    // 停止时未应答的表单以 cancel 收口，交互消失。
    await prompt("ask");
    await waitFor(() => (snap()?.pendingInteractions.length ?? 0) > 0, "second elicitation");
    await bridge.command(target, envelope(task.taskId, "stop", {}));
    await idle("cancelled ask turn");
    assert.equal(snap()!.pendingInteractions.length, 0);
    const cancelledEcho = snap()!.rows.window.findLast((row) => row.kind === "assistantText");
    assert.equal(
      cancelledEcho?.kind === "assistantText" && cancelledEcho.text,
      'elicitation:{"action":"cancel"}',
    );

    // 重启恢复：子会话归属来自转录 sessionId；旧进程的后台任务标为失败。
    await bridge.dispose();
    bridge = new AcpV4Bridge(
      repo,
      (_target, frame) => frames.push(frame),
      () => false,
    );
    const restoredChild = await bridge.coordinator.load(child);
    assert.ok(
      restoredChild.rows.window.some((row) => row.kind === "toolCall" && row.toolName === "Grep"),
    );
    assert.ok(
      restoredChild.rows.window.some(
        (row) => row.kind === "assistantText" && row.text === "child:selected:allow",
      ),
    );
    works = snap()!.backgroundWorks;
    assert.deepEqual(
      works.map((work) => [work.workId, work.status]),
      [
        ["bg-1", "cancelled"],
        ["bg-2", "failed"],
      ],
    );
    assert.ok(
      !snap()!.rows.window.some((row) => row.kind === "toolCall" && row.toolName === "Grep"),
    );
  } finally {
    await bridge.dispose();
    repo.close();
    setDataBaseDir(null);
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
