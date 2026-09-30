import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  deleteAgentConfig,
  getAgentConfigsPath,
  parseAgentConfig,
  readAgentConfigs,
  saveAgentConfig,
} from "../src/agent-runtime/builtin/agentConfigRegistry.js";
import { builtinConfigFingerprint } from "../src/agent-runtime/builtin/builtinRuntimeLaunch.js";
import { resolveAcpRuntimeSpec } from "../src/agent-runtime/acpRuntimeCatalog.js";
import { readAgentServersRegistry } from "../src/agent-runtime/agentServersRegistry.js";
import { setDataBaseDir } from "../src/paths.js";

async function withDataDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "codez-agent-configs-"));
  setDataBaseDir(dir);
  try {
    await run(dir);
  } finally {
    setDataBaseDir(null);
    await rm(dir, { recursive: true, force: true });
  }
}

test("default built-in configs exist without a file and resolve as builtin specs", async () => {
  await withDataDir(async () => {
    const snapshot = await readAgentConfigs();
    assert.deepEqual(
      snapshot.configs.map((config) => [config.id, config.runtime, config.auth]),
      [
        ["claude-code", "claude-code", "subscription"],
        ["codex", "codex", "subscription"],
        ["pi", "pi", "byok"],
      ],
    );
    const spec = await resolveAcpRuntimeSpec("codex");
    assert.equal(spec?.distribution, "builtin");
    assert.equal(spec?.command, process.execPath);
    assert.equal(spec?.builtin?.runtime, "codex");
  });
});

test("config validation rejects secret-like env, reserved env, unknown presets and auth modes", () => {
  const base = { name: "X", runtime: "claude-code", auth: "byok" };
  assert.match(
    String(parseAgentConfig("x", { ...base, env: { MY_API_KEY: "v" } })),
    /looks secret/,
  );
  assert.match(
    String(parseAgentConfig("x", { ...base, env: { CLAUDE_CONFIG_DIR: "/tmp" } })),
    /managed by CodeZ/,
  );
  assert.match(
    String(parseAgentConfig("x", { ...base, provider: { preset: "nope" } })),
    /Unknown claude-code provider preset/,
  );
  assert.match(
    String(parseAgentConfig("x", { ...base, runtime: "pi", auth: "subscription" })),
    /Auth mode/,
  );
  assert.match(
    String(parseAgentConfig("x", { ...base, provider: { baseUrl: "file:///etc" } })),
    /absolute http/,
  );
  assert.match(
    String(parseAgentConfig("x", { ...base, apiKey: "inline" })),
    /Unknown configuration key/,
  );
  assert.match(String(parseAgentConfig("zcode-cli", base)), /reserved/);
  const valid = parseAgentConfig("claude-or", {
    ...base,
    provider: { preset: "openrouter", model: "m" },
    env: { DISABLE_TELEMETRY: "1" },
  });
  assert.equal(typeof valid, "object");
});

test("saving keeps secrets out of the file, isolates invalid entries and restores defaults on delete", async () => {
  await withDataDir(async () => {
    await saveAgentConfig({
      id: "claude-openrouter",
      name: "Claude via OpenRouter",
      runtime: "claude-code",
      auth: "byok",
      provider: { preset: "openrouter", model: "xiaomi/mimo-v2.6-flash" },
    });
    await saveAgentConfig({ id: "codex", name: "My Codex", runtime: "codex", auth: "cli-login" });
    const raw = await readFile(getAgentConfigsPath(), "utf8");
    assert.ok(!/apiKey|sk-/.test(raw));
    // 手工写入一条坏条目：只隔离它，不影响其他配置。
    const document = JSON.parse(raw) as { agents: Record<string, unknown> };
    document.agents.broken = { name: "Broken", runtime: "nope", auth: "byok" };
    await writeFile(getAgentConfigsPath(), JSON.stringify(document));
    const snapshot = await readAgentConfigs();
    assert.deepEqual(
      snapshot.issues.map((issue) => issue.id),
      ["broken"],
    );
    const codex = snapshot.configs.find((config) => config.id === "codex");
    assert.equal(codex?.auth, "cli-login");
    assert.ok(snapshot.configs.some((config) => config.id === "claude-openrouter"));

    await deleteAgentConfig("codex");
    const restored = (await readAgentConfigs()).configs.find((config) => config.id === "codex");
    assert.equal(restored?.auth, "subscription");
    assert.equal(restored?.builtinDefault, true);
  });
});

test("fingerprint identifies the native home, not provider routing", () => {
  const a = {
    id: "c",
    name: "C",
    runtime: "claude-code" as const,
    auth: "byok" as const,
    provider: { baseUrl: "https://a.example" },
  };
  const b = { ...a, provider: { baseUrl: "https://b.example" } };
  assert.equal(builtinConfigFingerprint(a), builtinConfigFingerprint(b));
  assert.notEqual(
    builtinConfigFingerprint(a),
    builtinConfigFingerprint({ ...a, auth: "cli-login" }),
  );
});

test("agent_servers can no longer claim built-in runtime IDs", async () => {
  await withDataDir(async (dir) => {
    await mkdir(join(dir, ".codez", "v2"), { recursive: true });
    await writeFile(
      join(dir, ".codez", "v2", "agent-servers.json"),
      JSON.stringify({
        agent_servers: { codex: { name: "Codex", command: process.execPath, args: [] } },
      }),
    );
    const registry = await readAgentServersRegistry();
    assert.deepEqual(registry.servers, []);
    assert.equal(registry.issues[0]?.id, "codex");
  });
});

test("non-secret *_TOKENS variables are allowed; key/token names are refused", () => {
  const base = { name: "X", runtime: "claude-code", auth: "byok" };
  for (const name of ["MAX_THINKING_TOKENS", "CLAUDE_CODE_MAX_OUTPUT_TOKENS", "DISABLE_TELEMETRY"])
    assert.equal(typeof parseAgentConfig("x", { ...base, env: { [name]: "1" } }), "object", name);
  for (const name of ["OPENAI_API_KEY", "ANTHROPIC_AUTH_TOKEN", "MY_SECRET", "DB_PASSWORD"])
    assert.match(
      String(parseAgentConfig("x", { ...base, env: { [name]: "v" } })),
      /looks secret/,
      name,
    );
});

test("legacy ACP IDs stay reserved for session restore", () => {
  for (const id of ["qoder-acp", "cline-acp", "codebuddy-acp", "workbuddy-acp", "zcode-cli"])
    assert.match(
      String(parseAgentConfig(id, { name: "X", runtime: "codex", auth: "subscription" })),
      /reserved/,
    );
});

test("an invalid override of a default ID disables that ID instead of reviving the default", async () => {
  await withDataDir(async (dir) => {
    await mkdir(join(dir, ".codez", "v2"), { recursive: true });
    await writeFile(
      getAgentConfigsPath(),
      JSON.stringify({
        agents: { "claude-code": { name: "Mine", runtime: "claude-code", auth: "nope" } },
      }),
    );
    const snapshot = await readAgentConfigs();
    assert.ok(!snapshot.configs.some((config) => config.id === "claude-code"));
    assert.deepEqual(
      snapshot.issues.map((issue) => issue.id),
      ["claude-code"],
    );
    assert.equal(await resolveAcpRuntimeSpec("claude-code"), null);
    // 不可读 / 结构错误的文件：全部失败关闭，不回退默认订阅配置。
    await writeFile(getAgentConfigsPath(), "{not json");
    assert.deepEqual((await readAgentConfigs()).configs, []);
  });
});
