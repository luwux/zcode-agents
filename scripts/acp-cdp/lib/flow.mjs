// One case = one fresh app instance driven through the real UI:
// onboarding → Settings › Model settings › ACP › sync + enable a model → composer model picker →
// ACP session mode → type + send → streamed rows / tool cards / permission dialog → DOM assertions.
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { launchApp, writeJson } from "./app.mjs";
import { fixtureExpectations } from "./cases.mjs";
import { isTerminalToolStatus, normalizeText, probeDom } from "./dom.mjs";
import {
  makeWorkspace,
  readFixture,
  readProxyLog,
  seedAgentConfigs,
  startReplayProxy,
} from "./support.mjs";
import { waitForTurn } from "./turn.mjs";
import {
  dismissOnboarding,
  enableModelInSettings,
  expandTurnHistories,
  pickAcpSessionMode,
  pickRuntimeInModelPicker,
} from "./ui.mjs";
import { log, redact } from "./util.mjs";

const WORKAROUND_NOTE =
  "--seed-model-catalog: Settings › ACP sync skipped; the model catalog was written by the app's " +
  "own discoverAcpRuntimeConfig() (without per-model thought-level probing) + saveAcpModels()";

function assertReplay({ check, expectations, turns, toolIds, timeline, proxyEntries, fixture }) {
  for (const expectation of expectations) {
    // 每段录制的 assistant 文本（取首行前 30 个字符，去掉 Markdown 标记）都应出现在时间线里。
    const missing = expectation.texts
      .map((text) => normalizeText(text.split("\n")[0]).slice(0, 30))
      .filter((snippet) => snippet && !timeline.includes(snippet));
    check(
      missing.length === 0,
      `turn ${expectation.turn + 1}: all ${expectation.texts.length} recorded assistant texts rendered`,
      { missing },
    );
  }
  const expected = expectations.reduce((sum, turn) => sum + turn.toolCalls, 0);
  const seenWhileStreaming = turns.reduce((sum, turn) => sum + turn.toolCardsSeen, 0);
  if (expected > 0) {
    check(seenWhileStreaming > 0, "tool-call cards appeared while streaming", {
      seenWhileStreaming,
    });
    check(toolIds.length > 0, "tool-call cards rendered after completion", { toolIds });
    // Explore 分组卡片的 ID 为 "explore:<首个调用 ID>"，其余卡片直接使用录制中的调用 ID。
    const recorded = new Set(expectations.flatMap((turn) => turn.allToolCallIds));
    const unknown = toolIds.filter((id) => !recorded.has(id.replace(/^explore:/, "")));
    check(unknown.length === 0, "every rendered tool card maps to a recorded tool call", {
      unknown,
    });
  }
  const mainTurns = new Set(proxyEntries.filter((item) => item.main).map((item) => item.turn)).size;
  check(
    !proxyEntries.some((item) => item.api === "unknown" || item.api === "error"),
    "replay proxy saw only supported requests",
  );
  check(!proxyEntries.some((item) => item.exhausted), "runtime never ran past the fixture");
  check(mainTurns === fixture.turns.length, `proxy served ${fixture.turns.length} turns`, {
    mainTurns,
  });
  return { expected, renderedFinal: toolIds.length, seenWhileStreaming };
}

