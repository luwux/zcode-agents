/**
 * Shared live-test harness: real tasks for the built-in runtimes through CodeZ's ACP backend on
 * OpenRouter, one model for every runtime (`xiaomi/mimo-v2.6-flash`).
 *
 * Tasks: build a small static website, research this repository's own remote-control code (the
 * workspace is a shallow clone of the checkout), and an internet research task. Permission prompts in
 * ask modes are answered by a seeded random judge (rule veto first, then ~1 in 5 rejections).
 *
 * Opt-in: skips unless OPENROUTER_API_KEY is set. The key only goes to the encrypted credential store
 * of a throwaway data dir and the child env at spawn. Each runtime has its own test file so the three
 * run in parallel processes (the data dir is process-global).
 */
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { AcpRuntimeCoordinator } from "../../../src/agent-runtime/acpRuntimeCoordinator.js";
import { saveAgentConfig } from "../../../src/agent-runtime/builtin/agentConfigRegistry.js";
import { saveBuiltinConfigApiKey } from "../../../src/agent-runtime/builtin/builtinRuntimeLaunch.js";
import type { AgentProviderSettings } from "../../../src/agent-runtime/builtin/builtinProviderPresets.js";
import type { BuiltinAcpRuntime } from "../../../src/agent-runtime/builtin/builtinRuntimeCatalog.js";
import { setDataBaseDir } from "../../../src/paths.js";
import { redPng } from "./livePng.js";
import { TaskIndexRepo } from "../../../src/session/taskIndexRepo.js";
import {
  randomJudge,
  responseFor,
  sandboxEnvForBypass,
  seededRandom,
  type JudgeDecision,
} from "../permissionJudge.js";

export const MODEL = process.env.CODEZ_LIVE_MODEL ?? "xiaomi/mimo-v2.6-flash";
const key = process.env.OPENROUTER_API_KEY?.trim();
const skip = key ? false : "OPENROUTER_API_KEY is not set (live tests are opt-in)";
const artifacts = process.env.CODEZ_E2E_ARTIFACTS;
const record = process.env.CODEZ_LIVE_RECORD === "1";
const SEED = Number(process.env.CODEZ_LIVE_SEED ?? Date.now() % 1_000_000);
const OPENROUTER = "https://openrouter.ai/api";
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../../..");
const replayDir = join(repoRoot, "scripts/acp-replay");

export type LiveTask = "website" | "harness" | "internet" | "features";

export interface LiveCase {
  task: LiveTask;
  modeId?: string;
  label: string;
  /** Answer prompts with the seeded random judge (ask modes). */
  randomJudge?: boolean;
  configEnv?: Record<string, string>;
  /** Exact bounds only where the mode guarantees them (bypass: 0). */
  maxPermissions?: number;
  /** Ask modes where the task must hit an approval (Claude writes, Codex network escalation). */
  minPermissions?: number;
  /** Steer the running turn once the first tool call shows up (live check of mid-turn guide). */
  steer?: boolean;
  /** Use the runtime's preset directly even in record mode (covers Pi's built-in provider). */
  unrecorded?: boolean;
  /** Model override (e.g. a vision model for the `features` task). */
  model?: string;
}

const PROMPTS: Record<LiveTask, string> = {
  website:
    "Build a tiny static website in the folder `site/` of this workspace: `site/index.html` with the " +
    "title 'CodeZ Live Test', an element with id \"status\" and links to `style.css` and `script.js`; " +
    "`site/style.css` with a few basic styles; and `site/script.js` that sets the text of #status to " +
    "'ready'. Use your file tools, then run `ls site` and end with the line WEBSITE DONE.",
  harness:
    "This workspace is the source of CodeZ, a desktop app that runs coding agents. Research how its " +
    "phone / remote control works: search the code for `web-remote-replayable`, `AttachServicePort` " +
    "and `remoteSessionId`, and read docs/research/mobile-sync.md. Do not modify files. Reply with at " +
    "most 6 bullets explaining how a phone would connect to the desktop Host and what is still missing, " +
    "citing the file paths you actually read. Use at most 12 tool calls.",
  internet:
    "Use the internet to research this (for example `curl -sL <url>` in the shell, or your web fetch " +
    "tool): does ZCode (https://github.com/zai-org/ZCode) support remote control from a phone, is there " +
    "an iOS client, and how do you connect ZCode's remote connector? Start from " +
    "https://raw.githubusercontent.com/zai-org/ZCode/main/README.md and the GitHub search API " +
    "(https://api.github.com/search/repositories?q=zcode+remote). Do not modify files. Fetch at most 6 " +
    "URLs, then reply with your findings and list every URL you actually fetched.",
  // 录制用：一次会话覆盖看图、子代理、后台命令（随后的打断见 INTERRUPT_PROMPT）。
  features:
    "Do these steps in order. 1) Look at the attached image and state its main color in one word. " +
    "2) Use your subagent tool (Agent / Task) exactly once to have a subagent run `ls` in this " +
    "workspace and report how many entries it saw; tell me its answer. 3) Run the shell command " +
    "`sleep 2 && echo background-done` in the background (run_in_background), then read its output. " +
    "End with the line FEATURES DONE.",
};

