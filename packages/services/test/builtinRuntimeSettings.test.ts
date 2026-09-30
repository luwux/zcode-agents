import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { saveAgentServerConfig } from "../src/agent-runtime/agentServersRegistry.js";
import {
  findAgentConfig,
  getAgentConfigsPath,
  saveAgentConfig,
} from "../src/agent-runtime/builtin/agentConfigRegistry.js";
import { describeBuiltinRuntimeCatalog } from "../src/agent-runtime/builtin/builtinRuntimeCatalogView.js";
import {
  deleteBuiltinRuntimeConfig,
  loginBuiltinRuntime,
  logoutBuiltinRuntimeConfig,
  onBuiltinRuntimeAuthChange,
  saveBuiltinRuntimeConfig,
} from "../src/agent-runtime/builtin/builtinRuntimeService.js";
import { listBuiltinRuntimeStatuses } from "../src/agent-runtime/builtin/builtinRuntimeStatus.js";
import { acpAuthStateStore } from "../src/agent-runtime/acpAuthState.js";
import { setDataBaseDir } from "../src/paths.js";

const SECRET = "sk-settings-ui-secret-0123456789";

/** 每个用例使用一次性数据根与空的 Runtime 安装目录；任何安装尝试都会在其中留下目录。 */
async function withDataRoot(run: (dir: string, runtimesDir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "codez-acp-settings-"));
  const runtimesDir = join(dir, "runtimes");
  await mkdir(runtimesDir);
  const previousRuntimes = process.env.CODEZ_ACP_RUNTIMES_DIR;
  process.env.CODEZ_ACP_RUNTIMES_DIR = runtimesDir;
  setDataBaseDir(dir);
  try {
    await run(dir, runtimesDir);
  } finally {
    setDataBaseDir(null);
    if (previousRuntimes === undefined) delete process.env.CODEZ_ACP_RUNTIMES_DIR;
    else process.env.CODEZ_ACP_RUNTIMES_DIR = previousRuntimes;
    await rm(dir, { recursive: true, force: true });
  }
}

test("the settings catalog mirrors runtime auth modes and presets without secrets", () => {
  const catalog = describeBuiltinRuntimeCatalog("linux");
  assert.deepEqual(
    catalog.runtimes.map((entry) => entry.runtime),
    ["claude-code", "codex", "pi"],
  );
  assert.deepEqual(catalog.defaultConfigIds, ["claude-code", "codex", "pi"]);
  const [claude, codex, pi] = catalog.runtimes;
  assert.deepEqual(claude!.authModes, ["subscription", "byok", "cli-login"]);
  assert.deepEqual(pi!.authModes, ["byok", "cli-login"]);
  assert.equal(claude!.signIn, true);
  assert.equal(pi!.signIn, false);
  assert.equal(codex!.deviceSignIn, true);
  assert.equal(claude!.deviceSignIn, false);
  assert.deepEqual(
    claude!.presets.map((preset) => preset.id),
    ["anthropic", "openrouter", "glm", "zai", "deepseek", "kimi", "custom"],
  );
  assert.deepEqual(
    codex!.presets.map((preset) => preset.id),
    ["openai", "openrouter", "custom"],
  );
  const claudeCustom = claude!.presets.find((preset) => preset.id === "custom")!;
  assert.equal(claudeCustom.requiresBaseUrl, true);
  assert.equal(claudeCustom.baseUrl, undefined);
  assert.equal(claudeCustom.apiOptions, undefined);
  assert.equal(
    claude!.presets.find((preset) => preset.id === "openrouter")!.baseUrl,
    "https://openrouter.ai/api",
  );
  // Pi 经兼容端点（OpenRouter 预设与自定义端点）必须指定模型；内置 provider 预设不需要。
  const piOpenRouter = pi!.presets.find((preset) => preset.id === "openrouter")!;
  assert.equal(piOpenRouter.requiresModel, true);
  assert.equal(piOpenRouter.apiOptions, undefined);
  assert.equal(pi!.presets.find((preset) => preset.id === "anthropic")!.requiresModel, false);
  const piCustom = pi!.presets.find((preset) => preset.id === "custom")!;
  assert.equal(pi!.presets.find((preset) => preset.id === "anthropic")!.baseUrlEditable, false);
  assert.equal(claude!.presets.find((preset) => preset.id === "anthropic")!.baseUrlEditable, true);
  assert.deepEqual(piCustom, {
    id: "custom",
    name: "Custom endpoint",
    requiresBaseUrl: true,
    baseUrlEditable: true,
    requiresModel: true,
    apiOptions: ["openai-completions", "openai-responses", "anthropic-messages"],
    defaultApi: "openai-completions",
  });
  assert.equal(pi!.unsupportedReason, undefined);
  assert.match(
    describeBuiltinRuntimeCatalog("win32").runtimes[2]!.unsupportedReason ?? "",
    /Windows/,
  );
});

