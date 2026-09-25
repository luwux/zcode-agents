// Case matrix for the desktop CDP suite. Replay cases reuse the sanitized fixtures of
// scripts/acp-replay; live cases talk to OpenRouter with a user-provided key.
import { buildSegments } from "../../acp-replay/replay-core.mjs";

// 实时用例默认用便宜且工具调用可靠的模型；可用 CODEZ_CDP_LIVE_MODEL 覆盖。
export const LIVE_MODEL = process.env.CODEZ_CDP_LIVE_MODEL ?? "deepseek/deepseek-v4-flash";

const TOOLS_SECRET = "MANGO-17";
const SKILL_PHRASE = "PROBE-7F3A-SKILL";
const SKILL_MD = [
  "---",
  "name: codez-probe",
  "description: Use when asked for the codez probe phrase. It returns the verification phrase.",
  "---",
  "",
  `Reply with the exact phrase ${SKILL_PHRASE} and nothing else.`,
  "",
].join("\n");
const TOOLS_PROMPTS = [
  "Read the file notes.txt in this workspace and reply with the secret word written in it.",
  "Create a new file hello.txt in this workspace whose entire content is exactly: hello codez",
  "Edit hello.txt so that its entire content becomes exactly: goodbye codez",
  "Use the codez-probe skill: follow its instructions and reply with the phrase it gives you.",
];

/** 工具用例的工作区：一个带暗号的文件，以及各 Runtime 约定目录下的同一个技能。 */
async function setupToolsWorkspace(workspace) {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  await writeFile(
    join(workspace, "notes.txt"),
    `Project notes.\nThe secret word is ${TOOLS_SECRET}.\n`,
  );
  for (const dir of [".claude/skills", ".agents/skills", ".codex/skills", ".pi/skills"]) {
    await mkdir(join(workspace, dir, "codez-probe"), { recursive: true });
    await writeFile(join(workspace, dir, "codez-probe", "SKILL.md"), SKILL_MD);
  }
}

/** 按轮次验证读、写、改与技能：答案看渲染后的时间线，写与改看磁盘上的文件。 */
async function verifyTools({ workspace, timeline }) {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const hello = await readFile(join(workspace, "hello.txt"), "utf8").catch(() => null);
  return [
    [timeline.includes(TOOLS_SECRET), `read: the answer contains the secret word ${TOOLS_SECRET}`],
    [hello !== null, "write: hello.txt exists"],
    [
      hello?.trim() === "goodbye codez",
      "edit: hello.txt now reads exactly 'goodbye codez'",
      { hello },
    ],
    [timeline.includes(SKILL_PHRASE), `skill: the answer contains ${SKILL_PHRASE}`],
  ];
}

// 图片用例需要能看图的模型；qwen3.7-flash 便宜且支持图片与工具调用。
export const VISION_MODEL = process.env.CODEZ_CDP_VISION_MODEL ?? "qwen/qwen3.7-flash";
const VISION_NUMBER = "4827";

const BROWSER_SKIP =
  "Claude Code, Codex and Pi expose no browser tool in these configurations (Claude's WebFetch does not " +
  "render pages; CodeZ's browser-use belongs to its own agent), so there is no ACP browser action to drive";
export const RUNTIMES = ["claude-code", "codex", "pi"];

/** Mode names as the ACP adapters advertise them (shown in the composer's "ACP session mode"). */
const PERMISSION_MODE = {
  // claude-agent-acp "default": always ask before changes.
  "claude-code": { id: "default", name: "Manual" },
  // codex-acp "read-only": the default "agent" mode delegates approvals to the Guardian reviewer,
  // "read-only" asks the user (see builtinRuntimesReplay.e2e.ts).
  codex: { id: "read-only", name: "Ask for approval" },
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

/**
 * Codex 的 "Ask for approval"（read-only 模式 id）使用 workspace-write 沙箱：工作区内的 touch 不会询问，
 * 只有联网或写工作区外才申请越权，因此 Codex 的实时权限用例用一条需要联网的命令触发审批。
 */
const LIVE_PERMISSION_PROMPT = {
  "claude-code":
    "Use your shell tool to run exactly `touch live-permission-marker.txt` in the current directory. Do nothing else, then reply DONE.",
  codex:
    "Use your shell tool to run exactly `curl -sS -o /dev/null https://openrouter.ai/ && touch live-permission-marker.txt` " +
    "in the current directory. It needs network access: if the sandbox blocks it, run it again with escalated " +
    "permissions. Do nothing else, then reply DONE.",
};

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
    // 真实 Key + 设置页添加模型（点击/键入）+ 读、写、改与技能，逐项核对界面和磁盘。
    cases.push({
      id: `${runtime}--live-tools`,
      runtime,
      title: `${label} live tools: read, write, edit, skill (OpenRouter ${LIVE_MODEL})`,
      configId: `cdp-live-${runtime}-tools`,
      configName: `CDP live ${label} tools`,
      live: true,
      addModelInUi: true,
      prompts: TOOLS_PROMPTS,
      provider: liveProvider,
      mode: PERMISSION_MODE[runtime],
      answerPermissions: true,
      expectPermission: false,
      setupWorkspace: setupToolsWorkspace,
      verify: verifyTools,
    });
    // 粘贴截图（内联图片 → 分片上传 → ACP image 块）并要求模型复述图中的数字。
    cases.push({
      id: `${runtime}--live-vision`,
      runtime,
      title: `${label} live pasted image (OpenRouter ${VISION_MODEL})`,
      configId: `cdp-live-${runtime}-vision`,
      configName: `CDP live ${label} vision`,
      live: true,
      addModelInUi: true,
      vision: true,
      pasteImageText: VISION_NUMBER,
      prompts: ["What number is written in the attached image? Reply with only the number."],
      provider: () => ({ preset: "openrouter", model: VISION_MODEL }),
      mode: PERMISSION_MODE[runtime],
      answerPermissions: true,
      expectPermission: false,
      verify: async ({ timeline }) => [
        [timeline.includes(VISION_NUMBER), `vision: the answer contains ${VISION_NUMBER}`],
      ],
    });
    cases.push({
      id: `${runtime}--live-browser`,
      runtime,
      title: `${label} live browser`,
      skip: BROWSER_SKIP,
    });
    cases.push({
      id: `${runtime}--live-turn`,
      runtime,
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
      title: `${label} live permission prompt (OpenRouter ${LIVE_MODEL})`,
      configId: `cdp-live-${runtime}-permission`,
      configName: `CDP live ${label} permission`,
      live: true,
      prompts: [LIVE_PERMISSION_PROMPT[runtime]],
      provider: liveProvider,
      mode: PERMISSION_MODE[runtime],
      expectPermission: true,
      marker: "live-permission-marker.txt",
    });
  }
  return cases;
}
