/**
 * Offline e2e: real Claude Code / Codex / Pi CLIs (pinned, installed by the production installer)
 * driven through CodeZ's AcpRuntimeCoordinator against the local replay proxy.
 *
 * Covers multi-turn replays and a permission-mode matrix per runtime: bypass / full-access (no
 * prompts), accept-edits (edits auto-approved, commands judged) and ask modes, where the test acts
 * as the user and judges every prompt through the same respondPermission path the UI uses.
 *
 * Run via `node scripts/acp-replay/run-replay-e2e.mjs` (installs runtimes, then runs this file in a
 * loopback-only network namespace). Skips unless CODEZ_E2E_REPLAY=1 and CODEZ_ACP_RUNTIMES_DIR is set.
 */
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { AcpRuntimeCoordinator } from "../../src/agent-runtime/acpRuntimeCoordinator.js";
import { saveAgentConfig } from "../../src/agent-runtime/builtin/agentConfigRegistry.js";
import { saveBuiltinConfigApiKey } from "../../src/agent-runtime/builtin/builtinRuntimeLaunch.js";
import type { AgentProviderSettings } from "../../src/agent-runtime/builtin/builtinProviderPresets.js";
import type { BuiltinAcpRuntime } from "../../src/agent-runtime/builtin/builtinRuntimeCatalog.js";
import { setDataBaseDir } from "../../src/paths.js";
import { TaskIndexRepo } from "../../src/session/taskIndexRepo.js";
import {
  responseFor,
  ruleJudge,
  sandboxEnvForBypass,
  type JudgeDecision,
} from "./permissionJudge.js";
import {
  makeWorkspace,
  replayDir,
  replaySkip as skip,
  startProxy,
  waitFor,
} from "./replayHarness.js";

const artifacts = process.env.CODEZ_E2E_ARTIFACTS;

interface Fixture {
  model: string;
  turns: Array<{ user: { text: string }; events: Array<{ kind: string; name?: string }> }>;
}

interface Case {
  name: string;
  runtime: BuiltinAcpRuntime;
  fixture: string;
  provider: (url: string, model: string) => AgentProviderSettings;
  /** Permission mode requested at creation (must be offered by the agent). */
  modeId?: string;
  /** Non-secret config env (IS_SANDBOX lets Claude offer bypass when running as root). */
  configEnv?: Record<string, string>;
  /** Inclusive bounds on permission prompts the test "user" answers. */
  permissions: { min: number; max: number };
  /** Files that must / must not exist in the workspace afterwards. */
  files?: { present: string[]; absent: string[] };
}

const claudeProvider = (url: string, model: string): AgentProviderSettings => ({
  preset: "custom",
  baseUrl: url,
  model,
});
const codexProvider = (url: string, model: string): AgentProviderSettings => ({
  preset: "custom",
  baseUrl: `${url}/v1`,
  model,
  providerId: "replay",
});
const piProvider = (url: string, model: string): AgentProviderSettings => ({
  preset: "custom",
  baseUrl: url,
  api: "anthropic-messages",
  model,
});
const ALL_FILES = {
  present: ["judge-edit.txt", "judge-allowed.txt", "judge-denied.txt"],
  absent: [],
};
const JUDGED_FILES = {
  present: ["judge-edit.txt", "judge-allowed.txt"],
  absent: ["judge-denied.txt"],
};
const ANY = { min: 0, max: Number.POSITIVE_INFINITY };