test("saving from Settings validates the RPC shape before touching the registry", async () => {
  await withDataRoot(async () => {
    const base = { id: "claude-or", name: "Claude Code (OpenRouter)", runtime: "claude-code" };
    await assert.rejects(
      saveBuiltinRuntimeConfig({ ...base, auth: "byok", apiKey: 42 as unknown as string }),
      /Invalid built-in runtime configuration: apiKey/,
    );
    await assert.rejects(
      saveBuiltinRuntimeConfig({ ...base, id: "Bad ID", auth: "byok" }),
      /Invalid built-in runtime configuration: id/,
    );
    await assert.rejects(
      saveBuiltinRuntimeConfig({ ...base, auth: "byok", create: "yes" as unknown as boolean }),
      /Invalid built-in runtime configuration: create/,
    );
    // 形状合法但内容非法时仍由 registry 拒绝（Pi 不支持订阅）。
    await assert.rejects(
      saveBuiltinRuntimeConfig({ id: "pi-sub", name: "Pi", runtime: "pi", auth: "subscription" }),
      /Auth mode must be one of byok, cli-login/,
    );
    await assert.rejects(readFile(getAgentConfigsPath(), "utf8"), { code: "ENOENT" });
  });
});

test("create refuses to overwrite an existing built-in config or custom ACP server", async () => {
  await withDataRoot(async () => {
    // 默认配置未落盘也存在；新建入口不得接管它的私有 home 与会话。
    await assert.rejects(
      saveBuiltinRuntimeConfig({
        id: "claude-code",
        name: "Mine",
        runtime: "claude-code",
        auth: "byok",
        create: true,
      }),
      /already used by a built-in runtime configuration/,
    );
    const created = {
      id: "claude-or",
      name: "Claude Code (OpenRouter)",
      runtime: "claude-code",
      auth: "byok",
      provider: { preset: "openrouter", model: "vendor/model-a" },
      apiKey: SECRET,
      create: true,
    };
    await saveBuiltinRuntimeConfig(created);
    await assert.rejects(saveBuiltinRuntimeConfig(created), /already used/);
    // 编辑（无 create）仍是按 ID 更新。
    await saveBuiltinRuntimeConfig({ ...created, create: undefined, name: "Renamed" });
    assert.equal((await findAgentConfig("claude-or"))?.name, "Renamed");
    await saveAgentServerConfig({
      id: "my-agent",
      name: "Mine",
      command: process.execPath,
      args: [],
    });
    await assert.rejects(
      saveBuiltinRuntimeConfig({ ...created, id: "my-agent" }),
      /custom ACP server/,
    );
  });
});

test("the key is write-only: status reports hasApiKey and never the value; env survives UI saves", async () => {
  await withDataRoot(async () => {
    await saveAgentConfig({
      id: "codex-or",
      name: "Codex (OpenRouter)",
      runtime: "codex",
      auth: "byok",
      provider: { preset: "openrouter", model: "a" },
      env: { CODEX_EXTRA_FLAG: "1" },
    });
    let status = (await listBuiltinRuntimeStatuses()).statuses.find((s) => s.id === "codex-or")!;
    assert.equal(status.reason, "API key is not configured");
    assert.equal(status.builtin.hasApiKey, false);
    // 设置页保存时不传 env：Host 保留文件中已有的变量。
    await saveBuiltinRuntimeConfig({
      id: "codex-or",
      name: "Codex (OpenRouter)",
      runtime: "codex",
      auth: "byok",
      provider: { preset: "openrouter", model: "a" },
      apiKey: `  ${SECRET}  `,
    });
    status = (await listBuiltinRuntimeStatuses()).statuses.find((s) => s.id === "codex-or")!;
    assert.equal(status.reason, undefined);
    assert.equal(status.builtin.hasApiKey, true);
    assert.equal(status.builtin.authState, "authenticated");
    assert.ok(!JSON.stringify(status).includes(SECRET));
    const file = await readFile(getAgentConfigsPath(), "utf8");
    assert.ok(!file.includes(SECRET));
    assert.deepEqual((await findAgentConfig("codex-or"))?.env, { CODEX_EXTRA_FLAG: "1" });
    // 「清除 Key」：同一入口、已保存配置 + apiKey null。
    await saveBuiltinRuntimeConfig({
      id: "codex-or",
      name: "Codex (OpenRouter)",
      runtime: "codex",
      auth: "byok",
      provider: { preset: "openrouter", model: "a" },
      apiKey: null,
    });
    status = (await listBuiltinRuntimeStatuses()).statuses.find((s) => s.id === "codex-or")!;
    assert.equal(status.builtin.hasApiKey, false);
    assert.equal(status.reason, "API key is not configured");
  });
});

