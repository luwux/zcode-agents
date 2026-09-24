/**
 * Live BYOK tests: every built-in runtime runs real tasks through CodeZ's ACP backend against
 * OpenRouter with the same model for all runtimes (`xiaomi/mimo-v2.6-flash`), across permission
 * modes: bypass / full-access (no prompts), ask modes where a model judge (same model, behind a
 * rule veto) answers prompts as the user, and Codex's Guardian auto-review mode.
 *
 * Opt-in: skips unless OPENROUTER_API_KEY is set. The key is only written to the encrypted
 * credential store of a throwaway data dir and injected into the child env at spawn.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { AcpRuntimeCoordinator } from "../../src/agent-runtime/acpRuntimeCoordinator.js";
import { saveAgentConfig } from "../../src/agent-runtime/builtin/agentConfigRegistry.js";
import { saveBuiltinConfigApiKey } from "../../src/agent-runtime/builtin/builtinRuntimeLaunch.js";
import type { BuiltinAcpRuntime } from "../../src/agent-runtime/builtin/builtinRuntimeCatalog.js";
import type { AgentProviderSettings } from "../../src/agent-runtime/builtin/builtinProviderPresets.js";
import { setDataBaseDir } from "../../src/paths.js";
import { TaskIndexRepo } from "../../src/session/taskIndexRepo.js";
import {
  modelJudge,
  responseFor,
  sandboxEnvForBypass,
  type JudgeDecision,
} from "./permissionJudge.js";

const MODEL = process.env.CODEZ_LIVE_MODEL ?? "xiaomi/mimo-v2.6-flash";
const key = process.env.OPENROUTER_API_KEY?.trim();
const skip = key ? false : "OPENROUTER_API_KEY is not set (live tests are opt-in)";
const artifacts = process.env.CODEZ_E2E_ARTIFACTS;
// 录制模式：经本地透明代理转发到 OpenRouter，只记录请求/响应体（不记录任何头），用于诊断与夹具。
const record = process.env.CODEZ_LIVE_RECORD === "1";
const OPENROUTER = "https://openrouter.ai/api";
const replayDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../scripts/acp-replay",
);
const MAGIC = "PELICAN-4721";
const BASE_TASK =
  "Use your tools. 1) Read README.md. 2) Create a file named live-note.txt whose entire content is " +
  "the single word hello. 3) Run the shell command `ls`. ";
const DENIED_STEP = "4) Run the shell command `touch live-denied.txt`. ";
const ANSWER =
  "Finally reply with one short line that contains the magic word written in README.md.";

interface LiveCase {
  runtime: BuiltinAcpRuntime;
  modeId?: string;
  label: string;
  configEnv?: Record<string, string>;
  /** Ask the agent to also run a step the judge must deny. */
  deniedStep?: boolean;
  /** Minimum permission prompts expected (models may choose tools differently, so only lower bounds). */
  minPermissions: number;
  maxPermissions?: number;
  /** Use the runtime's preset directly even in record mode (covers Pi's built-in provider). */
  unrecorded?: boolean;
}

function providerFor(runtime: BuiltinAcpRuntime, baseUrl: string | null): AgentProviderSettings {
  if (!baseUrl) return { preset: "openrouter", model: MODEL };
  if (runtime === "codex")
    return { preset: "custom", baseUrl: `${baseUrl}/v1`, model: MODEL, providerId: "openrouter" };
  if (runtime === "pi")
    return { preset: "custom", baseUrl: `${baseUrl}/v1`, api: "openai-completions", model: MODEL };
  return { preset: "custom", baseUrl, model: MODEL };
}

