import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import type { AgentConfig } from "../src/agent-runtime/builtin/agentConfigRegistry.js";
import {
  buildBuiltinLaunchEnv,
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
  assert.equal(plan.nativeHome, join(HOME, "claude"));
  assert.equal(plan.problem, undefined);
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
  assert.equal(codexConfig.model_provider, "openrouter");
  assert.equal(codexConfig.model, "xiaomi/mimo-v2.6-flash");
  assert.deepEqual(
    {
      base_url: codexConfig.model_providers.openrouter!.base_url,
      env_key: codexConfig.model_providers.openrouter!.env_key,
      wire_api: codexConfig.model_providers.openrouter!.wire_api,
    },
    {
      base_url: "https://openrouter.ai/api/v1",
      env_key: CODEX_PROVIDER_KEY_ENV,
      wire_api: "responses",
    },
  );
  assert.equal(plan.env.MODEL_PROVIDER, "openrouter");
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
});

test("Pi built-in provider passes --provider/--model and only the provider key", () => {
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
  assertSecretOnlyInEnv(plan, "OPENROUTER_API_KEY");
  assert.deepEqual(plan.args, ["--provider", "openrouter", "--model", "xiaomi/mimo-v2.6-flash"]);
  assert.equal(plan.env.PI_CODING_AGENT_DIR, join(HOME, "pi"));
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
    models: [{ id: "replay" }],
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