/** 录制中途打断：长命令开始执行后由测试取消当前回合。 */
const INTERRUPT_PROMPT = "Run the shell command `sleep 60 && echo slept` and then say SLEPT.";

const STEER_PROMPT =
  "Change of plan while you work: also add a <footer> containing the exact text 'steered by CodeZ' " +
  "to site/index.html.";

/** 研究任务在 MiMo 上单次响应可达 40-100s，工具调用多；网站任务很短。 */
const TURN_TIMEOUT_MS: Record<LiveTask, number> = {
  website: 300_000,
  harness: 900_000,
  internet: 900_000,
  features: 600_000,
};

export function providerFor(
  runtime: BuiltinAcpRuntime,
  baseUrl: string | null,
  model = MODEL,
): AgentProviderSettings {
  if (!baseUrl) return { preset: "openrouter", model };
  if (runtime === "codex")
    return { preset: "custom", baseUrl: `${baseUrl}/v1`, model, providerId: "openrouter" };
  if (runtime === "pi")
    return { preset: "custom", baseUrl: `${baseUrl}/v1`, api: "openai-completions", model };
  return { preset: "custom", baseUrl, model };
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

async function waitFor(predicate: () => boolean, ms: number, label: string) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function makeWorkspace(root: string, task: LiveTask): Promise<string> {
  const workspace = join(root, "workspace");
  if (task === "harness") {
    // 工作区是当前检出的浅克隆（只含已提交文件），Agent 研究的是真实的 CodeZ 源码。
    execFileSync("git", ["clone", "-q", "--depth", "1", `file://${repoRoot}`, workspace]);
    return workspace;
  }
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "README.md"), "# Live test workspace\n");
  if (task === "features") await writeFile(join(root, "color.png"), redPng());
  execFileSync("git", ["init", "-q"], { cwd: workspace });
  return workspace;
}

function pathOf(request: RequestPermissionRequest, workspace: string): string | null {
  const input = request.toolCall.rawInput as Record<string, unknown> | undefined;
  const raw = input?.file_path ?? input?.path;
  if (typeof raw !== "string") return null;
  const full = isAbsolute(raw) ? raw : join(workspace, raw);
  const rel = relative(workspace, full);
  return rel.startsWith("..") ? null : rel;
}

