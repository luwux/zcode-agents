/**
 * Offline e2e for ACP complex behaviors with the real pinned Claude Code CLI + claude-agent-acp:
 * native subagent sessions (subagent_* wire through the SDK 1.4 carrier) and AskUserQuestion via
 * form elicitation. Run through `node scripts/acp-replay/run-replay-e2e.mjs` (loopback-only).
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { AcpRuntimeCoordinator } from "../../src/agent-runtime/acpRuntimeCoordinator.js";
import { saveAgentConfig } from "../../src/agent-runtime/builtin/agentConfigRegistry.js";
import { saveBuiltinConfigApiKey } from "../../src/agent-runtime/builtin/builtinRuntimeLaunch.js";
import { setDataBaseDir } from "../../src/paths.js";
import { TaskIndexRepo } from "../../src/session/taskIndexRepo.js";
import { makeWorkspace, replaySkip, startProxy, waitFor } from "./replayHarness.js";

interface ClaudeRun {
  coordinator: AcpRuntimeCoordinator;
  target: { workspacePath: string };
  taskId: string;
  permissions: RequestPermissionRequest[];
  proxyLog: string;
  reopen: () => AcpRuntimeCoordinator;
}

async function withClaude(fixture: string, body: (run: ClaudeRun) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "codez-replay-complex-"));
  setDataBaseDir(join(root, "data"));
  const workspace = await makeWorkspace(root);
  const proxyLog = join(root, "proxy.jsonl");
  const { child: proxy, url } = await startProxy(fixture, workspace, proxyLog);
  const repo = new TaskIndexRepo(join(root, "tasks.sqlite"));
  const permissions: RequestPermissionRequest[] = [];
  const coordinators: AcpRuntimeCoordinator[] = [];
  const make = () => {
    const coordinator: AcpRuntimeCoordinator = new AcpRuntimeCoordinator(repo, {
      onPermission: (target, request) => {
        permissions.push(request);
        const option = request.options.find((candidate) => candidate.kind === "allow_once");
        assert.ok(option, "permission request offers allow_once");
        setTimeout(
          () => coordinator.respondPermission({ ...target, optionId: option.optionId }),
          50,
        );
      },
    });
    coordinators.push(coordinator);
    return coordinator;
  };
  try {
    await saveAgentConfig({
      id: "claude-complex",
      name: "Claude complex replay",
      runtime: "claude-code",
      auth: "byok",
      provider: { preset: "custom", baseUrl: url, model: "claude-opus-5" },
    });
    await saveBuiltinConfigApiKey("claude-complex", "replay-dummy-key");
    const coordinator = make();
    const target = { workspacePath: workspace };
    const meta = await coordinator.create({
      ...target,
      commandId: "claude-complex-task",
      runtimeId: "claude-complex",
      modeId: "default",
    });
    await body({ coordinator, target, taskId: meta.taskId, permissions, proxyLog, reopen: make });
  } finally {
    for (const coordinator of coordinators) await coordinator.closeAll();
    proxy.kill();
    repo.close();
    setDataBaseDir(null);
    if (!process.env.CODEZ_E2E_KEEP)
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

async function runPrompt(run: ClaudeRun, text: string): Promise<void> {
  await run.coordinator.sendPrompt({ ...run.target, taskId: run.taskId, commandId: text, text });
  await waitFor(
    () =>
      run.coordinator.snapshot({ ...run.target, taskId: run.taskId })?.control.phase !== "running",
    180_000,
    "turn completion",
  );
}

test(
  "claude-code native subagent becomes a paired Agent row and a read-only child",
  {
    skip: replaySkip,
    timeout: 240_000,
  },
  async () => {
    await withClaude("claude-code-subagent.json", async (run) => {
      await runPrompt(run, "Delegate counting the files to a subagent.");
      const snapshot = run.coordinator.snapshot({ ...run.target, taskId: run.taskId })!;
      assert.notEqual(snapshot.control.phase, "error", JSON.stringify(snapshot.control.lastError));
      const rows = run.coordinator.rowsRange({
        ...run.target,
        taskId: run.taskId,
        limit: 1_000,
      }).rows;
      const subagent = rows.find(
        (row): row is Extract<ConversationRow, { kind: "subagent" }> => row.kind === "subagent",
      );
      assert.ok(subagent, `subagent row: ${JSON.stringify(rows.map((row) => row.kind))}`);
      assert.equal(subagent.status, "success");
      const host = rows.find(
        (row) => row.kind === "toolCall" && row.toolCallId === subagent.parentToolCallId,
      );
      assert.equal(host?.kind === "toolCall" && host.toolName, "Agent");
      assert.equal(host?.kind === "toolCall" && host.status, "success");
      assert.equal(host?.turnId, subagent.turnId);
      // 适配器的异步启动回执不能再生成一条失败的 Agent 行（只有合成的宿主行）。
      assert.equal(
        rows.filter((row) => row.kind === "toolCall" && row.toolName === "Agent").length,
        1,
      );
      // 子会话的 Bash 与回复只出现在只读子会话中。
      assert.ok(!rows.some((row) => row.kind === "toolCall" && row.toolName === "Bash"));
      const childId = subagent.childSessionId!;
      const child = run.coordinator.snapshot({ ...run.target, taskId: childId })!;
      assert.equal(child.inputRouting.mode, "reject");
      const childRows = child.rows.window;
      assert.ok(childRows.some((row) => row.kind === "toolCall" && row.toolName === "Bash"));
      // 父续写与子回复的先后由异步调度决定；摘要必须等于子会话自己的最后一段回复。
      const childText = childRows.filter((row) => row.kind === "assistantText").at(-1);
      assert.ok(childText?.kind === "assistantText" && childText.text.length > 0);
      assert.equal(subagent.summaryText, childText.kind === "assistantText" ? childText.text : "");
      const proxyEntries = (await readFile(run.proxyLog, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { exhausted: boolean });
      assert.ok(!proxyEntries.some((entry) => entry.exhausted), "CLI never ran past the fixture");
      assert.equal(snapshot.subagents?.endedTotal, 1);
      // 权限若由子会话发起，必须经已宣告的子 sessionId 到达并被接受。
      for (const request of run.permissions) assert.ok(request.sessionId);
      // 重启恢复：子会话归属来自转录 sessionId。
      await run.coordinator.closeAll();
      const reopened = run.reopen();
      await reopened.load({ ...run.target, taskId: run.taskId });
      const restored = reopened.snapshot({ ...run.target, taskId: childId });
      assert.ok(
        restored?.rows.window.some((row) => row.kind === "toolCall" && row.toolName === "Bash"),
      );
    });
  },
);

test(
  "claude-code AskUserQuestion is answered through the ACP form elicitation",
  {
    skip: replaySkip,
    timeout: 240_000,
  },
  async () => {
    await withClaude("claude-code-ask.json", async (run) => {
      const task = { ...run.target, taskId: run.taskId };
      await run.coordinator.sendPrompt({
        ...task,
        commandId: "ask",
        text: "Ask me which cache to use.",
      });
      await waitFor(
        () =>
          run.coordinator
            .snapshot(task)
            ?.pendingInteractions.some((item) => item.kind === "userInput") === true ||
          run.coordinator.snapshot(task)?.control.phase !== "running",
        180_000,
        "elicitation",
      );
      const pending = run.coordinator
        .snapshot(task)!
        .pendingInteractions.find((item) => item.kind === "userInput");
      assert.ok(pending, JSON.stringify(run.coordinator.snapshot(task)?.rows.window.slice(-4)));
      const payload = pending.payload.kind === "userInput" ? pending.payload : undefined;
      assert.equal(payload?.questions?.[0]?.question, "Which cache should the service use?");
      assert.deepEqual(
        payload?.questions?.[0]?.options.map((option) => option.value),
        ["Redis", "Memcached"],
      );
      assert.ok(
        run.coordinator.respondInteraction({
          ...task,
          interactionId: pending.interactionId,
          answer: { action: "accept", content: { answer_0: "Redis" } },
        }),
      );
      await waitFor(
        () => run.coordinator.snapshot(task)?.control.phase !== "running",
        180_000,
        "turn completion",
      );
      const snapshot = run.coordinator.snapshot(task)!;
      assert.notEqual(snapshot.control.phase, "error", JSON.stringify(snapshot.control.lastError));
      const ask = snapshot.rows.window.find(
        (row) => row.kind === "toolCall" && row.toolName === "AskUserQuestion",
      );
      assert.equal(ask?.kind === "toolCall" && ask.status, "success");
      const proxy = await readFile(run.proxyLog, "utf8");
      assert.ok(proxy.includes("tool_result"), "the answered tool result reached the model");
    });
  },
);

test(
  "claude-code background Bash is projected through AIR async tasks",
  { skip: replaySkip, timeout: 240_000 },
  async () => {
    await withClaude("claude-code-background.json", async (run) => {
      const task = { ...run.target, taskId: run.taskId };
      await run.coordinator.sendPrompt({
        ...task,
        commandId: "bg",
        text: "Run the slow check in the background.",
      });
      let sawRunningWork = false;
      await waitFor(
        () => {
          const snapshot = run.coordinator.snapshot(task);
          if (snapshot?.backgroundWorks.some((work) => work.status === "running"))
            sawRunningWork = true;
          return snapshot?.control.phase !== "running";
        },
        180_000,
        "turn completion",
      );
      assert.ok(sawRunningWork, "async_task_spawned surfaced a running background work");
      const bash = run.coordinator
        .snapshot(task)!
        .rows.window.find((row) => row.kind === "toolCall" && row.toolName === "Bash");
      assert.equal(bash?.kind === "toolCall" && bash.backgrounded, true);
      const workId = bash?.kind === "toolCall" ? bash.workId : undefined;
      assert.ok(workId, "Bash row is linked to its async task");
      // 回合结束后后台任务完成（stopped 随后被 completed 更正），Claude 自主续写：回合外内容进展示轮。
      await waitFor(
        () =>
          run.coordinator
            .snapshot(task)
            ?.rows.window.some(
              (row) =>
                row.kind === "assistantText" && row.text === "The background check finished.",
            ) === true,
        60_000,
        "task-notification follow-up",
      );
      await waitFor(
        () => run.coordinator.snapshot(task)?.backgroundWorks.length === 0,
        30_000,
        "completed work leaves backgroundWorks",
      );
      const snapshot = run.coordinator.snapshot(task)!;
      const followUp = snapshot.rows.window.find(
        (row) => row.kind === "assistantText" && row.text === "The background check finished.",
      );
      const header = snapshot.rows.window.find(
        (row) => row.kind === "turnHeader" && row.turnId === followUp?.turnId,
      );
      assert.equal(header?.kind === "turnHeader" && header.origin, "backgroundResult");
      assert.deepEqual(header?.kind === "turnHeader" && header.originMeta, {
        backgroundSource: "bash",
        workId,
        title: "Slow check",
      });
      // 展示轮不改变会话 phase 与回合所有权。
      assert.equal(snapshot.control.phase, "completedSuccess");
      assert.equal(snapshot.inputRouting.mode, "startNow");
    });
  },
);

test(
  "claude-code background Bash stops through _session/async_task/stop",
  { skip: replaySkip, timeout: 240_000 },
  async () => {
    await withClaude("claude-code-background-stop.json", async (run) => {
      const task = { ...run.target, taskId: run.taskId };
      await runPrompt(run, "Start the long watcher in the background.");
      await waitFor(
        () =>
          run.coordinator
            .snapshot(task)
            ?.backgroundWorks.some((work) => work.status === "running") === true,
        30_000,
        "running background work",
      );
      const work = run.coordinator.snapshot(task)!.backgroundWorks[0]!;
      assert.equal(work.cancellable, true);
      assert.deepEqual(
        await run.coordinator.cancelBackgroundWork({ ...task, workId: work.workId }),
        {
          accepted: true,
        },
      );
      await waitFor(
        () =>
          run.coordinator
            .snapshot(task)
            ?.backgroundWorks.find((item) => item.workId === work.workId)?.status === "cancelled",
        30_000,
        "stopped state",
      );
      // 已停止的任务不能再次停止：以明确原因拒绝，而不是伪造成功。
      assert.deepEqual(
        await run.coordinator.cancelBackgroundWork({ ...task, workId: work.workId }),
        {
          accepted: false,
          reason: "not_running",
        },
      );
    });
  },
);
