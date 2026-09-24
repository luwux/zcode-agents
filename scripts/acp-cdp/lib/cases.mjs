// Case matrix for the desktop CDP suite. Replay cases reuse the sanitized fixtures of
// scripts/acp-replay; live cases talk to OpenRouter with a user-provided key.
import { buildSegments } from "../../acp-replay/replay-core.mjs";

export const LIVE_MODEL = "xiaomi/mimo-v2.6-flash";
export const RUNTIMES = ["claude-code", "codex", "pi"];

/** Mode names as the ACP adapters advertise them (shown in the composer's "ACP session mode"). */
const PERMISSION_MODE = {
  // claude-agent-acp "default": always ask before changes.
  "claude-code": { id: "default", name: "Manual" },
  // codex-acp "read-only": the default "agent" mode delegates approvals to the Guardian reviewer,
  // "read-only" asks the user (see builtinRuntimesReplay.e2e.ts).
  codex: { id: "read-only", name: "Ask for approval" },
};

/**
 * Known app defect that stops the Settings › ACP "同步 Agent 模型" step for Codex with a custom
 * provider model (see scripts/acp-cdp/README.md, "Findings").
 */
const CODEX_SYNC_ISSUE = {
  match: /ACP model is unavailable/,
  note:
    "Settings sync (AcpProviderDetail.tsx:136 includeAllModelThoughtLevels) makes " +
    "acpConfigDiscovery.ts:55-62 call setModel() for every model of the first list and then re-select " +
    "the original one; codex-acp lists the configured non-preset model (e.g. gpt-5.4) only until " +
    "another model is selected, so the final setModel() throws at acpConnection.ts:273",
};

const PI_PERMISSION_SKIP =
  "Pi's ACP adapter (acp-extension-pi) never sends session/request_permission: every tool runs " +
  "without approval, so there is no permission prompt to answer";

function replayProvider(runtime, url, model) {
  if (runtime === "codex")
    return { preset: "custom", baseUrl: `${url}/v1`, model, providerId: "replay" };
  if (runtime === "pi") return { preset: "custom", baseUrl: url, api: "anthropic-messages", model };
  return { preset: "custom", baseUrl: url, model };
}

function liveProvider() {
  return { preset: "openrouter", model: LIVE_MODEL };
}

/** Per-turn expectations derived from the fixture exactly like the replay proxy serves it. */
export function fixtureExpectations(fixture, runtime) {
  return buildSegments(fixture).map((segments, index) => {
    const events = segments.flatMap((segment) => segment.events);
    const texts = events.filter((event) => event.kind === "text").map((event) => event.text);
    // codex-acp 把 write_stdin（轮询已有 exec 会话）并入原 exec 行，不产生新的工具行。
    const tools = events.filter(
      (event) =>
        event.kind === "tool_call" && !(runtime === "codex" && event.name === "write_stdin"),
    );
    return {
      turn: index,
      toolCalls: tools.length,
      // 含 write_stdin 在内的全部录制调用 ID，用于核对渲染的卡片都来自录制。
      allToolCallIds: events
        .filter((event) => event.kind === "tool_call")
        .map((event) => event.call_id)
        .filter(Boolean),
      texts,
      finalText: texts.at(-1) ?? null,
    };
  });
}

export function buildCases({ mode, runtimes }) {
  const cases = [];
  for (const runtime of runtimes) {
    const label = { "claude-code": "Claude Code", codex: "Codex", pi: "Pi" }[runtime];
    if (mode === "replay") {
      const fixture = `${runtime}.json`;
      cases.push({
        id: `${runtime}--multi-turn`,
        runtime,
        knownIssue: runtime === "codex" ? CODEX_SYNC_ISSUE : undefined,
        title: `${label} multi-turn replay`,
        configId: `cdp-replay-${runtime}`,
        configName: `CDP replay ${label}`,
        fixture,
        // 回放代理不看提示词，按录制顺序应答；这里输入可读的中性提示，避免触发 @ 提及等编辑器功能。
        prompts: ["Replay turn 1: inspect this workspace.", "Replay turn 2: follow up."],
        provider: (url, model) => replayProvider(runtime, url, model),
        // 默认模式下 Runtime 可能为录制中的 Bash 调用请求授权；像用户一样点“允许一次”，并记录次数。
        answerPermissions: true,
        expectPermission: false,
      });
      if (runtime === "pi") {
        cases.push({
          id: `${runtime}--permission`,
          runtime,
          title: `${label} permission prompt`,
          skip: PI_PERMISSION_SKIP,
        });
        continue;
      }
      cases.push({
        id: `${runtime}--permission`,
        runtime,
        knownIssue: runtime === "codex" ? CODEX_SYNC_ISSUE : undefined,
        title: `${label} permission prompt`,
        configId: `cdp-replay-${runtime}-permission`,
        configName: `CDP replay ${label} permission`,
        fixture: `${runtime}-permission.json`,
        prompts: ["Create the marker file."],
        provider: (url, model) => replayProvider(runtime, url, model),
        mode: PERMISSION_MODE[runtime],
        expectPermission: true,
        marker: "replay-permission-marker.txt",
      });
      continue;
    }
    cases.push({
      id: `${runtime}--live-turn`,
      runtime,
      knownIssue: runtime === "codex" ? CODEX_SYNC_ISSUE : undefined,
      title: `${label} live turn (OpenRouter ${LIVE_MODEL})`,
      configId: `cdp-live-${runtime}`,
      configName: `CDP live ${label}`,
      live: true,
      prompts: [
        "Use your shell tool to run `ls` in the current directory, then answer with one short sentence naming the files you saw.",
      ],
      provider: liveProvider,
      mode: PERMISSION_MODE[runtime],
      // 真实模型可能对只读命令请求授权；出现时按用户操作点“允许一次”。
      answerPermissions: true,
      expectPermission: false,
    });
    if (runtime === "pi") {
      cases.push({
        id: `${runtime}--live-permission`,
        runtime,
        title: `${label} live permission prompt`,
        skip: PI_PERMISSION_SKIP,
      });
      continue;
    }
    cases.push({
      id: `${runtime}--live-permission`,
      runtime,
      knownIssue: runtime === "codex" ? CODEX_SYNC_ISSUE : undefined,
      title: `${label} live permission prompt (OpenRouter ${LIVE_MODEL})`,
      configId: `cdp-live-${runtime}-permission`,
      configName: `CDP live ${label} permission`,
      live: true,
      prompts: [
        "Use your shell tool to run exactly `touch live-permission-marker.txt` in the current directory. Do nothing else, then reply DONE.",
      ],
      provider: liveProvider,
      mode: PERMISSION_MODE[runtime],
      expectPermission: true,
      marker: "live-permission-marker.txt",
    });
  }
  return cases;
}
