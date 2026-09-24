/**
 * Live BYOK smoke test: each built-in runtime completes one small task through CodeZ's ACP backend
 * against OpenRouter (`xiaomi/mimo-v2.6-flash`). Opt-in: skips unless OPENROUTER_API_KEY is set.
 * The key is only written to the encrypted credential store of a throwaway data dir and injected
 * into the child env at spawn; it is never printed.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { AcpRuntimeCoordinator } from "../../src/agent-runtime/acpRuntimeCoordinator.js";
import { saveAgentConfig } from "../../src/agent-runtime/builtin/agentConfigRegistry.js";
import { saveBuiltinConfigApiKey } from "../../src/agent-runtime/builtin/builtinRuntimeLaunch.js";
import type { BuiltinAcpRuntime } from "../../src/agent-runtime/builtin/builtinRuntimeCatalog.js";
import { setDataBaseDir } from "../../src/paths.js";
import { TaskIndexRepo } from "../../src/session/taskIndexRepo.js";

const MODEL = process.env.CODEZ_LIVE_MODEL ?? "xiaomi/mimo-v2.6-flash";
const key = process.env.OPENROUTER_API_KEY?.trim();
const skip = key ? false : "OPENROUTER_API_KEY is not set (live tests are opt-in)";
const artifacts = process.env.CODEZ_E2E_ARTIFACTS;
const MAGIC = "PELICAN-4721";
const PROMPT =
  "Use your tools: first read README.md, then run the shell command `ls` in the workspace. " +
  "Finally reply with one short line that contains the magic word written in README.md.";

const runtimes: Array<{ runtime: BuiltinAcpRuntime; modeId?: string }> = [
  { runtime: "claude-code", modeId: "default" },
  // Codex 默认 "agent" 模式由 Guardian 模型代审批（额外计费）；"read-only" 由用户（此处测试代答）审批。
  { runtime: "codex", modeId: "read-only" },
  { runtime: "pi" },
];

async function waitFor(predicate: () => boolean, ms: number, label: string) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

for (const { runtime, modeId } of runtimes) {
  test(`live OpenRouter BYOK: ${runtime}`, { skip, timeout: 300_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), `codez-live-${runtime}-`));
    setDataBaseDir(join(root, "data"));
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(
      join(workspace, "README.md"),
      `# Live smoke workspace\n\nThe magic word is ${MAGIC}.\n`,
    );
    execFileSync("git", ["init", "-q"], { cwd: workspace });
    const repo = new TaskIndexRepo(join(root, "tasks.sqlite"));
    const permissions: RequestPermissionRequest[] = [];
    let coordinator: AcpRuntimeCoordinator | null = null;
    const configId = `${runtime}-openrouter`;
    try {
      await saveAgentConfig({
        id: configId,
        name: `${runtime} via OpenRouter`,
        runtime,
        auth: "byok",
        provider: { preset: "openrouter", model: MODEL },
      });
      await saveBuiltinConfigApiKey(configId, key!);
      coordinator = new AcpRuntimeCoordinator(repo, {
        onPermission: (target, request) => {
          permissions.push(request);
          const option =
            request.options.find((candidate) => candidate.kind === "allow_once") ??
            request.options.find((candidate) => candidate.kind.startsWith("allow"));
          if (option)
            setTimeout(
              () => coordinator!.respondPermission({ ...target, optionId: option.optionId }),
              20,
            );
        },
      });
      const target = { workspacePath: workspace };
      const preview = await coordinator.discoverConfig({ ...target, runtimeId: configId });
      const modes = preview.modes?.map((mode) => mode.id) ?? [];
      const meta = await coordinator.create({
        ...target,
        commandId: `${runtime}-live`,
        runtimeId: configId,
        ...(modeId && modes.includes(modeId) ? { modeId } : {}),
      });
      await coordinator.sendPrompt({
        ...target,
        taskId: meta.taskId,
        commandId: "live-1",
        text: PROMPT,
      });
      await waitFor(
        () =>
          coordinator!.snapshot({ ...target, taskId: meta.taskId })?.control.phase !== "running",
        240_000,
        "live turn",
      );
      const snapshot = coordinator.snapshot({ ...target, taskId: meta.taskId })!;
      const { rows } = coordinator.rowsRange({ ...target, taskId: meta.taskId, limit: 10_000 });
      const answer = rows
        .filter((row) => row.kind === "assistantText")
        .map((row) => (row as { text: string }).text)
        .join("\n");
      const tools = rows.filter((row) => row.kind === "toolCall") as Array<{
        toolName: string;
        status: string;
      }>;
      if (artifacts) {
        await mkdir(artifacts, { recursive: true });
        await writeFile(
          join(artifacts, `live-${runtime}.json`),
          JSON.stringify(
            {
              runtime,
              model: MODEL,
              phase: snapshot.control.phase,
              modes,
              permissions: permissions.map((request) => request.toolCall.title),
              tools: tools.map(({ toolName, status }) => ({ toolName, status })),
              answer,
            },
            null,
            2,
          ),
        );
      }
      assert.notEqual(snapshot.control.phase, "error", JSON.stringify(snapshot.control));
      assert.ok(tools.length >= 1, "the model used at least one tool");
      assert.ok(answer.includes(MAGIC), `answer contains the magic word: ${answer.slice(0, 300)}`);
      // 回归保护：密钥不得出现在投影、工具输出或配置文件中。
      assert.ok(!JSON.stringify(rows).includes(key!));
      assert.ok(
        !(
          await readFile(join(root, "data", ".codez", "v2", "agent-configs.json"), "utf8")
        ).includes(key!),
      );
    } finally {
      await coordinator?.closeAll();
      setDataBaseDir(null);
      await rm(root, { recursive: true, force: true });
    }
  });
}