test("deleting an unused subscription config skips sign-out instead of installing the runtime", async () => {
  await withDataRoot(async (_dir, runtimesDir) => {
    await saveBuiltinRuntimeConfig({
      id: "claude-work",
      name: "Claude Code (work)",
      runtime: "claude-code",
      auth: "subscription",
      create: true,
    });
    await deleteBuiltinRuntimeConfig("claude-work");
    assert.equal(await findAgentConfig("claude-work"), null);
    // 登出需要解析启动；未创建私有 home 时不应尝试安装（安装会在 Runtime 目录留下子目录）。
    assert.deepEqual(await readdir(runtimesDir), []);
    await assert.rejects(deleteBuiltinRuntimeConfig("Not An Id"), /Invalid built-in runtime/);
    await assert.rejects(deleteBuiltinRuntimeConfig("claude-code"), /not saved/);
  });
});

test("sign-in requests are validated and run outside any workspace", async () => {
  await withDataRoot(async (_dir, runtimesDir) => {
    await assert.rejects(
      loginBuiltinRuntime({ runtimeId: "codex", deviceAuth: "yes" as unknown as boolean }),
      /Invalid sign-in request: deviceAuth/,
    );
    await assert.rejects(loginBuiltinRuntime({ runtimeId: "../codex" }), /Invalid sign-in/);
    await assert.rejects(loginBuiltinRuntime({ runtimeId: "missing" }), /not available: missing/);
    // BYOK 与 cli-login 登出都在解析启动前被拒绝。
    await assert.rejects(loginBuiltinRuntime({ runtimeId: "pi" }), /authenticate with an API key/);
    await saveBuiltinRuntimeConfig({
      id: "codex-global",
      name: "Codex (CLI login)",
      runtime: "codex",
      auth: "cli-login",
      create: true,
    });
    await assert.rejects(
      logoutBuiltinRuntimeConfig({ runtimeId: "codex-global" }),
      /global CLI login/,
    );
    // 请求不再携带 workspacePath：多余字段被剥离，不会被当作 cwd。
    await assert.rejects(
      loginBuiltinRuntime({
        runtimeId: "pi",
        workspacePath: "/remote/only/path",
      } as unknown as { runtimeId: string }),
      /authenticate with an API key/,
    );
    // 以上拒绝都发生在解析启动之前：没有任何安装尝试。
    assert.deepEqual(await readdir(runtimesDir), []);
  });
});

test("auth changes are forwarded as triggers without messages", () => {
  const seen: unknown[] = [];
  const stop = onBuiltinRuntimeAuthChange((change) => seen.push(change));
  try {
    acpAuthStateStore.markAuthenticating("cfg-event");
    acpAuthStateStore.markAuthRequired(
      "cfg-event",
      "Open https://login.example/device code ABCD-EFGH",
    );
    acpAuthStateStore.markAuthRequired(
      "cfg-event",
      "Open https://login.example/device code ABCD-EFGH",
    );
  } finally {
    stop();
  }
  // 取消订阅后不再转发；同状态同消息的重复写入不产生事件。
  acpAuthStateStore.markAuthenticated("cfg-event");
  assert.deepEqual(seen, [
    { runtimeId: "cfg-event", state: "authenticating" },
    { runtimeId: "cfg-event", state: "auth-required" },
  ]);
});