async function startRecorder(log: string): Promise<{ child: ChildProcess; url: string }> {
  const child = spawn(
    process.execPath,
    [join(replayDir, "record-proxy.mjs"), "--upstream", OPENROUTER, "--log", log],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const line = await new Promise<string>((resolveLine, reject) => {
    createInterface({ input: child.stdout! }).once("line", resolveLine);
    child.once("exit", (code) => reject(new Error(`record proxy exited ${code}`)));
  });
  return { child, url: (JSON.parse(line) as { url: string }).url };
}

const CASES: LiveCase[] = [
  {
    runtime: "claude-code",
    modeId: "bypassPermissions",
    label: "bypass",
    configEnv: sandboxEnvForBypass(),
    minPermissions: 0,
    maxPermissions: 0,
  },
  // Claude 默认模式：写文件与命令需审批；模型裁决员放行工作区内操作并拒绝 live-denied。
  {
    runtime: "claude-code",
    modeId: "default",
    label: "ask + model judge",
    deniedStep: true,
    minPermissions: 1,
  },
  {
    runtime: "codex",
    modeId: "agent-full-access",
    label: "full access",
    minPermissions: 0,
    maxPermissions: 0,
  },
  // read-only = "Ask for approval"：工作区内写入由沙箱放行，只有越权才会询问，因此不设下界。
  { runtime: "codex", modeId: "read-only", label: "ask + model judge", minPermissions: 0 },
  // 默认 "agent" 模式：Guardian 由同一模型代审，不向用户提问。
  {
    runtime: "codex",
    modeId: "agent",
    label: "guardian auto-review",
    minPermissions: 0,
    maxPermissions: 0,
  },
  { runtime: "pi", label: "no permission system", minPermissions: 0, maxPermissions: 0 },
  {
    runtime: "pi",
    label: "built-in openrouter provider",
    minPermissions: 0,
    maxPermissions: 0,
    unrecorded: true,
  },
];

async function waitFor(predicate: () => boolean, ms: number, label: string) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

for (const liveCase of CASES) {
  const { runtime, modeId } = liveCase;
  test(
    `live ${MODEL}: ${runtime} ${modeId ?? "default"} (${liveCase.label}${liveCase.unrecorded ? "" : record ? ", recorded" : ""})`,
    { skip, timeout: 360_000 },
    async () => {
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
      const decisions: Array<{ title: string | null | undefined } & JudgeDecision> = [];
      let coordinator: AcpRuntimeCoordinator | null = null;
      let recorder: { child: ChildProcess; url: string } | null = null;
      const configId = `${runtime}-openrouter`;
      try {
        if (record && !liveCase.unrecorded)
          recorder = await startRecorder(
            join(artifacts ?? root, `record-${runtime}-${modeId ?? "default"}.jsonl`),
          );
        await saveAgentConfig({
          id: configId,
          name: `${runtime} via OpenRouter`,
          runtime,
          auth: "byok",
          provider: providerFor(runtime, recorder?.url ?? null),
          ...(liveCase.configEnv && Object.keys(liveCase.configEnv).length
            ? { env: liveCase.configEnv }
            : {}),
        });
        await saveBuiltinConfigApiKey(configId, key!);
        coordinator = new AcpRuntimeCoordinator(repo, {
          onPermission: (target, request) => {
            permissions.push(request);
            // 模型扮演用户裁决；规则先行，只能收紧（越界/拒绝名单直接拒绝）。
            void modelJudge(request, workspace, { apiKey: key!, model: MODEL }).then((decision) => {
              decisions.push({ title: request.toolCall.title, ...decision });
              const response = responseFor(request, decision);
              coordinator!.respondPermission({
                ...target,
                ...(response.outcome.outcome === "selected"
                  ? { optionId: response.outcome.optionId }
                  : {}),
              });
            });
          },
        });
        const target = { workspacePath: workspace };
        const preview = await coordinator.discoverConfig({ ...target, runtimeId: configId });
        const modes = preview.modes?.map((mode) => mode.id) ?? [];
        if (modeId) assert.ok(modes.includes(modeId), `mode ${modeId} offered: ${modes.join(",")}`);
        const meta = await coordinator.create({
          ...target,
          commandId: `${runtime}-live`,
          runtimeId: configId,
          ...(modeId ? { modeId } : {}),
        });
        const prompt = BASE_TASK + (liveCase.deniedStep ? DENIED_STEP : "") + ANSWER;
        await coordinator.sendPrompt({
          ...target,
          taskId: meta.taskId,
          commandId: "live-1",
          text: prompt,
        });
        await waitFor(
          () =>
            coordinator!.snapshot({ ...target, taskId: meta.taskId })?.control.phase !== "running",
          300_000,
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
        const note = await readFile(join(workspace, "live-note.txt"), "utf8").catch(() => null);
        const deniedExists = await access(join(workspace, "live-denied.txt")).then(
          () => true,
          () => false,
        );
        if (artifacts) {
          await mkdir(artifacts, { recursive: true });
          await writeFile(
            join(artifacts, `live-${runtime}-${modeId ?? "default"}.json`),
            JSON.stringify(
              {
                runtime,
                mode: snapshot.config.acpModeId,
                model: MODEL,
                phase: snapshot.control.phase,
                decisions,
                tools: tools.map(({ toolName, status }) => ({ toolName, status })),
                note,
                deniedExists,
                answer,
              },
              null,
              2,
            ),
          );
        }
        assert.notEqual(snapshot.control.phase, "error", JSON.stringify(snapshot.control));
        assert.equal(
          snapshot.config.acpModeId ?? undefined,
          modeId ?? snapshot.config.acpModeId ?? undefined,
        );
        assert.ok(tools.length >= 1, "the model used at least one tool");
        assert.equal(note?.trim(), "hello", "live-note.txt was written");
        assert.ok(
          answer.includes(MAGIC),
          `answer contains the magic word: ${answer.slice(0, 300)}`,
        );
        assert.ok(
          permissions.length >= liveCase.minPermissions,
          `>= ${liveCase.minPermissions} prompts`,
        );
        if (liveCase.maxPermissions !== undefined)
          assert.ok(
            permissions.length <= liveCase.maxPermissions,
            `<= ${liveCase.maxPermissions} prompts: ${JSON.stringify(decisions)}`,
          );
        if (liveCase.deniedStep)
          assert.equal(deniedExists, false, "the judge-denied command did not run");
        // 回归保护：密钥不得出现在投影、工具输出或配置文件中。
        assert.ok(!JSON.stringify(rows).includes(key!));
        assert.ok(
          !(
            await readFile(join(root, "data", ".codez", "v2", "agent-configs.json"), "utf8")
          ).includes(key!),
        );
      } finally {
        await coordinator?.closeAll();
        recorder?.child.kill();
        setDataBaseDir(null);
        await rm(root, { recursive: true, force: true });
      }
    },
  );
}
