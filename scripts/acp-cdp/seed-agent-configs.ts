// Seeds built-in ACP agent configurations into a throwaway CodeZ data dir with the app's own
// registry and encrypted credential store (the same modules the Host uses at runtime).
//
// Input is read from stdin as JSON so the API key never appears in argv, env dumps or logs:
//   { "dataDir": "...", "configs": [AgentConfigInput...], "apiKey": "...", "apiKeyFor": ["id"],
//     "discoverModelCatalogFor": ["id"], "workspace": "/abs/path" }
// Must run with the same HOME as the app: the credential cipher key is derived from homedir().
//
// `discoverModelCatalogFor` is only used by the opt-in --seed-model-catalog workaround. It runs the
// app's own discoverAcpRuntimeConfig() WITHOUT the per-model thought-level probing that breaks the
// Settings sync for Codex, then saves the advertised models with the app's saveAcpModels() and
// enables the model the runtime reports as selected — what the Settings sync + one toggle would
// have stored if the probing loop did not fail.
import { discoverAcpRuntimeConfig } from "../../packages/services/src/agent-runtime/acpConfigDiscovery.ts";
import { saveAcpModels } from "../../packages/services/src/agent-runtime/acpProviderModels.ts";
import { resolveAcpRuntimeLaunch } from "../../packages/services/src/agent-runtime/acpRuntimeCatalog.ts";
import {
  findAgentConfig,
  saveAgentConfig,
} from "../../packages/services/src/agent-runtime/builtin/agentConfigRegistry.ts";
import type { AgentConfigInput } from "../../packages/services/src/agent-runtime/builtin/agentConfigRegistry.ts";
import {
  builtinConfigFingerprint,
  saveBuiltinConfigApiKey,
} from "../../packages/services/src/agent-runtime/builtin/builtinRuntimeLaunch.ts";
import { setDataBaseDir } from "../../packages/services/src/paths.ts";

interface SeedInput {
  dataDir: string;
  configs: AgentConfigInput[];
  apiKey?: string;
  apiKeyFor?: string[];
  discoverModelCatalogFor?: string[];
  workspace?: string;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const input = JSON.parse(await readStdin()) as SeedInput;
if (!input.dataDir) throw new Error("dataDir is required");
if (process.env.ZCODE_CREDENTIAL_SECRET)
  throw new Error("ZCODE_CREDENTIAL_SECRET must not be set: the app would derive a different key");
setDataBaseDir(input.dataDir);
const saved: string[] = [];
for (const config of input.configs) {
  await saveAgentConfig(config);
  saved.push(config.id);
}
const withKey: string[] = [];
for (const id of input.apiKeyFor ?? []) {
  if (!input.apiKey) throw new Error("apiKeyFor requires apiKey");
  await saveBuiltinConfigApiKey(id, input.apiKey);
  withKey.push(id);
}
const catalog: Array<{ id: string; available: string[]; enabled: string[] }> = [];
for (const id of input.discoverModelCatalogFor ?? []) {
  if (!input.workspace) throw new Error("discoverModelCatalogFor requires workspace");
  const config = await findAgentConfig(id);
  if (!config) throw new Error(`config ${id} was not saved`);
  const preview = await discoverAcpRuntimeConfig({
    runtimeId: id,
    workspacePath: input.workspace,
    resolveLaunch: resolveAcpRuntimeLaunch,
  });
  const available = preview.models.map(({ id: modelId, name, description }) => ({
    id: modelId,
    name,
    ...(description ? { description } : {}),
  }));
  if (!available.length) throw new Error(`${id} advertised no models`);
  const enabled = available.filter((model) => model.id === preview.selectedModel);
  const models = enabled.length ? enabled : available.slice(0, 1);
  await saveAcpModels(id, builtinConfigFingerprint(config), models, available);
  catalog.push({
    id,
    available: available.map((model) => model.id),
    enabled: models.map((model) => model.id),
  });
}
process.stdout.write(`${JSON.stringify({ saved, withKey, catalog })}\n`);