test("configured models are validated per runtime", async () => {
  const { parseAgentConfig } = await import("../src/agent-runtime/builtin/agentConfigRegistry.js");
  const parse = (runtime: string, models: unknown) =>
    parseAgentConfig("cfg", {
      name: "Cfg",
      runtime,
      auth: "byok",
      provider: { preset: "openrouter", models },
    });
  assert.equal(parse("codex", [{ id: "a" }, { id: "a" }]), "Duplicate model a");
  assert.match(String(parse("codex", [{ id: "has space" }])), /without spaces/);
  assert.match(String(parse("codex", [{ id: "a", extra: 1 }])), /Unknown provider.models key/);
  assert.match(String(parse("codex", [{ id: "a", contextWindow: 0 }])), /positive integer/);
  assert.match(String(parse("codex", [{ id: "a", slot: 1 }])), /only valid for Claude/);
  assert.match(
    String(
      parse(
        "claude-code",
        Array.from({ length: 6 }, (_, index) => ({ id: `m${index}` })),
      ),
    ),
    /at most 5 models/,
  );
  assert.match(
    String(
      parse("claude-code", [
        { id: "a", slot: 1 },
        { id: "b", slot: 1 },
      ]),
    ),
    /unique Claude model slot/,
  );
  const parsed = parse("pi", [{ id: "a", name: "a", reasoningLevels: ["high", "low"] }]);
  assert.notEqual(typeof parsed, "string");
  // 与 ID 相同的名称不保存；档位按固定顺序规范化。
  assert.deepEqual((parsed as { provider: { models: unknown } }).provider.models, [
    { id: "a", reasoningLevels: ["low", "high"] },
  ]);
});

test("Claude model slots stay stable when other models are removed", async () => {
  await withDataRoot(async () => {
    const { buildBuiltinLaunchEnv } =
      await import("../src/agent-runtime/builtin/builtinRuntimeEnv.js");
    const { configuredModelOptions } =
      await import("../src/agent-runtime/builtin/builtinModelOptions.js");
    const base = {
      id: "claude-or",
      name: "Claude Code (OpenRouter)",
      runtime: "claude-code",
      auth: "byok",
    };
    await saveBuiltinRuntimeConfig({
      ...base,
      provider: {
        preset: "openrouter",
        models: [{ id: "a/one" }, { id: "b/two" }, { id: "c/three" }],
      },
      apiKey: SECRET,
    });
    const first = (await findAgentConfig("claude-or"))!;
    assert.deepEqual(
      first.provider?.models?.map((model) => model.slot),
      [0, 1, 2],
    );
    assert.deepEqual(
      configuredModelOptions(first).map((option) => option.id),
      ["acp:model:model:opus", "acp:model:model:sonnet", "acp:model:model:haiku"],
    );
    // 删除第一个模型：其余模型保留原槽位，既有会话的别名仍指向同一模型。
    await saveBuiltinRuntimeConfig({
      ...base,
      provider: { preset: "openrouter", models: first.provider!.models!.slice(1) },
    });
    const second = (await findAgentConfig("claude-or"))!;
    assert.deepEqual(
      configuredModelOptions(second).map((option) => [option.modelId, option.id]),
      [
        ["b/two", "acp:model:model:sonnet"],
        ["c/three", "acp:model:model:haiku"],
      ],
    );
    const plan = buildBuiltinLaunchEnv({
      config: second,
      hostEnv: {},
      apiKey: SECRET,
      configHome: "/home",
    });
    // 空出的 opus 槽（也是 “Default”）指向默认模型，而不是 Claude 官方模型名。
    assert.equal(plan.env.ANTHROPIC_DEFAULT_OPUS_MODEL, "b/two");
    assert.equal(plan.env.ANTHROPIC_DEFAULT_SONNET_MODEL, "b/two");
    assert.equal(plan.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "c/three");
    // 新增模型占用第一个空闲槽。
    await saveBuiltinRuntimeConfig({
      ...base,
      provider: {
        preset: "openrouter",
        models: [...second.provider!.models!, { id: "d/four" }],
      },
    });
    const third = (await findAgentConfig("claude-or"))!;
    assert.deepEqual(
      third.provider?.models?.map((model) => [model.id, model.slot]),
      [
        ["b/two", 1],
        ["c/three", 2],
        ["d/four", 0],
      ],
    );
  });
});

