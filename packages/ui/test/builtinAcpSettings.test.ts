import assert from "node:assert/strict";
import test from "node:test";
import type { BuiltinRuntimeCatalogEntry } from "@zcode/services";
import {
  configFromStatus,
  configModels,
  createDraft,
  createInput,
  effectiveBaseUrl,
  modelDraft,
  modelFromDraft,
  reorderModels,
  suggestIdentity,
  toSaveInput,
  validateBaseUrl,
  validateCreate,
  validateModelDraft,
  withBaseUrl,
  withModels,
  withPreset,
  type BuiltinAcpStatus,
} from "../src/settings/model-provider-section/builtinAcpConfig.js";
import {
  isOpenableSignInUrl,
  parseSignInMessage,
  signInNeedsTerminal,
  signInScriptCommand,
} from "../src/settings/model-provider-section/builtinAcpSignInMessage.js";

const LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
const DEFAULT_LEVELS = ["low", "medium", "high"] as const;

const PI: BuiltinRuntimeCatalogEntry = {
  runtime: "pi",
  name: "Pi",
  version: "x",
  authModes: ["byok", "cli-login"],
  presets: [
    {
      id: "openrouter",
      name: "OpenRouter",
      baseUrl: "https://openrouter.ai/api/v1",
      requiresBaseUrl: false,
      baseUrlEditable: true,
      requiresModel: true,
    },
    {
      id: "anthropic",
      name: "Anthropic",
      requiresBaseUrl: false,
      baseUrlEditable: false,
      requiresModel: false,
    },
    {
      id: "custom",
      name: "Custom endpoint",
      requiresBaseUrl: true,
      baseUrlEditable: true,
      requiresModel: true,
      apiOptions: ["openai-completions", "openai-responses", "anthropic-messages"],
      defaultApi: "openai-completions",
    },
  ],
  signIn: false,
  deviceSignIn: false,
  maxModels: 64,
  modelFields: { contextWindow: true, maxTokens: true, vision: true, reasoning: true },
  reasoningLevels: LEVELS,
  defaultReasoningLevels: DEFAULT_LEVELS,
};

const CLAUDE: BuiltinRuntimeCatalogEntry = {
  ...PI,
  runtime: "claude-code",
  name: "Claude Code",
  authModes: ["subscription", "byok", "cli-login"],
  signIn: true,
  maxModels: 5,
  modelFields: { contextWindow: false, maxTokens: false, vision: false, reasoning: false },
};

function status(builtin: Partial<BuiltinAcpStatus["builtin"]>): BuiltinAcpStatus {
  return {
    id: "pi",
    name: "Pi",
    installed: true,
    command: "built-in Pi",
    builtin: {
      runtime: "pi",
      version: "x",
      managedInstalled: true,
      authMode: "byok",
      authState: "auth-required",
      authMethods: [],
      hasApiKey: false,
      models: [],
      enabled: true,
      isDefault: true,
      ...builtin,
    },
  };
}

test("the saved config is rebuilt from the Host status without any key material", () => {
  const config = configFromStatus(
    status({ provider: { preset: "openrouter", model: "legacy/model" }, hasApiKey: true }),
  );
  assert.deepEqual(toSaveInput(config), {
    id: "pi",
    name: "Pi",
    runtime: "pi",
    auth: "byok",
    provider: { preset: "openrouter", model: "legacy/model" },
    enabled: true,
  });
  // 旧版单模型视为一项；保存模型列表时去掉 `model`，列表成为唯一来源。
  assert.deepEqual(configModels(config), [{ id: "legacy/model" }]);
  assert.deepEqual(withModels(config, [{ id: "a" }]).provider, {
    preset: "openrouter",
    models: [{ id: "a" }],
  });
  assert.deepEqual(toSaveInput(config, { apiKey: null }).apiKey, null);
});

test("presets prefill the endpoint and switching presets drops the old route but keeps models", () => {
  const config = configFromStatus(
    status({
      provider: {
        preset: "custom",
        baseUrl: "http://127.0.0.1:9",
        api: "anthropic-messages",
        providerId: "old",
        models: [{ id: "m" }],
      },
    }),
  );
  assert.equal(effectiveBaseUrl(config, PI), "http://127.0.0.1:9");
  const switched = withPreset(config, "openrouter");
  assert.deepEqual(switched.provider, { preset: "openrouter", models: [{ id: "m" }] });
  assert.equal(effectiveBaseUrl(switched, PI), "https://openrouter.ai/api/v1");
  // 与预设默认值相同或为空的端点不保存覆盖值。
  assert.equal(
    withBaseUrl(switched, PI, " https://openrouter.ai/api/v1 ").provider?.baseUrl,
    undefined,
  );
  assert.equal(
    withBaseUrl(switched, PI, "https://gw.example/v1").provider?.baseUrl,
    "https://gw.example/v1",
  );
  assert.equal(validateBaseUrl(PI, "custom", ""), "baseUrlRequired");
  assert.equal(validateBaseUrl(PI, "custom", "ftp://x"), "baseUrlInvalid");
  assert.equal(validateBaseUrl(PI, "openrouter", ""), null);
});

