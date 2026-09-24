import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import type { AgentConfig } from "../src/agent-runtime/builtin/agentConfigRegistry.js";
import {
  buildBuiltinLaunchEnv,
  CODEX_MODEL_CATALOG_FILE,
  CODEX_PROVIDER_KEY_ENV,
  PI_PROVIDER_KEY_ENV,
} from "../src/agent-runtime/builtin/builtinRuntimeEnv.js";

const SECRET = "sk-test-secret-value-0123456789";
const HOME = "/data/.codez/acp-homes/cfg";
const HOST_ENV: NodeJS.ProcessEnv = {
  PATH: "/usr/bin:/bin",
  HOME: "/home/user",
  LANG: "en_US.UTF-8",
  LC_ALL: "C.UTF-8",
  NO_PROXY: "corp.internal",
  HTTPS_PROXY: "http://proxy.local:3128",
  // 宿主残留的凭据与路由必须一律不进入子进程。
  ANTHROPIC_API_KEY: "host-anthropic-key",
  ANTHROPIC_BASE_URL: "https://host-gateway.invalid",
  CLAUDE_CODE_USE_BEDROCK: "1",
  AWS_BEARER_TOKEN_BEDROCK: "host-bedrock",
  OPENAI_API_KEY: "host-openai-key",
  OPENAI_BASE_URL: "https://host-openai.invalid",
  CODEX_API_KEY: "host-codex-key",
  GITHUB_TOKEN: "host-github-token",
  UNRELATED_SECRET: "nope",
};

function config(
  partial: Partial<AgentConfig> & Pick<AgentConfig, "runtime" | "auth">,
): AgentConfig {
  return { id: "cfg", name: "Test config", ...partial };
}