test("configured models become picker entries with runtime-specific ids and levels", async () => {
  const { configuredModelOptions, projectBuiltinModels } =
    await import("../src/agent-runtime/builtin/builtinModelOptions.js");
  const models = [
    { id: "deepseek/deepseek-v4.1-flash" },
    { id: "x/no-think", reasoning: false, enabled: false },
  ];
  const config = (runtime: "claude-code" | "codex" | "pi") => ({
    id: "cfg",
    name: "Cfg",
    runtime,
    auth: "byok" as const,
    provider: { preset: "openrouter", models },
  });
  const codex = configuredModelOptions(config("codex"));
  assert.deepEqual(
    codex.map((option) => option.id),
    ["acp:model:model:deepseek%2Fdeepseek-v4.1-flash", "acp:model:model:x%2Fno-think"],
  );
  assert.deepEqual(codex[0]!.thoughtLevels, [
    { value: "low", name: "Low" },
    { value: "medium", name: "Medium" },
    { value: "high", name: "High" },
  ]);
  assert.deepEqual(codex[1]!.thoughtLevels, []);
  const pi = configuredModelOptions(config("pi"));
  assert.equal(pi[0]!.id, "acp:model:model:codez%2Fdeepseek%2Fdeepseek-v4.1-flash");
  assert.deepEqual(
    pi[0]!.thoughtLevels.map((level) => level.value),
    ["off", "low", "medium", "high"],
  );
  const claude = configuredModelOptions(config("claude-code"));
  assert.deepEqual(
    claude.map((option) => option.id),
    ["acp:model:model:opus", "acp:model:model:sonnet"],
  );
  assert.deepEqual(
    claude[1]!.thoughtLevels.map((level) => level.value),
    ["default", "low", "medium", "high", "xhigh", "max"],
  );
  // 订阅配置不声明模型：沿用同步缓存。
  assert.deepEqual(configuredModelOptions({ ...config("codex"), auth: "subscription" }), []);

  let catalogReads = 0;
  const catalog = async () => {
    catalogReads += 1;
    return { models: [{ id: "synced", name: "Synced" }], availableModels: [] };
  };
  const projected = await projectBuiltinModels({ enabled: true, configured: codex, catalog });
  assert.deepEqual(
    projected.models.map((model) => model.name),
    ["deepseek/deepseek-v4.1-flash"],
  );
  assert.equal(projected.availableModels.length, 2);
  assert.equal(catalogReads, 0);
  assert.deepEqual(
    (await projectBuiltinModels({ enabled: false, configured: codex, catalog })).models,
    [],
  );
  assert.deepEqual(
    (await projectBuiltinModels({ enabled: true, configured: [], catalog })).models,
    [{ id: "synced", name: "Synced" }],
  );
  assert.deepEqual(
    (await projectBuiltinModels({ enabled: false, configured: [], catalog })).models,
    [],
  );
});

test("editing models, names or the enabled flag keeps auth state and the synced catalog", async () => {
  await withDataRoot(async () => {
    const { readAcpModelCatalog, saveAcpModels } =
      await import("../src/agent-runtime/acpProviderModels.js");
    const { builtinConfigFingerprint } =
      await import("../src/agent-runtime/builtin/builtinRuntimeLaunch.js");
    const base = {
      id: "codex-sub",
      name: "Codex (work)",
      runtime: "codex",
      auth: "subscription",
    };
    const saved = await saveBuiltinRuntimeConfig({ ...base, create: true });
    await saveAcpModels("codex-sub", builtinConfigFingerprint(saved), [{ id: "m", name: "M" }]);
    acpAuthStateStore.markAuthenticated("codex-sub");
    await saveBuiltinRuntimeConfig({ ...base, name: "Renamed", enabled: false });
    assert.equal(acpAuthStateStore.get("codex-sub").state, "authenticated");
    assert.equal(
      (await readAcpModelCatalog("codex-sub", builtinConfigFingerprint(saved))).models.length,
      1,
    );
    const status = (await listBuiltinRuntimeStatuses()).statuses.find((s) => s.id === "codex-sub")!;
    assert.equal(status.builtin.enabled, false);
    assert.deepEqual(status.builtin.models, []);
    // 认证方式变化：认证状态重置、同步缓存清空。
    await saveBuiltinRuntimeConfig({ ...base, auth: "cli-login" });
    assert.equal(acpAuthStateStore.get("codex-sub").state, "unknown");
    assert.equal(
      (await readAcpModelCatalog("codex-sub", builtinConfigFingerprint(saved))).models.length,
      0,
    );
  });
});