const CASES: Case[] = [
  // 多轮回放（各 Runtime 默认模式）：只读命令；出现的任何提示由测试按规则裁决。
  {
    name: "claude-code multi-turn replay",
    runtime: "claude-code",
    fixture: "claude-code.json",
    provider: claudeProvider,
    permissions: ANY,
  },
  {
    name: "codex multi-turn replay",
    runtime: "codex",
    fixture: "codex.json",
    provider: codexProvider,
    permissions: ANY,
  },
  {
    name: "pi multi-turn replay",
    runtime: "pi",
    fixture: "pi.json",
    provider: piProvider,
    permissions: { min: 0, max: 0 },
  },
  // 权限模式矩阵：同一组「编辑 + 允许的命令 + 裁决拒绝的命令」。
  {
    name: "claude-code bypassPermissions: no prompts, everything runs",
    runtime: "claude-code",
    fixture: "claude-code-modes.json",
    provider: claudeProvider,
    modeId: "bypassPermissions",
    configEnv: sandboxEnvForBypass(),
    permissions: { min: 0, max: 0 },
    files: ALL_FILES,
  },
  {
    name: "claude-code acceptEdits: edit auto-approved, commands judged",
    runtime: "claude-code",
    fixture: "claude-code-modes.json",
    provider: claudeProvider,
    modeId: "acceptEdits",
    permissions: { min: 2, max: 2 },
    files: JUDGED_FILES,
  },
  {
    name: "claude-code default: edit and commands judged, denied command blocked",
    runtime: "claude-code",
    fixture: "claude-code-modes.json",
    provider: claudeProvider,
    modeId: "default",
    permissions: { min: 3, max: 3 },
    files: JUDGED_FILES,
  },
  {
    name: "codex agent-full-access: no prompts, everything runs",
    runtime: "codex",
    fixture: "codex-modes-full-access.json",
    provider: codexProvider,
    modeId: "agent-full-access",
    permissions: { min: 0, max: 0 },
    files: ALL_FILES,
  },
  {
    name: "codex read-only (ask): escalations judged, denied command blocked",
    runtime: "codex",
    fixture: "codex-modes.json",
    provider: codexProvider,
    modeId: "read-only",
    permissions: { min: 3, max: 3 },
    files: JUDGED_FILES,
  },
  {
    name: "pi (no permission system): everything runs without prompts",
    runtime: "pi",
    fixture: "pi-modes.json",
    provider: piProvider,
    permissions: { min: 0, max: 0 },
    files: ALL_FILES,
  },
];

// Codex 默认 "agent" 模式由 Guardian 模型代为审批；回放代理无法扮演该审查模型，由 live 测试覆盖。
test(
  "codex agent (Guardian auto-review) mode",
  { skip: "Guardian review needs a real model; covered by the live tests (test/e2e/live)" },
  () => {},
);