export async function runCase(testCase, options) {
  const caseDir = join(options.artifacts, testCase.id);
  await mkdir(caseDir, { recursive: true });
  const result = {
    id: testCase.id,
    runtime: testCase.runtime,
    title: testCase.title,
    status: "passed",
    reason: null,
    steps: [],
    assertions: [],
    observations: {},
    artifacts: caseDir,
  };
  const skipReason = testCase.skip ?? options.runtimeSkips[testCase.runtime];
  if (skipReason) {
    result.status = "skipped";
    result.reason = skipReason;
    await writeJson(join(caseDir, "result.json"), result);
    return result;
  }

  const secrets = options.apiKey ? [options.apiKey] : [];
  // 仅在显式 --seed-model-catalog 时启用；结果会标注为变通通过。
  const workaround = options.seedModelCatalog.includes(testCase.runtime);
  if (workaround) result.workaround = WORKAROUND_NOTE;
  const root = await mkdtemp(join(options.scratch, `${testCase.id}-`));
  let app = null;
  let proxy = null;
  let shotIndex = 0;
  const screenshot = async (name) => {
    if (!app) return null;
    const file = join(caseDir, `${String(++shotIndex).padStart(2, "0")}-${name}.png`);
    return app.page.screenshot({ path: file }).then(
      () => file,
      () => null,
    );
  };
  const step = async (name, fn, { finalShot = true } = {}) => {
    const entry = { name, status: "passed", ms: 0 };
    result.steps.push(entry);
    const started = Date.now();
    app?.logAction({ step: name, phase: "start" });
    log(`${testCase.id}: ${name}`);
    try {
      entry.detail = (await fn()) ?? undefined;
    } catch (error) {
      entry.status = "failed";
      entry.error = redact(String(error?.message ?? error), secrets).slice(0, 2000);
      throw error;
    } finally {
      entry.ms = Date.now() - started;
      if (finalShot || entry.status === "failed") entry.screenshot = await screenshot(name);
      app?.logAction({ step: name, phase: "end", status: entry.status });
    }
  };
  const check = (ok, message, detail) => {
    result.assertions.push({ ok: Boolean(ok), message, ...(detail ? { detail } : {}) });
  };
  const ui = () => ({
    page: app.page,
    logAction: app.logAction,
    click: async (locator, target) => {
      app.logAction({ action: "click", target });
      await locator.click();
    },
  });

  try {
    let workspace = null;
    let fixture = null;
    let expectations = null;
    await step("prepare", async () => {
      workspace = await makeWorkspace(root);
      let provider = testCase.live ? testCase.provider() : null;
      const detail = {};
      if (!testCase.live) {
        fixture = await readFixture(testCase.fixture);
        expectations = fixtureExpectations(fixture, testCase.runtime);
        proxy = await startReplayProxy({
          fixture: testCase.fixture,
          workspace,
          log: join(caseDir, "proxy.jsonl"),
          speed: options.speed,
        });
        provider = testCase.provider(proxy.url, fixture.model);
        Object.assign(detail, { proxy: proxy.url, fixture: testCase.fixture });
      }
      detail.seeded = await seedAgentConfigs({
        home: join(root, "home"),
        dataDir: join(root, "data"),
        configs: [
          {
            id: testCase.configId,
            name: testCase.configName,
            runtime: testCase.runtime,
            auth: "byok",
            provider,
          },
        ],
        apiKey: testCase.live ? options.apiKey : "replay-dummy-key",
        apiKeyFor: [testCase.configId],
        discoverModelCatalogFor: workaround ? [testCase.configId] : [],
        workspace,
        extraEnv: { CODEZ_ACP_RUNTIMES_DIR: options.runtimesDir, ...options.appEnv },
        secrets,
      });
      return detail;
    });

    await step("launch-app", async () => {
      app = await launchApp({
        root,
        workspace,
        artifacts: caseDir,
        extraEnv: { CODEZ_ACP_RUNTIMES_DIR: options.runtimesDir, ...options.appEnv },
        secrets,
        ownedPathMarkers: [options.runtimesDir, root],
      });
      return { cdpPort: app.port, url: app.page.url().split("?")[0] };
    });

    await step("dismiss-onboarding", () => dismissOnboarding(ui()));

    if (workaround)
      result.steps.push({
        name: "settings-sync-and-enable-model",
        status: "skipped",
        reason: WORKAROUND_NOTE,
      });
    else
      await step("settings-sync-and-enable-model", () =>
        enableModelInSettings(ui(), {
          configName: testCase.configName,
          wanted: testCase.live ? options.liveModel : fixture.model,
          // Claude 的 Default 经 ANTHROPIC_DEFAULT_*_MODEL 指向配置的模型；Live 下其他 Runtime 必须公布该模型本身。
          allowDefault: !testCase.live || testCase.runtime === "claude-code",
          strict: Boolean(testCase.live),
          timeoutMs: options.syncTimeoutMs,
        }),
      );

    await step("pick-runtime-in-model-picker", () =>
      pickRuntimeInModelPicker(ui(), {
        configId: testCase.configId,
        configName: testCase.configName,
      }),
    );

    if (testCase.mode)
      await step("pick-acp-session-mode", () => pickAcpSessionMode(ui(), testCase.mode));

    const permissionLog = [];
    const turns = [];
    for (const [index, prompt] of testCase.prompts.entries()) {
      const turn = index + 1;
      // 基线必须在发送前读取：回放很快，发送后才读会把本轮新行算进基线。
      let baseline = null;
      await step(
        `turn-${turn}-type-and-send`,
        async () => {
          const { page, click } = ui();
          baseline = await page.evaluate(probeDom);
          await click(page.getByTestId("v4-composer-input"), "composer input");
          app.logAction({ action: "type", target: "composer input", text: prompt });
          await page.keyboard.type(prompt, { delay: 5 });
          // 截图放在发送前：发送后再截图会推迟轮询，回放较快时整轮可能在首次轮询前结束。
          await screenshot(`turn-${turn}-typed`);
          await click(page.getByTestId("v4-composer-send"), "send");
        },
        { finalShot: false },
      );
      await step(`turn-${turn}-stream-and-complete`, async () => {
        const observation = await waitForTurn({
          page: app.page,
          baseline,
          app,
          screenshot,
          turn,
          timeoutMs: options.turnTimeoutMs,
          answerPermissions: testCase.answerPermissions || testCase.expectPermission,
          permissionLog,
        });
        turns.push(observation);
        if (!observation.completed) throw new Error(`turn ${turn} did not complete`);
        return observation;
      });
    }

    await step("assert-rendered-dom", async () => {
      await expandTurnHistories(ui());
      const dom = await app.page.evaluate(probeDom);
      const timeline = normalizeText(dom.timelineText);
      const assistantRows = dom.rows.filter((row) => row.assistant && row.text);
      const toolIds = [...new Set(dom.toolCards.map((card) => card.id))];
      const finalDom = {
        rows: dom.rows.length,
        assistantRows: assistantRows.length,
        toolCards: dom.toolCards,
        alerts: dom.alerts,
      };
      Object.assign(result.observations, { finalDom, turns, permissions: permissionLog });

      for (const prompt of testCase.prompts)
        check(timeline.includes(normalizeText(prompt)), `user prompt rendered: "${prompt}"`);
      check(
        assistantRows.length >= testCase.prompts.length,
        `>= ${testCase.prompts.length} assistant text rows rendered`,
        { assistantRows: assistantRows.length },
      );
      // 回放中无延迟的收尾轮（如 "Replay turn finished."）在首次轮询前就已完成，
      // 因此只要求至少一轮在运行中观察到 assistant 行；每轮时间点都记录在结果里。
      check(
        turns.some((turn) => turn.firstAssistantMs !== null),
        "assistant rows appeared while a turn was still running (streamed)",
        turns.map((turn) => turn.firstAssistantMs),
      );
      check(dom.alerts.length === 0, "no error alerts in the timeline", dom.alerts);
      check(
        dom.toolCards.every((card) => isTerminalToolStatus(card.status)),
        "every tool-call card settled",
        dom.toolCards.map((card) => card.status),
      );
      check(!app.exited(), "app process still running");
      if (!testCase.live)
        result.observations.toolCalls = assertReplay({
          check,
          expectations,
          turns,
          toolIds,
          timeline,
          proxyEntries: await readProxyLog(join(caseDir, "proxy.jsonl")),
          fixture,
        });

      if (testCase.expectPermission) {
        const markerPath = join(workspace, testCase.marker);
        const markerExists = existsSync(markerPath);
        result.observations.marker = { path: markerPath, exists: markerExists };
        if (testCase.live && permissionLog.length === 0 && !markerExists) {
          result.status = "inconclusive";
          result.reason =
            "live model never attempted the write, so no permission prompt appeared (not an app failure)";
        } else {
          check(permissionLog.length >= 1, "permission dialog rendered and answered by click");
          check(markerExists, `${testCase.marker} created after approval`);
        }
      }
      if (testCase.live && !testCase.expectPermission && dom.toolCards.length === 0) {
        result.status = "inconclusive";
        result.reason =
          "live model answered without calling a tool; tool-card rendering unverified";
      }
      return finalDom;
    });
  } catch (error) {
    result.status = "failed";
    result.reason = redact(String(error?.message ?? error), secrets).slice(0, 2000);
    const known = testCase.knownIssue;
    if (known?.match.test(result.reason)) result.reason += ` [known root cause: ${known.note}]`;
  } finally {
    const failed = result.assertions.filter((assertion) => !assertion.ok);
    if (result.status !== "failed" && failed.length) {
      result.status = "failed";
      result.reason = `assertions failed: ${failed.map((item) => item.message).join("; ")}`;
    }
    if (result.status === "passed" && workaround)
      result.reason =
        "passed only with the --seed-model-catalog workaround (Settings sync skipped)";
    await app?.close({ tracePath: join(caseDir, "trace.zip") }).catch((error) => {
      result.teardownError = String(error?.message ?? error);
    });
    proxy?.child.kill();
    if (options.keep) result.throwawayRoot = root;
    else await rm(root, { recursive: true, force: true }).catch(() => {});
    await writeJson(join(caseDir, "result.json"), result);
  }
  return result;
}
