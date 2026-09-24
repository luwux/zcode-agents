/**
 * Offline e2e for BYOK configured models: the pinned Claude Code / Codex / Pi CLIs, driven through
 * CodeZ's AcpRuntimeCoordinator against the local replay proxy, must advertise exactly the option ids
 * and reasoning levels that CodeZ derives from the config (so models added in Settings are selectable
 * without a sync), and the chosen model + reasoning effort must reach the provider request.
 *
 * Run via `node scripts/acp-replay/run-replay-e2e.mjs` (loopback-only network namespace). Skips unless
 * CODEZ_E2E_REPLAY=1 and CODEZ_ACP_RUNTIMES_DIR is set.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AcpRuntimeCoordinator } from "../../src/agent-runtime/acpRuntimeCoordinator.js";
import {
  findAgentConfig,
  saveAgentConfig,
} from "../../src/agent-runtime/builtin/agentConfigRegistry.js";
import { configuredModelOptions } from "../../src/agent-runtime/builtin/builtinModelOptions.js";
import { saveBuiltinConfigApiKey } from "../../src/agent-runtime/builtin/builtinRuntimeLaunch.js";
import type { AgentProviderSettings } from "../../src/agent-runtime/builtin/builtinProviderPresets.js";
import type { BuiltinAcpRuntime } from "../../src/agent-runtime/builtin/builtinRuntimeCatalog.js";
import { setDataBaseDir } from "../../src/paths.js";
import { TaskIndexRepo } from "../../src/session/taskIndexRepo.js";
import {
  makeWorkspace,
  replayDir,
  replaySkip as skip,
  startProxy,
  waitFor,
} from "./replayHarness.js";

const artifacts = process.env.CODEZ_E2E_ARTIFACTS;
/** Configured with reasoning off (Codex/Pi drop reasoning parameters for it). */
const SECOND_MODEL = "replay/no-reasoning";

interface ProxyEntry {
  main: boolean;
  api: string;
  params?: Record<string, unknown>;
}

interface Run {
  /** Index of the configured model the session is created with. */
  model: number;
  thoughtLevel?: string;
  /** What every provider request of that model must carry. */
  check: (params: Record<string, unknown>) => boolean;
}

interface Case {
  runtime: BuiltinAcpRuntime;
  fixture: string;
  endpoint: (url: string) => AgentProviderSettings;
  /** Codex: full access, so no Guardian review (hardcoded OpenAI reviewer slug) joins the turn. */
  modeId?: string;
  runs: Run[];
}

const effort = (params: Record<string, unknown>) =>
  (params.output_config as { effort?: string } | undefined)?.effort;
const thinkingOn = (params: Record<string, unknown>) =>
  Boolean(params.thinking) && (params.thinking as { type?: string }).type !== "disabled";
const codexEffort = (params: Record<string, unknown>) =>
  (params.reasoning as { effort?: string } | undefined)?.effort;

const CASES: Case[] = [
  {
    // Claude 自己决定网关模型的思考方式（adaptive）；所选 effort 必须到达请求。
    runtime: "claude-code",
    fixture: "claude-code.json",
    endpoint: (url) => ({ preset: "custom", baseUrl: url }),
    runs: [
      { model: 0, thoughtLevel: "high", check: (params) => effort(params) === "high" },
      { model: 1, thoughtLevel: "low", check: (params) => effort(params) === "low" },
    ],
  },
  {
    runtime: "codex",
    fixture: "codex.json",
    endpoint: (url) => ({ preset: "custom", baseUrl: `${url}/v1`, providerId: "replay" }),
    modeId: "agent-full-access",
    runs: [
      { model: 0, thoughtLevel: "high", check: (params) => codexEffort(params) === "high" },
      {
        model: 1,
        check: (params) => codexEffort(params) === undefined || codexEffort(params) === "none",
      },
    ],
  },
  {
    runtime: "pi",
    fixture: "pi.json",
    endpoint: (url) => ({ preset: "custom", baseUrl: url, api: "anthropic-messages" }),
    runs: [
      { model: 0, thoughtLevel: "high", check: thinkingOn },
      { model: 1, check: (params) => !thinkingOn(params) },
    ],
  },
];