export function defineLiveCases(runtime: BuiltinAcpRuntime, cases: LiveCase[]): void {
  for (const liveCase of cases) {
    const name = `live ${liveCase.model ?? MODEL}: ${runtime} ${liveCase.task} @ ${liveCase.modeId ?? "default"} (${liveCase.label})`;
    const turnTimeout = TURN_TIMEOUT_MS[liveCase.task];
    test(name, { skip, timeout: turnTimeout + 120_000 }, async () => {
      const root = await mkdtemp(join(tmpdir(), `codez-live-${runtime}-${liveCase.task}-`));
      setDataBaseDir(join(root, "data"));
      const workspace = await makeWorkspace(root, liveCase.task);
      const repo = new TaskIndexRepo(join(root, "tasks.sqlite"));
      const random = seededRandom(SEED + liveCase.task.length * 7919 + runtime.length);
      const decisions: Array<
        { title: string | null | undefined; path: string | null } & JudgeDecision
      > = [];
      const permissions: RequestPermissionRequest[] = [];
      let coordinator: AcpRuntimeCoordinator | null = null;
      let recorder: { child: ChildProcess; url: string } | null = null;
      const configId = `${runtime}-live`;
      const base = `live-${runtime}-${liveCase.task}-${liveCase.modeId ?? "default"}${liveCase.unrecorded ? "-preset" : ""}`;
      try {
        if (record && !liveCase.unrecorded)
          recorder = await startRecorder(join(artifacts ?? root, `${base}.record.jsonl`));
        await saveAgentConfig({
          id: configId,
          name: `${runtime} via OpenRouter`,
          runtime,
          auth: "byok",
          provider: providerFor(runtime, recorder?.url ?? null, liveCase.model),
          ...(liveCase.configEnv && Object.keys(liveCase.configEnv).length
            ? { env: liveCase.configEnv }
            : {}),
        });
        await saveBuiltinConfigApiKey(configId, key!);
        coordinator = new AcpRuntimeCoordinator(repo, {
          onPermission: (target, request) => {
            permissions.push(request);
            const decision = liveCase.randomJudge
              ? randomJudge(request, workspace, random)
              : {
                  decision: "allow" as const,
                  reason: "no judge configured",
                  judge: "rule" as const,
                };
            decisions.push({
              title: request.toolCall.title,
              path: pathOf(request, workspace),
              ...decision,
            });
            const response = responseFor(request, decision);
            setTimeout(() => {
              coordinator!.respondPermission({
                ...target,
                ...(response.outcome.outcome === "selected"
                  ? { optionId: response.outcome.optionId }
                  : {}),
              });
            }, 20);
          },
        });
        const target = { workspacePath: workspace };
        const preview = await coordinator.discoverConfig({ ...target, runtimeId: configId });
        const modes = preview.modes?.map((mode) => mode.id) ?? [];
        if (liveCase.modeId)
          assert.ok(
            modes.includes(liveCase.modeId),
            `mode ${liveCase.modeId} offered: ${modes.join(",")}`,
          );
        const meta = await coordinator.create({
          ...target,
          commandId: `${runtime}-${liveCase.task}`,
          runtimeId: configId,
          ...(liveCase.modeId ? { modeId: liveCase.modeId } : {}),
        });
        await coordinator.sendPrompt({
          ...target,
          taskId: meta.taskId,
          commandId: "live-1",
          text: PROMPTS[liveCase.task],
          ...(liveCase.task === "features"
            ? {
                attachments: [
                  {
                    ref: join(root, "color.png"),
                    fileName: "color.png",
                    mime: "image/png",
                    bytes: (await stat(join(root, "color.png"))).size,
                  },
                ],
              }
            : {}),
        });
        const task = { ...target, taskId: meta.taskId };
        let steerDelivery: string | null = null;
        if (liveCase.steer) {
          // 首个工具调用出现时回合必在运行：此时发送的消息走 guide（引导）而不是被拒绝。
          await waitFor(
            () =>
              coordinator!
                .rowsRange({ ...task, limit: 10_000 })
                .rows.some((row) => row.kind === "toolCall") ||
              coordinator!.snapshot(task)?.control.phase !== "running",
            turnTimeout,
            "first tool call",
          );
          const routing = coordinator.snapshot(task)?.inputRouting.mode;
          if (coordinator.snapshot(task)?.control.phase === "running")
            assert.equal(routing, "guide", "a running built-in runtime accepts guide input");
          assert.equal(
            await coordinator.sendPrompt({ ...task, commandId: "live-steer", text: STEER_PROMPT }),
            "accepted",
          );
        }
        // 引导回退为排队时，协调器在回合收尾前等待引导结果并立即启动下一回合，因此
        // “不在运行 + 引导输入行已存在”即表示引导内容已被处理。
        await waitFor(
          () =>
            coordinator!.snapshot(task)?.control.phase !== "running" &&
            (!liveCase.steer ||
              coordinator!
                .rowsRange({ ...task, limit: 10_000 })
                .rows.some(
                  (row) => row.kind === "userInput" && row.sourceCommandId === "live-steer",
                )),
          turnTimeout,
          "live turn",
        );
        let interrupted: string | null = null;
        if (liveCase.task === "features") {
          // 第二个回合：长命令开始后取消，录下中途打断。
          const before = coordinator.rowsRange({ ...task, limit: 10_000 }).rows.length;
          await coordinator.sendPrompt({ ...task, commandId: "live-2", text: INTERRUPT_PROMPT });
          await waitFor(
            () =>
              coordinator!
                .rowsRange({ ...task, limit: 10_000 })
                .rows.slice(before)
                .some((row) => row.kind === "toolCall") ||
              coordinator!.snapshot(task)?.control.phase !== "running",
            turnTimeout,
            "interrupt turn tool call",
          );
          interrupted = coordinator.snapshot(task)?.control.phase ?? null;
          await coordinator.cancel(task);
          await waitFor(
            () => coordinator!.snapshot(task)?.control.phase !== "running",
            60_000,
            "cancelled turn",
          );
        }
        const snapshot = coordinator.snapshot(task)!;
        const { rows } = coordinator.rowsRange({ ...task, limit: 10_000 });
        if (liveCase.steer) {
          const inputs = rows.filter((row) => row.kind === "userInput");
          const original = inputs.find((row) => row.sourceCommandId === "live-1");
          const steered = inputs.find((row) => row.sourceCommandId === "live-steer");
          steerDelivery =
            steered && original && steered.turnId === original.turnId ? "guide" : "queued";
        }
        const answer = rows
          .filter((row) => row.kind === "assistantText")
          .map((row) => (row as { text: string }).text)
          .join("\n");
        const tools = rows.filter((row) => row.kind === "toolCall") as Array<{
          toolName: string;
          status: string;
          inputText: string;
        }>;
        const report = {
          runtime,
          task: liveCase.task,
          mode: snapshot.config.acpModeId,
          model: liveCase.model ?? MODEL,
          seed: SEED,
          phase: snapshot.control.phase,
          steerDelivery,
          interruptedWhile: interrupted,
          lastError: (snapshot.control as { lastError?: unknown }).lastError ?? null,
          decisions,
          tools: tools.map(({ toolName, status, inputText }) => ({
            toolName,
            status,
            input: inputText.slice(0, 300),
          })),
          answer,
        };
        if (artifacts) {
          await mkdir(artifacts, { recursive: true });
          await writeFile(join(artifacts, `${base}.json`), JSON.stringify(report, null, 2));
        }
        // 研究类任务的结论直接打印到测试输出，便于在 CI 日志中阅读（只有模型输出，无凭据）。
        console.log(
          `\n===== ${name}\nphase=${report.phase} tools=${tools.length} prompts=${permissions.length} ` +
            `rejected=${decisions.filter((d) => d.decision === "reject").length}` +
            `${steerDelivery ? ` steer=${steerDelivery}` : ""}\n${answer.slice(0, 3000)}\n=====`,
        );

        assert.notEqual(snapshot.control.phase, "error", JSON.stringify(report.lastError));
        assert.ok(tools.length >= 1, "the model used at least one tool");
        if (liveCase.maxPermissions !== undefined)
          assert.ok(
            permissions.length <= liveCase.maxPermissions,
            `<= ${liveCase.maxPermissions} prompts: ${JSON.stringify(decisions)}`,
          );
        if (liveCase.minPermissions !== undefined)
          assert.ok(
            permissions.length >= liveCase.minPermissions,
            `ask mode asked at least ${liveCase.minPermissions} time(s): ${JSON.stringify(decisions)}`,
          );
        const exists = (path: string) =>
          access(join(workspace, path)).then(
            () => true,
            () => false,
          );
        // 被拒绝的写入：若之后没有任何获批的请求（Agent 可能改用获批的命令重写），文件不得出现。
        for (const [index, rejected] of decisions.entries()) {
          if (rejected.decision !== "reject" || !rejected.path) continue;
          if (decisions.slice(index + 1).some((later) => later.decision === "allow")) continue;
          assert.equal(
            await exists(rejected.path),
            false,
            `${rejected.path} was rejected but exists`,
          );
        }
        if (liveCase.task === "website" && !decisions.some((d) => d.decision === "reject")) {
          const html = await readFile(join(workspace, "site/index.html"), "utf8");
          assert.match(html, /CodeZ Live Test/);
          assert.match(await readFile(join(workspace, "site/script.js"), "utf8"), /ready/);
          if (liveCase.steer) assert.match(html, /steered by CodeZ/i, "the steer was followed");
        }
        if (liveCase.task === "harness") {
          assert.match(
            answer,
            /replayable|AttachServicePort|remoteSessionId/i,
            "answer engages with the code",
          );
          const cited = [...answer.matchAll(/(?:packages|apps|docs|scripts)\/[\w./-]+\.\w+/g)].map(
            (m) => m[0],
          );
          const real = [];
          for (const path of cited) if (await exists(path)) real.push(path);
          assert.ok(real.length >= 1, `answer cites at least one real file: ${cited.join(", ")}`);
        }
        if (liveCase.task === "features") {
          assert.match(answer, /red/i, "the model saw the attached image");
          assert.equal(interrupted, "running", "the second turn was cancelled while running");
        }
        if (liveCase.task === "internet") {
          assert.ok(
            tools.some((tool) => /https?:\/\//.test(tool.inputText)),
            "the agent fetched at least one URL",
          );
          // Codex 的拒绝选项（“No, and tell Codex what to do differently”）会中止回合，此时没有最终答案。
          if (!decisions.some((d) => d.decision === "reject"))
            assert.match(answer, /https?:\/\//, "the answer lists fetched URLs");
        }
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
    });
  }
}

export { sandboxEnvForBypass };
