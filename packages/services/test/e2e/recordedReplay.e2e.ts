/**
 * 真实录制轨迹的离线回放：scripts/acp-replay/fixtures/recorded/ 下每个夹具都来自一次真实的 Claude Code
 * 运行（record-proxy + recording-to-fixture）。回放代理按固定 1000 token/s 输出录制的模型内容，
 * Claude Code 本身、工具执行与 CodeZ 投影都是真实的；工具结果可能与录制时不同，因此只断言回合完成、
 * 工具被执行且没有错误，不比较模型文字。
 *
 * - 子代理的请求在夹具里自成一“轮”，由 Claude Code 自己发出，测试只发送真正的用户消息；
 * - 录制时被打断的回合（最后一个事件是未返回结果的工具调用）在回放中同样于首个工具调用后取消。
 */
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AcpRuntimeCoordinator } from "../../src/agent-runtime/acpRuntimeCoordinator.js";
import { saveAgentConfig } from "../../src/agent-runtime/builtin/agentConfigRegistry.js";
import { saveBuiltinConfigApiKey } from "../../src/agent-runtime/builtin/builtinRuntimeLaunch.js";
import { setDataBaseDir } from "../../src/paths.js";
import { TaskIndexRepo } from "../../src/session/taskIndexRepo.js";
import { sandboxEnvForBypass } from "./permissionJudge.js";
import {
  makeWorkspace,
  replayDir,
  replaySkip as skip,
  startProxy,
  waitFor,
} from "./replayHarness.js";

interface RecordedEvent {
  kind: string;
  call_id?: string;
  name?: string;
  input?: Record<string, unknown>;
}
interface RecordedFixture {
  model: string;
  turns: Array<{ user: { text: string }; events: RecordedEvent[] }>;
}

const TPS = 1000;
const recordedDir = join(replayDir, "fixtures", "recorded");
const files = await readdir(recordedDir).catch(() => [] as string[]);

/** 子代理自己的首个请求：其文本是此前某个 Agent/Task 工具调用的 prompt。 */
function userTurns(fixture: RecordedFixture) {
  const delegated = new Set(
    fixture.turns
      .flatMap((turn) => turn.events)
      .filter((event) => event.kind === "tool_call" && /^(Agent|Task)$/.test(event.name ?? ""))
      .map((event) => String(event.input?.prompt ?? "")),
  );
  return fixture.turns
    .map((turn, index) => ({ turn, index }))
    .filter(({ turn }) => !delegated.has(turn.user.text));
}

/** 录制时被打断的回合：最后一个工具调用在整份夹具里都没有结果（异步子代理的结果记在后面的轮次）。 */
function interrupted(fixture: RecordedFixture, events: RecordedEvent[]): boolean {
  const last = events.findLast((event) => event.kind !== "usage" && event.kind !== "end_response");
  if (last?.kind !== "tool_call") return false;
  return !fixture.turns
    .flatMap((turn) => turn.events)
    .some((event) => event.kind === "tool_result" && event.call_id === last.call_id);
}

for (const file of files.filter((name) => name.endsWith(".json")).sort()) {
  test(
    `recorded trajectory replays at ${TPS} tok/s: ${file}`,
    { skip, timeout: 600_000 },
    async () => {
      const fixture = JSON.parse(
        await readFile(join(recordedDir, file), "utf8"),
      ) as RecordedFixture;
      const root = await mkdtemp(join(tmpdir(), "codez-recorded-"));
      setDataBaseDir(join(root, "data"));
      const workspace = await makeWorkspace(root);
      const { child: proxy, url } = await startProxy(
        `recorded/${file}`,
        workspace,
        join(root, "proxy.jsonl"),
        {
          tps: TPS,
        },
      );
      let coordinator: AcpRuntimeCoordinator | null = null;
      try {
        const configId = "claude-code-recorded";
        await saveAgentConfig({
          id: configId,
          name: "Claude Code recorded replay",
          runtime: "claude-code",
          auth: "byok",
          provider: { preset: "custom", baseUrl: url, model: fixture.model },
          env: sandboxEnvForBypass(),
        });
        await saveBuiltinConfigApiKey(configId, "replay-dummy-key");
        coordinator = new AcpRuntimeCoordinator(new TaskIndexRepo(join(root, "tasks.sqlite")), {});
        const target = { workspacePath: workspace };
        const meta = await coordinator.create({
          ...target,
          commandId: "recorded-task",
          runtimeId: configId,
          modeId: "bypassPermissions",
        });
        const task = { ...target, taskId: meta.taskId };
        const rows = () => coordinator!.rowsRange({ ...task, limit: 10_000 }).rows;
        const running = () => coordinator!.snapshot(task)?.control.phase === "running";
        for (const { turn, index } of userTurns(fixture)) {
          const before = rows().length;
          assert.equal(
            await coordinator.sendPrompt({
              ...task,
              commandId: `prompt-${index}`,
              text: turn.user.text,
            }),
            "accepted",
          );
          if (interrupted(fixture, turn.events)) {
            await waitFor(
              () =>
                rows()
                  .slice(before)
                  .some((row) => row.kind === "toolCall") || !running(),
              120_000,
              `turn ${index} tool call`,
            );
            await coordinator.cancel(task);
          }
          await waitFor(() => !running(), 300_000, `turn ${index} completion`);
          assert.notEqual(
            coordinator.snapshot(task)?.control.phase,
            "error",
            `turn ${index} errored`,
          );
        }
        const recordedTools = fixture.turns
          .flatMap((turn) => turn.events)
          .filter((e) => e.kind === "tool_call");
        const replayedTools = rows().filter((row) => row.kind === "toolCall");
        assert.ok(replayedTools.length >= 1, "tools were executed");
        console.log(
          `[recorded] ${file}: turns=${fixture.turns.length} recordedTools=${recordedTools.length} replayedToolRows=${replayedTools.length}`,
        );
      } finally {
        await coordinator?.closeAll();
        proxy.kill();
        setDataBaseDir(null);
        if (!process.env.CODEZ_KEEP_REPLAY) await rm(root, { recursive: true, force: true });
        else console.log(`[recorded] kept ${root}`);
      }
    },
  );
}