for (const testCase of CASES) {
  test(testCase.name, { skip, timeout: 240_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), `codez-replay-${testCase.runtime}-`));
    setDataBaseDir(join(root, "data"));
    const workspace = await makeWorkspace(root);
    const fixture = JSON.parse(
      await readFile(join(replayDir, "fixtures", testCase.fixture), "utf8"),
    ) as Fixture;
    const proxyLog = join(root, "proxy.jsonl");
    const { child: proxy, url } = await startProxy(testCase.fixture, workspace, proxyLog);
    const repo = new TaskIndexRepo(join(root, "tasks.sqlite"));
    const permissionRequests: RequestPermissionRequest[] = [];
    const decisions: Array<{ title: string | null | undefined } & JudgeDecision> = [];
    let coordinator: AcpRuntimeCoordinator | null = null;
    const configId = `${testCase.runtime}-replay`;
    try {
      await saveAgentConfig({
        id: configId,
        name: `${testCase.runtime} replay`,
        runtime: testCase.runtime,
        auth: "byok",
        provider: testCase.provider(url, fixture.model),
        ...(testCase.configEnv && Object.keys(testCase.configEnv).length
          ? { env: testCase.configEnv }
          : {}),
      });
      await saveBuiltinConfigApiKey(configId, "replay-dummy-key");
      coordinator = new AcpRuntimeCoordinator(repo, {
        onPermission: (target, request) => {
          permissionRequests.push(request);
          // 测试扮演用户：经与 UI 相同的 respondPermission 路径，按规则裁决（允许/拒绝）。
          const decision = ruleJudge(request, workspace);
          decisions.push({ title: request.toolCall.title, ...decision });
          const response = responseFor(request, decision);
          setTimeout(() => {
            assert.ok(
              coordinator!.respondPermission({
                ...target,
                ...(response.outcome.outcome === "selected"
                  ? { optionId: response.outcome.optionId }
                  : {}),
              }),
              "permission was pending",
            );
          }, 50);
        },
      });
      const target = { workspacePath: workspace };
      const preview = await coordinator.discoverConfig({ ...target, runtimeId: configId });
      const modes = preview.modes?.map((mode) => mode.id) ?? [];
      if (testCase.modeId)
        assert.ok(
          modes.includes(testCase.modeId),
          `mode ${testCase.modeId} offered: ${modes.join(",")}`,
        );
      const meta = await coordinator.create({
        ...target,
        commandId: `${testCase.runtime}-task`,
        runtimeId: configId,
        ...(testCase.modeId ? { modeId: testCase.modeId } : {}),
      });
      const confirmedMode = coordinator.snapshot({ ...target, taskId: meta.taskId })?.config
        .acpModeId;
      if (testCase.modeId) assert.equal(confirmedMode, testCase.modeId, "agent confirmed the mode");

      // codex-acp 把 write_stdin（轮询已有 exec 会话）并入原 exec 行，不产生新的工具行。
      const expectedTools = fixture.turns.map(
        (turn) =>
          turn.events.filter((event) => event.kind === "tool_call" && event.name !== "write_stdin")
            .length,
      );
      for (const [index, turn] of fixture.turns.entries()) {
        const accepted = await coordinator.sendPrompt({
          ...target,
          taskId: meta.taskId,
          commandId: `prompt-${index}`,
          text: turn.user.text,
        });
        assert.equal(accepted, "accepted");
        await waitFor(
          () =>
            coordinator!.snapshot({ ...target, taskId: meta.taskId })?.control.phase !== "running",
          180_000,
          `turn ${index} completion`,
        );
      }
      const snapshot = coordinator.snapshot({ ...target, taskId: meta.taskId })!;
      const { rows } = coordinator.rowsRange({ ...target, taskId: meta.taskId, limit: 10_000 });
      if (artifacts) {
        await mkdir(artifacts, { recursive: true });
        const base = `${testCase.runtime}-${testCase.fixture}-${testCase.modeId ?? "default"}`;
        await writeFile(
          join(artifacts, `${base}.rows.json`),
          JSON.stringify(
            { phase: snapshot.control.phase, mode: confirmedMode, decisions, rows },
            null,
            2,
          ),
        );
        await writeFile(
          join(artifacts, `${base}.proxy.jsonl`),
          await readFile(proxyLog, "utf8").catch(() => ""),
        );
      }
      assert.notEqual(snapshot.control.phase, "error", JSON.stringify(snapshot.control));

      const userRows = rows.filter((row) => row.kind === "userInput");
      assert.equal(userRows.length, fixture.turns.length, "one user row per turn");
      const toolRows = rows.filter((row) => row.kind === "toolCall") as Array<{
        status: string;
        toolName: string;
      }>;
      const totalTools = expectedTools.reduce((sum, count) => sum + count, 0);
      assert.ok(
        toolRows.length >= totalTools,
        `expected >= ${totalTools} tool rows, got ${toolRows.length}`,
      );
      assert.ok(
        toolRows.every((row) => row.status !== "running" && row.status !== "inputStreaming"),
        "all tool calls settled",
      );
      assert.ok(
        rows.some((row) => row.kind === "assistantText"),
        "assistant text streamed",
      );

      const proxyEntries = (await readFile(proxyLog, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as { main: boolean; exhausted: boolean; api: string; turn?: number },
        );
      assert.ok(
        !proxyEntries.some((entry) => entry.api === "unknown" || entry.api === "error"),
        "proxy saw only supported requests",
      );
      assert.ok(!proxyEntries.some((entry) => entry.exhausted), "CLI never ran past the fixture");
      assert.equal(
        new Set(proxyEntries.filter((entry) => entry.main).map((entry) => entry.turn)).size,
        fixture.turns.length,
      );

      assert.ok(
        permissionRequests.length >= testCase.permissions.min &&
          permissionRequests.length <= testCase.permissions.max,
        `permission prompts ${permissionRequests.length} not in [${testCase.permissions.min}, ${testCase.permissions.max}]: ${JSON.stringify(decisions)}`,
      );
      for (const file of testCase.files?.present ?? [])
        await access(join(workspace, file)).catch(() =>
          assert.fail(`${file} should exist: ${JSON.stringify(decisions)}`),
        );
      for (const file of testCase.files?.absent ?? [])
        await access(join(workspace, file)).then(
          () => assert.fail(`${file} must not exist: the judge denied it`),
          () => {},
        );
    } finally {
      await coordinator?.closeAll();
      proxy.kill();
      setDataBaseDir(null);
      if (!process.env.CODEZ_E2E_KEEP) await rm(root, { recursive: true, force: true });
    }
  });
}
