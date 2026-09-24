/**
 * Offline e2e: real Claude Code / Codex / Pi CLIs (pinned, installed by the production installer)
 * driven through CodeZ's AcpRuntimeCoordinator against the local replay proxy.
 *
 * Run via `node scripts/acp-replay/run-replay-e2e.mjs` (installs runtimes, then runs this file in a
 * loopback-only network namespace). Skips unless CODEZ_E2E_REPLAY=1 and CODEZ_ACP_RUNTIMES_DIR is set.
 */
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { AcpRuntimeCoordinator } from "../../src/agent-runtime/acpRuntimeCoordinator.js";
import { saveAgentConfig } from "../../src/agent-runtime/builtin/agentConfigRegistry.js";
import { saveBuiltinConfigApiKey } from "../../src/agent-runtime/builtin/builtinRuntimeLaunch.js";
import type { AgentProviderSettings } from "../../src/agent-runtime/builtin/builtinProviderPresets.js";
import type { BuiltinAcpRuntime } from "../../src/agent-runtime/builtin/builtinRuntimeCatalog.js";
import { setDataBaseDir } from "../../src/paths.js";
import { TaskIndexRepo } from "../../src/session/taskIndexRepo.js";

const here = dirname(fileURLToPath(import.meta.url));
const replayDir = resolve(here, "../../../../scripts/acp-replay");
const enabled = process.env.CODEZ_E2E_REPLAY === "1" && Boolean(process.env.CODEZ_ACP_RUNTIMES_DIR);
const skip = enabled
  ? false
  : "set CODEZ_E2E_REPLAY=1 and CODEZ_ACP_RUNTIMES_DIR (use run-replay-e2e.mjs)";
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
  /** Mode requested at creation; never a bypass mode. */
  modeId?: string;
  expectPermission: boolean;
}

const CASES: Case[] = [
  {
    name: "claude-code multi-turn replay",
    runtime: "claude-code",
    fixture: "claude-code.json",
    provider: (url, model) => ({ preset: "custom", baseUrl: url, model }),
    expectPermission: false,
  },
  {
    name: "claude-code permission prompt",
    runtime: "claude-code",
    fixture: "claude-code-permission.json",
    provider: (url, model) => ({ preset: "custom", baseUrl: url, model }),
    modeId: "default",
    expectPermission: true,
  },
  {
    name: "codex multi-turn replay",
    runtime: "codex",
    fixture: "codex.json",
    provider: (url, model) => ({
      preset: "custom",
      baseUrl: `${url}/v1`,
      model,
      providerId: "replay",
    }),
    expectPermission: false,
  },
  {
    name: "codex permission prompt",
    runtime: "codex",
    fixture: "codex-permission.json",
    provider: (url, model) => ({
      preset: "custom",
      baseUrl: `${url}/v1`,
      model,
      providerId: "replay",
    }),
    // Codex 默认模式 "agent" 把审批交给 Guardian 模型审查；"read-only"（Ask for approval）才由用户审批。
    modeId: "read-only",
    expectPermission: true,
  },
  {
    name: "pi multi-turn replay",
    runtime: "pi",
    fixture: "pi.json",
    provider: (url, model) => ({
      preset: "custom",
      baseUrl: url,
      api: "anthropic-messages",
      model,
    }),
    expectPermission: false,
  },
];