function assertNoHostSecrets(env: Record<string, string>): void {
  for (const value of [
    "host-anthropic-key",
    "host-bedrock",
    "host-openai-key",
    "host-codex-key",
    "host-github-token",
    "nope",
  ])
    assert.ok(!Object.values(env).includes(value), `host secret leaked: ${value}`);
  assert.equal(env.CLAUDE_CODE_USE_BEDROCK, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
}

function assertSecretOnlyInEnv(
  plan: ReturnType<typeof buildBuiltinLaunchEnv>,
  envName: string,
): void {
  assert.equal(plan.env[envName], SECRET);
  for (const [name, value] of Object.entries(plan.env))
    if (name !== envName) assert.ok(!value.includes(SECRET), `secret copied into ${name}`);
  assert.ok(!plan.args.join(" ").includes(SECRET));
  assert.ok(!plan.files.some((file) => file.content.includes(SECRET)));
  assert.ok(!plan.nativeHome.includes(SECRET));
}

test("Claude BYOK via OpenRouter strips host Anthropic routing and injects the gateway", () => {
  const plan = buildBuiltinLaunchEnv({
    config: config({
      runtime: "claude-code",
      auth: "byok",
      provider: { preset: "openrouter", model: "xiaomi/mimo-v2.6-flash" },
    }),
    hostEnv: HOST_ENV,
    apiKey: SECRET,
    configHome: HOME,
    nativeBinary: "/managed/claude",
  });
  assertNoHostSecrets(plan.env);
  assertSecretOnlyInEnv(plan, "ANTHROPIC_AUTH_TOKEN");
  assert.equal(plan.env.ANTHROPIC_BASE_URL, "https://openrouter.ai/api");
  assert.equal(plan.env.ANTHROPIC_API_KEY, "");
  for (const tier of ["OPUS", "SONNET", "HAIKU"])
    assert.equal(plan.env[`ANTHROPIC_DEFAULT_${tier}_MODEL`], "xiaomi/mimo-v2.6-flash");
  assert.equal(plan.env.CLAUDE_CONFIG_DIR, join(HOME, "claude"));
  assert.equal(plan.env.CLAUDE_CODE_EXECUTABLE, "/managed/claude");
  assert.equal(plan.env.HOME, "/home/user");
  assert.equal(plan.env.LC_ALL, "C.UTF-8");
  assert.equal(plan.env.HTTPS_PROXY, "http://proxy.local:3128");
  assert.equal(plan.env.NO_PROXY, "corp.internal,127.0.0.1,localhost,::1");
  assert.equal(plan.env.no_proxy, "127.0.0.1,localhost,::1");
  // 宿主设置了代理时，Node 适配器也必须走代理。
  assert.equal(plan.env.NODE_USE_ENV_PROXY, "1");
  assert.equal(plan.nativeHome, join(HOME, "claude"));
  assert.equal(plan.problem, undefined);
});

test("Claude BYOK without a saved preset uses the OpenRouter preset the settings page shows", () => {
  const plan = buildBuiltinLaunchEnv({
    config: config({
      runtime: "claude-code",
      auth: "byok",
      provider: { models: [{ id: "deepseek/deepseek-v4.1-flash" }] },
    }),
    hostEnv: HOST_ENV,
    apiKey: SECRET,
    configHome: HOME,
  });
  assertSecretOnlyInEnv(plan, "ANTHROPIC_AUTH_TOKEN");
  assert.equal(plan.env.ANTHROPIC_BASE_URL, "https://openrouter.ai/api");
  assert.equal(plan.env.ANTHROPIC_API_KEY, "");
});

test("Claude GLM preset keeps explicit timeout and small model overrides", () => {
  const plan = buildBuiltinLaunchEnv({
    config: config({
      runtime: "claude-code",
      auth: "byok",
      provider: { preset: "glm", model: "glm-5", smallModel: "glm-5-air", timeoutMs: 1000 },
    }),
    hostEnv: HOST_ENV,
    apiKey: SECRET,
    configHome: HOME,
  });
  assert.equal(plan.env.ANTHROPIC_BASE_URL, "https://open.bigmodel.cn/api/anthropic");
  assert.equal(plan.env.ANTHROPIC_DEFAULT_SONNET_MODEL, "glm-5");
  assert.equal(plan.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "glm-5-air");
  assert.equal(plan.env.API_TIMEOUT_MS, "1000");
});

test("Claude subscription strips every BYOK routing variable, including config-supplied ones", () => {
  const plan = buildBuiltinLaunchEnv({
    config: config({
      runtime: "claude-code",
      auth: "subscription",
      env: { ANTHROPIC_BASE_URL: "https://stray.invalid", DISABLE_TELEMETRY: "1" },
    }),
    hostEnv: HOST_ENV,
    apiKey: SECRET,
    configHome: HOME,
  });
  assertNoHostSecrets(plan.env);
  assert.ok(!Object.keys(plan.env).some((name) => name.startsWith("ANTHROPIC_")));
  assert.ok(!Object.values(plan.env).includes(SECRET));
  assert.equal(plan.env.DISABLE_TELEMETRY, "1");
  assert.equal(plan.env.CLAUDE_CONFIG_DIR, join(HOME, "claude"));
});

test("NODE_USE_ENV_PROXY is only set when the host has a proxy", () => {
  const plan = buildBuiltinLaunchEnv({
    config: config({ runtime: "pi", auth: "byok", provider: { preset: "openrouter" } }),
    hostEnv: { PATH: "/usr/bin", HOME: "/home/user" },
    apiKey: SECRET,
    configHome: HOME,
  });
  assert.equal(plan.env.NODE_USE_ENV_PROXY, undefined);
});

test("cli-login uses the global CLI home and still strips BYOK variables", () => {
  const plan = buildBuiltinLaunchEnv({
    config: config({ runtime: "claude-code", auth: "cli-login" }),
    hostEnv: HOST_ENV,
    apiKey: null,
    configHome: HOME,
  });
  assert.equal(plan.env.CLAUDE_CONFIG_DIR, undefined);
  assert.equal(plan.nativeHome, "global");
  assertNoHostSecrets(plan.env);
});

test("Codex BYOK injects a session model provider without writing the key into CODEX_CONFIG", () => {
  const plan = buildBuiltinLaunchEnv({
    config: config({
      runtime: "codex",
      auth: "byok",
      provider: { preset: "openrouter", model: "xiaomi/mimo-v2.6-flash" },
    }),
    hostEnv: HOST_ENV,
    apiKey: SECRET,
    configHome: HOME,
    nativeBinary: "/managed/codex",
  });
  assertNoHostSecrets(plan.env);
  assertSecretOnlyInEnv(plan, CODEX_PROVIDER_KEY_ENV);
  const codexConfig = JSON.parse(plan.env.CODEX_CONFIG!) as {
    model_provider: string;
    model: string;
    model_providers: Record<string, { base_url: string; env_key: string; wire_api: string }>;
  };
  assert.equal(codexConfig.model_provider, "codez-openrouter");
  assert.equal(codexConfig.model, "xiaomi/mimo-v2.6-flash");
  assert.deepEqual(
    {
      base_url: codexConfig.model_providers["codez-openrouter"]!.base_url,
      env_key: codexConfig.model_providers["codez-openrouter"]!.env_key,
      wire_api: codexConfig.model_providers["codez-openrouter"]!.wire_api,
    },
    {
      base_url: "https://openrouter.ai/api/v1",
      env_key: CODEX_PROVIDER_KEY_ENV,
      wire_api: "responses",
    },
  );
  assert.equal(plan.env.MODEL_PROVIDER, "codez-openrouter");
  // app-server 的登录判定读私有 CODEX_HOME 的 config.toml；只含 env_key 引用，不含密钥。
  // 旧版单模型 `model` 也按一项的模型列表写入目录（见下方 model_catalog_json 用例）。
  assert.deepEqual(
    plan.files.map((file) => file.path),
    [join(HOME, "codex", CODEX_MODEL_CATALOG_FILE), join(HOME, "codex", "config.toml")],
  );
  const toml = plan.files[1]!.content;
  assert.match(toml, /model_provider = "codez-openrouter"/);
  assert.match(toml, /env_key = "CODEZ_CODEX_PROVIDER_KEY"/);
  assert.match(toml, /requires_openai_auth = false/);
  assert.equal(plan.env.CODEX_HOME, join(HOME, "codex"));
  assert.equal(plan.env.CODEX_PATH, "/managed/codex");
  assert.equal(plan.env.OPENAI_API_KEY, undefined);
});

test("Codex subscription has no provider override or API key", () => {
  const plan = buildBuiltinLaunchEnv({
    config: config({ runtime: "codex", auth: "subscription" }),
    hostEnv: HOST_ENV,
    apiKey: null,
    configHome: HOME,
  });
  assert.equal(plan.env.CODEX_CONFIG, undefined);
  assert.equal(plan.env.MODEL_PROVIDER, undefined);
  assert.equal(plan.env[CODEX_PROVIDER_KEY_ENV], undefined);
  assert.equal(plan.env.CODEX_HOME, join(HOME, "codex"));
  // 审计回归：BYOK→订阅切换后必须覆盖旧的托管 config.toml，不能保留 requires_openai_auth=false 的路由。
  assert.equal(plan.files.length, 1);
  assert.equal(plan.files[0]!.path, join(HOME, "codex", "config.toml"));
  assert.doesNotMatch(plan.files[0]!.content, /model_provider|requires_openai_auth/);
});

test("Pi built-in provider passes --provider/--model and only the provider key", () => {
  const plan = buildBuiltinLaunchEnv({
    config: config({
      runtime: "pi",
      auth: "byok",
      provider: { preset: "anthropic", model: "claude-sonnet-5" },
    }),
    hostEnv: HOST_ENV,
    apiKey: SECRET,
    configHome: HOME,
  });
  assertSecretOnlyInEnv(plan, "ANTHROPIC_API_KEY");
  assert.deepEqual(plan.args, ["--provider", "anthropic", "--model", "claude-sonnet-5"]);
  assert.equal(plan.env.PI_CODING_AGENT_DIR, join(HOME, "pi"));
});

test("Pi OpenRouter preset uses the OpenAI-compatible endpoint route", () => {
  const plan = buildBuiltinLaunchEnv({
    config: config({
      runtime: "pi",
      auth: "byok",
      provider: { preset: "openrouter", model: "xiaomi/mimo-v2.6-flash" },
    }),
    hostEnv: HOST_ENV,
    apiKey: SECRET,
    configHome: HOME,
  });
  assertSecretOnlyInEnv(plan, PI_PROVIDER_KEY_ENV);
  const models = JSON.parse(plan.files[0]!.content) as {
    providers: Record<string, { baseUrl: string; api: string }>;
  };
  assert.equal(models.providers.codez?.baseUrl, "https://openrouter.ai/api/v1");
  assert.equal(models.providers.codez?.api, "openai-completions");
  assert.deepEqual(plan.args, ["--provider", "codez", "--model", "xiaomi/mimo-v2.6-flash"]);
});

test("Pi custom endpoint writes models.json with an env reference, never the key", () => {
  const plan = buildBuiltinLaunchEnv({
    config: config({
      runtime: "pi",
      auth: "byok",
      provider: {
        preset: "custom",
        baseUrl: "http://127.0.0.1:9999",
        api: "anthropic-messages",
        model: "replay",
      },
    }),
    hostEnv: HOST_ENV,
    apiKey: SECRET,
    configHome: HOME,
  });
  assertSecretOnlyInEnv(plan, PI_PROVIDER_KEY_ENV);
  assert.equal(plan.files.length, 1);
  assert.equal(plan.files[0]!.path, join(HOME, "pi", "models.json"));
  const models = JSON.parse(plan.files[0]!.content) as {
    providers: Record<string, { baseUrl: string; api: string; apiKey: string }>;
  };
  assert.deepEqual(models.providers.codez, {
    baseUrl: "http://127.0.0.1:9999",
    api: "anthropic-messages",
    apiKey: `$${PI_PROVIDER_KEY_ENV}`,
    // 默认按推理模型写入，只提供 low/medium/high（minimal 标记为不支持）。
    models: [{ id: "replay", reasoning: true, thinkingLevelMap: { minimal: null } }],
  });
  assert.deepEqual(plan.args, ["--provider", "codez", "--model", "replay"]);
});

test("BYOK without a stored key reports a problem instead of launching", () => {
  for (const runtime of ["claude-code", "codex", "pi"] as const) {
    const plan = buildBuiltinLaunchEnv({
      config: config({ runtime, auth: "byok", provider: { preset: "openrouter" } }),
      hostEnv: HOST_ENV,
      apiKey: null,
      configHome: HOME,
    });
    assert.match(plan.problem ?? "", /API key is required/);
  }
});

test("Codex provider IDs never collide with Codex built-in providers", () => {
  for (const providerId of ["openai", "ollama", "lmstudio", "oss"]) {
    const plan = buildBuiltinLaunchEnv({
      config: config({
        runtime: "codex",
        auth: "byok",
        provider: { preset: "custom", baseUrl: "https://gw.example/v1", providerId },
      }),
      hostEnv: HOST_ENV,
      apiKey: SECRET,
      configHome: HOME,
    });
    assert.equal(plan.env.MODEL_PROVIDER, `codez-${providerId}`);
  }
});

test("subprocess env scrubbing stays opt-in (it needs bubblewrap on Linux)", () => {
  const plan = buildBuiltinLaunchEnv({
    config: config({
      runtime: "claude-code",
      auth: "byok",
      provider: { preset: "openrouter" },
      env: { CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1" },
    }),
    hostEnv: HOST_ENV,
    apiKey: SECRET,
    configHome: HOME,
  });
  assert.equal(plan.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, "1");
  const defaults = buildBuiltinLaunchEnv({
    config: config({ runtime: "claude-code", auth: "subscription" }),
    hostEnv: HOST_ENV,
    apiKey: null,
    configHome: HOME,
  });
  assert.equal(defaults.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, undefined);
});

test("subscription mode also strips CLAUDE_CODE_API_BASE_URL from config env", () => {
  const plan = buildBuiltinLaunchEnv({
    config: config({
      runtime: "claude-code",
      auth: "subscription",
      env: { CLAUDE_CODE_API_BASE_URL: "https://stray.invalid" },
    }),
    hostEnv: HOST_ENV,
    apiKey: null,
    configHome: HOME,
  });
  assert.equal(plan.env.CLAUDE_CODE_API_BASE_URL, undefined);
});

const MODELS = [
  { id: "deepseek/deepseek-v4.1-flash" },
  {
    id: "xiaomi/mimo-v2.6-flash",
    name: "MiMo",
    reasoningLevels: ["low", "high", "max"] as Array<"low" | "high" | "max">,
    contextWindow: 262_144,
    maxTokens: 32_000,
    vision: true,
  },
  { id: "qwen/qwen3-coder", reasoning: false, enabled: false },
];

test("Claude maps configured models to its model slots", () => {
  const plan = buildBuiltinLaunchEnv({
    config: config({
      runtime: "claude-code",
      auth: "byok",
      provider: { preset: "openrouter", models: MODELS },
    }),
    hostEnv: HOST_ENV,
    apiKey: SECRET,
    configHome: HOME,
  });
  assert.equal(plan.env.ANTHROPIC_DEFAULT_OPUS_MODEL, "deepseek/deepseek-v4.1-flash");
  assert.equal(plan.env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME, "deepseek/deepseek-v4.1-flash");
  assert.equal(plan.env.ANTHROPIC_DEFAULT_SONNET_MODEL, "xiaomi/mimo-v2.6-flash");
  assert.equal(plan.env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME, "MiMo");
  assert.equal(plan.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "qwen/qwen3-coder");
  // 能力变量不影响 2.1.280 对网关模型的请求形态，不写入，避免误导。
  assert.ok(!Object.keys(plan.env).some((name) => name.endsWith("_SUPPORTED_CAPABILITIES")));
  assert.equal(plan.env.ANTHROPIC_DEFAULT_FABLE_MODEL, undefined);
  assert.equal(plan.env.ANTHROPIC_CUSTOM_MODEL_OPTION, undefined);
  // 后台小任务仍走首个模型（未设 smallModel 时）。
  assert.equal(plan.env.ANTHROPIC_SMALL_FAST_MODEL, "deepseek/deepseek-v4.1-flash");

  const single = buildBuiltinLaunchEnv({
    config: config({
      runtime: "claude-code",
      auth: "byok",
      provider: { preset: "openrouter", models: [{ id: "only/model" }] },
    }),
    hostEnv: HOST_ENV,
    apiKey: SECRET,
    configHome: HOME,
  });
  // 未占用的 sonnet/haiku 槽指向首个模型，别名不会落到网关不认识的 Claude 官方模型名。
  assert.equal(single.env.ANTHROPIC_DEFAULT_SONNET_MODEL, "only/model");
  assert.equal(single.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "only/model");
  assert.equal(single.env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME, undefined);
});

test("Codex BYOK writes a model catalog of exactly the configured models", () => {
  const plan = buildBuiltinLaunchEnv({
    config: config({
      runtime: "codex",
      auth: "byok",
      provider: { preset: "openrouter", models: MODELS },
    }),
    hostEnv: HOST_ENV,
    apiKey: SECRET,
    configHome: HOME,
  });
  assertSecretOnlyInEnv(plan, CODEX_PROVIDER_KEY_ENV);
  const catalogPath = join(HOME, "codex", CODEX_MODEL_CATALOG_FILE);
  const toml = plan.files.find((file) => file.path.endsWith("config.toml"))!.content;
  assert.match(toml, new RegExp(`model_catalog_json = ${JSON.stringify(catalogPath)}`));
  // 默认模型是第一个启用的模型；禁用的模型仍在目录中，保证其选项 ID 稳定。
  assert.match(toml, /^model = "deepseek\/deepseek-v4.1-flash"$/m);
  const catalog = JSON.parse(plan.files.find((file) => file.path === catalogPath)!.content) as {
    models: Array<Record<string, unknown>>;
  };
  assert.deepEqual(
    catalog.models.map((model) => model.slug),
    MODELS.map((model) => model.id),
  );
  const [first, second, third] = catalog.models;
  assert.deepEqual(
    (first!.supported_reasoning_levels as Array<{ effort: string }>).map((level) => level.effort),
    ["low", "medium", "high"],
  );
  assert.equal(first!.default_reasoning_level, "medium");
  assert.equal(first!.visibility, "list");
  assert.equal(first!.context_window, 272_000);
  assert.deepEqual(first!.input_modalities, ["text", "image"]);
  assert.match(
    String(first!.base_instructions),
    /^You are a coding agent running in the Codex CLI/,
  );
  assert.equal(second!.display_name, "MiMo");
  assert.deepEqual(
    (second!.supported_reasoning_levels as Array<{ effort: string }>).map((level) => level.effort),
    ["low", "high", "max"],
  );
  assert.equal(second!.default_reasoning_level, "low");
  assert.equal(second!.context_window, 262_144);
  assert.deepEqual(third!.supported_reasoning_levels, []);
  assert.equal(third!.default_reasoning_level, undefined);

  const subscription = buildBuiltinLaunchEnv({
    config: config({ runtime: "codex", auth: "subscription", provider: { models: MODELS } }),
    hostEnv: HOST_ENV,
    apiKey: null,
    configHome: HOME,
  });
  // 订阅配置保持 Codex 原生目录。
  assert.ok(!subscription.files.some((file) => file.path.endsWith(CODEX_MODEL_CATALOG_FILE)));
  assert.doesNotMatch(subscription.files[0]!.content, /model_catalog_json/);
});

test("Pi models.json lists every configured model with reasoning on by default and honours overrides", () => {
  const plan = buildBuiltinLaunchEnv({
    config: config({
      runtime: "pi",
      auth: "byok",
      provider: { preset: "openrouter", models: MODELS },
    }),
    hostEnv: HOST_ENV,
    apiKey: SECRET,
    configHome: HOME,
  });
  const models = JSON.parse(plan.files[0]!.content) as {
    providers: { codez: { models: Array<Record<string, unknown>> } };
  };
  assert.deepEqual(models.providers.codez.models, [
    { id: "deepseek/deepseek-v4.1-flash", reasoning: true, thinkingLevelMap: { minimal: null } },
    {
      id: "xiaomi/mimo-v2.6-flash",
      name: "MiMo",
      reasoning: true,
      thinkingLevelMap: { minimal: null, medium: null, max: "max" },
      input: ["text", "image"],
      contextWindow: 262_144,
      maxTokens: 32_000,
    },
    { id: "qwen/qwen3-coder", reasoning: false },
  ]);
  assert.deepEqual(plan.args, ["--provider", "codez", "--model", "deepseek/deepseek-v4.1-flash"]);
  const empty = buildBuiltinLaunchEnv({
    config: config({ runtime: "pi", auth: "byok", provider: { preset: "openrouter", models: [] } }),
    hostEnv: HOST_ENV,
    apiKey: SECRET,
    configHome: HOME,
  });
  assert.equal(empty.problem, "A model is required for a custom Pi endpoint");
});