for (const testCase of CASES) {
  test(
    `${testCase.runtime}: configured models are native options and carry the chosen effort`,
    {
      skip,
      timeout: 300_000,
    },
    async () => {
      const root = await mkdtemp(join(tmpdir(), `codez-models-${testCase.runtime}-`));
      setDataBaseDir(join(root, "data"));
      const workspace = await makeWorkspace(root);
      const fixture = JSON.parse(
        await readFile(join(replayDir, "fixtures", testCase.fixture), "utf8"),
      ) as { model: string; turns: Array<{ user: { text: string } }> };
      const proxyLog = join(root, "proxy.jsonl");
      const { child: proxy, url } = await startProxy(testCase.fixture, workspace, proxyLog);
      const coordinator = new AcpRuntimeCoordinator(new TaskIndexRepo(join(root, "tasks.sqlite")), {
        onPermission: () => {},
      });
      const configId = `${testCase.runtime}-models`;
      const target = { workspacePath: workspace };
      try {
        await saveAgentConfig({
          id: configId,
          name: `${testCase.runtime} models`,
          runtime: testCase.runtime,
          auth: "byok",
          provider: {
            ...testCase.endpoint(url),
            models: [{ id: fixture.model }, { id: SECOND_MODEL, reasoning: false }],
          },
        });
        await saveBuiltinConfigApiKey(configId, "replay-dummy-key");
        const options = configuredModelOptions((await findAgentConfig(configId))!);
        assert.equal(options.length, 2);

        // 1. 适配器公布的模型选项包含推出的 ID，推理档位一致（Codex/Pi 只列出声明的模型）。
        const preview = await coordinator.discoverConfig({
          ...target,
          runtimeId: configId,
          includeAllModelThoughtLevels: true,
        });
        const advertised = new Map(preview.models.map((model) => [model.id, model]));
        for (const option of options) {
          const model = advertised.get(option.id);
          assert.ok(model, `${option.id} advertised: ${[...advertised.keys()].join(", ")}`);
          const values = (model.thoughtLevels ?? []).map((level) => level.value);
          for (const level of option.thoughtLevels)
            assert.ok(
              values.includes(level.value),
              `${option.id} offers ${level.value}: ${values}`,
            );
        }
        if (testCase.runtime !== "claude-code")
          assert.deepEqual(
            [...advertised.keys()].sort(),
            options.map((option) => option.id).sort(),
            "only the configured models are listed",
          );

        // 2. 每个会话以指定模型与推理档位创建：该模型的每个 Provider 请求都携带对应推理参数；
        //    关闭推理的模型（Codex/Pi）不携带。
        for (const [index, run] of testCase.runs.entries()) {
          const option = options[run.model]!;
          const meta = await coordinator.create({
            ...target,
            commandId: `models-${index}`,
            runtimeId: configId,
            modelId: option.id,
            ...(run.thoughtLevel ? { thoughtLevel: run.thoughtLevel } : {}),
            ...(testCase.modeId ? { modeId: testCase.modeId } : {}),
          });
          assert.equal(meta.model, option.id);
          assert.equal(
            await coordinator.sendPrompt({
              ...target,
              taskId: meta.taskId,
              commandId: `prompt-${index}`,
              text: fixture.turns[index]!.user.text,
            }),
            "accepted",
          );
          await waitFor(
            () =>
              coordinator.snapshot({ ...target, taskId: meta.taskId })?.control.phase !== "running",
            180_000,
            `turn ${index}`,
          );
          const requests = (await readFile(proxyLog, "utf8"))
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as ProxyEntry)
            .filter((entry) => entry.main && entry.params?.model === option.modelId);
          assert.ok(requests.length > 0, `requests for ${option.modelId}`);
          for (const request of requests)
            assert.ok(
              run.check(request.params!),
              `reasoning params: ${JSON.stringify(request.params)}`,
            );
          await coordinator.closeAll();
        }
      } finally {
        if (artifacts) {
          await mkdir(artifacts, { recursive: true });
          await writeFile(
            join(artifacts, `${testCase.runtime}-models.proxy.jsonl`),
            await readFile(proxyLog, "utf8").catch(() => ""),
          );
        }
        await coordinator.closeAll();
        proxy.kill();
        setDataBaseDir(null);
      }
    },
  );
}