test("model drafts validate per runtime and only persist the fields the runtime uses", () => {
  const models = [{ id: "a/one", slot: 0 }, { id: "b/two" }];
  const draft = { ...modelDraft(PI), id: "c/three", contextWindow: "abc" };
  assert.equal(validateModelDraft({ draft, entry: PI, models }), "contextWindowInvalid");
  assert.equal(
    validateModelDraft({ draft: { ...draft, contextWindow: "", id: "a/one" }, entry: PI, models }),
    "modelIdTaken",
  );
  assert.equal(
    validateModelDraft({
      draft: { ...draft, contextWindow: "", id: "a/one" },
      entry: PI,
      models,
      editingIndex: 0,
    }),
    null,
  );
  assert.equal(
    validateModelDraft({ draft: { ...draft, id: "has space" }, entry: PI, models }),
    "modelIdInvalid",
  );
  assert.equal(
    validateModelDraft({
      draft: { ...draft, contextWindow: "", reasoningLevels: [] },
      entry: PI,
      models,
    }),
    "reasoningLevelsRequired",
  );
  const full = Array.from({ length: 5 }, (_, index) => ({ id: `m${index}` }));
  assert.equal(
    validateModelDraft({ draft: { ...modelDraft(CLAUDE), id: "x" }, entry: CLAUDE, models: full }),
    "tooManyModels",
  );
  // 默认档位不写入；关闭推理写 false；视觉/上下文只在支持的 Runtime 写入；保留槽位与启停。
  assert.deepEqual(
    modelFromDraft(
      { ...modelDraft(PI), id: " x/y ", name: "X", contextWindow: "131072", vision: true },
      PI,
      { id: "old", enabled: false, slot: 3 },
    ),
    { id: "x/y", name: "X", enabled: false, slot: 3, contextWindow: 131_072, vision: true },
  );
  assert.deepEqual(
    modelFromDraft({ ...modelDraft(PI), id: "x", reasoningLevels: ["high", "low"] }, PI),
    { id: "x", reasoningLevels: ["low", "high"] },
  );
  assert.deepEqual(modelFromDraft({ ...modelDraft(PI), id: "x", reasoning: false }, PI), {
    id: "x",
    reasoning: false,
  });
  assert.deepEqual(
    modelFromDraft({ ...modelDraft(CLAUDE), id: "x", contextWindow: "1000", vision: true }, CLAUDE),
    { id: "x" },
  );
  assert.deepEqual(
    reorderModels(models, ["b/two", "a/one"]).map((model) => model.id),
    ["b/two", "a/one"],
  );
});

test("the create flow suggests a free identity and requires what the runtime needs", () => {
  const draft = createDraft(PI);
  assert.equal(draft.auth, "byok");
  assert.equal(draft.preset, "openrouter");
  assert.equal(draft.baseUrl, "https://openrouter.ai/api/v1");
  assert.deepEqual(suggestIdentity(PI, draft, "OpenRouter", ["pi", "pi-openrouter"]), {
    id: "pi-openrouter-2",
    name: "Pi (OpenRouter)",
  });
  const named = { ...draft, id: "pi-openrouter-2", name: "Pi (OpenRouter)" };
  assert.equal(validateCreate({ ...named, id: "Bad" }, PI, []), "idInvalid");
  assert.equal(validateCreate(named, PI, ["pi-openrouter-2"]), "idTaken");
  assert.equal(validateCreate(named, PI, []), "modelRequired");
  assert.equal(validateCreate({ ...named, model: "m" }, PI, []), "apiKeyRequired");
  const ready = { ...named, model: "m", apiKey: " sk-1 " };
  assert.equal(validateCreate(ready, PI, []), null);
  assert.deepEqual(createInput(ready, PI), {
    id: "pi-openrouter-2",
    name: "Pi (OpenRouter)",
    runtime: "pi",
    auth: "byok",
    provider: { preset: "openrouter", models: [{ id: "m" }] },
    enabled: true,
    apiKey: "sk-1",
    create: true,
  });
  const custom = { ...ready, preset: "custom", baseUrl: "http://127.0.0.1:9", api: "" as const };
  assert.deepEqual(createInput(custom, PI).provider, {
    preset: "custom",
    baseUrl: "http://127.0.0.1:9",
    api: "openai-completions",
    models: [{ id: "m" }],
  });
  const subscription = createDraft(CLAUDE);
  assert.equal(subscription.auth, "byok");
  assert.deepEqual(
    createInput({ ...subscription, id: "cc-sub", name: "CC", auth: "subscription" }, CLAUDE),
    {
      id: "cc-sub",
      name: "CC",
      runtime: "claude-code",
      auth: "subscription",
      enabled: true,
      create: true,
    },
  );
});

test("sign-in messages render URLs as links and device codes as selectable codes", () => {
  const message =
    "\u001b[94mFollow these steps\u001b[0m\n1. Open https://auth.example.com/device.\n2. Enter this one-time code ABCD-1234\n\nNever share it.";
  assert.deepEqual(parseSignInMessage(message), [
    [{ kind: "text", text: "Follow these steps" }],
    [
      { kind: "text", text: "1. Open " },
      { kind: "url", url: "https://auth.example.com/device" },
      { kind: "text", text: "." },
    ],
    [
      { kind: "text", text: "2. Enter this one-time code " },
      { kind: "code", code: "ABCD-1234" },
    ],
    [{ kind: "text", text: "Never share it." }],
  ]);
  // URL 内部的大写片段不当作设备码。
  assert.deepEqual(parseSignInMessage("https://x.example/?code=ABCD-1234"), [
    [{ kind: "url", url: "https://x.example/?code=ABCD-1234" }],
  ]);
  assert.equal(
    signInNeedsTerminal(
      "Sign-in failed: Log in needs an interactive terminal on this host; run scripts/acp-runtimes/login.ts cc",
    ),
    true,
  );
  assert.equal(signInNeedsTerminal("Signed out"), false);
  assert.equal(signInScriptCommand("cc"), "node --import tsx scripts/acp-runtimes/login.ts cc");
  assert.equal(isOpenableSignInUrl("https://auth.example.com"), true);
  assert.equal(isOpenableSignInUrl("javascript:alert(1)"), false);
  assert.equal(isOpenableSignInUrl("file:///etc/passwd"), false);
});