async function startProxy(fixture: string, workspace: string, log: string) {
  const child = spawn(
    process.execPath,
    [
      join(replayDir, "replay-proxy.mjs"),
      "--fixture",
      join(replayDir, "fixtures", fixture),
      "--workspace",
      workspace,
      "--log",
      log,
      "--speed",
      "50",
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const line = await new Promise<string>((resolveLine, reject) => {
    const rl = createInterface({ input: child.stdout! });
    rl.once("line", resolveLine);
    child.once("exit", (code) => reject(new Error(`replay proxy exited ${code}`)));
  });
  return { child, url: (JSON.parse(line) as { url: string }).url };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, ms: number, label: string) {
  const deadline = Date.now() + ms;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function makeWorkspace(root: string): Promise<string> {
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(
    join(workspace, "README.md"),
    "# Replay workspace\n\nThrowaway repository for replay tests.\n",
  );
  await writeFile(
    join(workspace, "package.json"),
    `${JSON.stringify({ name: "replay-workspace", private: true, version: "0.0.0" }, null, 2)}\n`,
  );
  const git = (...args: string[]) => execFileSync("git", args, { cwd: workspace, stdio: "ignore" });
  git("init", "-q");
  git("-c", "user.email=replay@example.invalid", "-c", "user.name=Replay", "add", ".");
  git("-c", "user.email=replay@example.invalid", "-c", "user.name=Replay", "commit", "-qm", "init");
  return workspace;
}

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
    let coordinator: AcpRuntimeCoordinator | null = null;
    const configId = `${testCase.runtime}-replay`;
    try {
      await saveAgentConfig({
        id: configId,
        name: `${testCase.runtime} replay`,
        runtime: testCase.runtime,
        auth: "byok",
        provider: testCase.provider(url, fixture.model),
      });
      await saveBuiltinConfigApiKey(configId, "replay-dummy-key");
      coordinator = new AcpRuntimeCoordinator(repo, {
        onPermission: (target, request) => {
          permissionRequests.push(request);
          // Approve once through the same path the UI uses; never a bypass mode.
          const option =
            request.options.find((candidate) => candidate.kind === "allow_once") ??
            request.options.find((candidate) => candidate.kind.startsWith("allow"));
          assert.ok(option, "permission request offers an allow option");
          setTimeout(() => {
            assert.ok(
              coordinator!.respondPermission({ ...target, optionId: option.optionId }),
              "permission was pending",
            );
          }, 50);
        },
      });
      const target = { workspacePath: workspace };
      const preview = await coordinator.discoverConfig({ ...target, runtimeId: configId });
      const modes = preview.modes?.map((mode) => mode.id) ?? [];
      assert.ok(!(testCase.modeId ?? "").match(/bypass|yolo|full/i));
      if (testCase.modeId)
        assert.ok(
          modes.includes(testCase.modeId),
          `mode ${testCase.modeId} offered: ${modes.join(",")}`,
        );
      const meta = await coordinator.create({
        ...target,
        commandId: `${testCase.runtime}-task`,
        runtimeId: configId,
        ...(testCase.modeId && modes.includes(testCase.modeId) ? { modeId: testCase.modeId } : {}),
      });
      const confirmedMode = coordinator.snapshot({ ...target, taskId: meta.taskId })?.config
        .acpModeId;
      assert.ok(
        !String(confirmedMode ?? "").match(/bypass|yolo|full-access/i),
        `mode ${confirmedMode} must not bypass permissions`,
      );

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
        await writeFile(
          join(artifacts, `${testCase.runtime}-${testCase.fixture}.rows.json`),
          JSON.stringify({ phase: snapshot.control.phase, rows }, null, 2),
        );
        await writeFile(
          join(artifacts, `${testCase.runtime}-${testCase.fixture}.proxy.jsonl`),
          await readFile(proxyLog, "utf8").catch(() => ""),
        );
      }
      assert.notEqual(
        snapshot.control.phase,
        "error",
        JSON.stringify((snapshot as { lastError?: unknown }).lastError ?? snapshot.control),
      );

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

      if (testCase.expectPermission) {
        assert.ok(permissionRequests.length >= 1, "default mode asked for permission");
        await access(join(workspace, "replay-permission-marker.txt"));
      }
    } finally {
      await coordinator?.closeAll();
      proxy.kill();
      setDataBaseDir(null);
      if (!process.env.CODEZ_E2E_KEEP) await rm(root, { recursive: true, force: true });
    }
  });
}

export type { ChildProcess };
