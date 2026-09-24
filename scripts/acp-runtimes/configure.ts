// Create or update a built-in ACP runtime configuration (the backend path the app uses; no new UI).
// The API key is read from stdin so it never appears in argv, shell history or files:
//
//   read -rs KEY; printf %s "$KEY" | node --import tsx scripts/acp-runtimes/configure.ts \
//     claude-openrouter --runtime claude-code --auth byok --preset openrouter \
//     --model xiaomi/mimo-v2.6-flash --key-stdin; unset KEY
//
//   node --import tsx scripts/acp-runtimes/configure.ts codex --runtime codex --auth subscription
//   node --import tsx scripts/acp-runtimes/configure.ts --list
//   node --import tsx scripts/acp-runtimes/configure.ts claude-openrouter --delete
//
// Run from packages/services. ZCODE_DATA_BASE_DIR selects a non-default data root.
import { parseArgs } from "node:util";
import { readAgentConfigs } from "../../packages/services/src/agent-runtime/builtin/agentConfigRegistry.ts";
import {
  deleteBuiltinRuntimeConfig,
  saveBuiltinRuntimeConfig,
} from "../../packages/services/src/agent-runtime/builtin/builtinRuntimeService.ts";
import { listBuiltinRuntimeStatuses } from "../../packages/services/src/agent-runtime/builtin/builtinRuntimeStatus.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: "string" },
    runtime: { type: "string" },
    auth: { type: "string" },
    preset: { type: "string" },
    "base-url": { type: "string" },
    model: { type: "string" },
    "small-model": { type: "string" },
    "provider-id": { type: "string" },
    "wire-api": { type: "string" },
    api: { type: "string" },
    "key-stdin": { type: "boolean", default: false },
    "clear-key": { type: "boolean", default: false },
    delete: { type: "boolean", default: false },
    list: { type: "boolean", default: false },
  },
});

if (values.list) {
  const { statuses, issues } = await listBuiltinRuntimeStatuses();
  for (const status of statuses)
    console.log(
      `${status.id.padEnd(24)} ${status.builtin.runtime.padEnd(12)} auth=${status.builtin.authMode.padEnd(12)} ` +
        `key=${status.builtin.hasApiKey ? "yes" : "no "} installed=${status.builtin.managedInstalled ? "yes" : "no "}` +
        `${status.reason ? `  (${status.reason})` : ""}`,
    );
  for (const issue of issues) console.log(`INVALID ${issue.id}: ${issue.message}`);
  process.exit(0);
}
const id = positionals[0];
if (!id)
  throw new Error(
    "usage: configure.ts <id> --runtime <claude-code|codex|pi> --auth <byok|subscription|cli-login> ...",
  );
if (values.delete) {
  await deleteBuiltinRuntimeConfig(id);
  console.log(`deleted ${id}`);
  process.exit(0);
}
const existing = (await readAgentConfigs()).configs.find((config) => config.id === id);
const runtime = values.runtime ?? existing?.runtime;
const auth = values.auth ?? existing?.auth;
if (!runtime || !auth) throw new Error("--runtime and --auth are required for a new config");
let apiKey: string | null | undefined;
if (values["key-stdin"]) {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  apiKey = Buffer.concat(chunks).toString("utf8").trim();
  if (!apiKey) throw new Error("--key-stdin was given but stdin was empty");
} else if (values["clear-key"]) apiKey = null;
const provider = {
  ...existing?.provider,
  ...(values.preset ? { preset: values.preset } : {}),
  ...(values["base-url"] ? { baseUrl: values["base-url"] } : {}),
  ...(values.model ? { model: values.model } : {}),
  ...(values["small-model"] ? { smallModel: values["small-model"] } : {}),
  ...(values["provider-id"] ? { providerId: values["provider-id"] } : {}),
  ...(values["wire-api"] ? { wireApi: values["wire-api"] as "responses" | "chat" } : {}),
  ...(values.api
    ? { api: values.api as "anthropic-messages" | "openai-responses" | "openai-completions" }
    : {}),
};
const saved = await saveBuiltinRuntimeConfig({
  id,
  name: values.name ?? existing?.name ?? id,
  runtime,
  auth,
  ...(Object.keys(provider).length ? { provider } : {}),
  ...(existing?.env ? { env: existing.env } : {}),
  ...(apiKey !== undefined ? { apiKey } : {}),
});
console.log(
  `saved ${saved.id} (${saved.runtime}, auth=${saved.auth})${apiKey ? ", API key stored encrypted" : ""}`,
);
