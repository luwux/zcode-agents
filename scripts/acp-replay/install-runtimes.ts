// Installs the pinned built-in runtimes with the production installer into a cache directory,
// so offline tests can run without network. Usage:
//   CODEZ_ACP_RUNTIMES_DIR=/path/cache node --import tsx scripts/acp-replay/install-runtimes.ts [runtime...]
import {
  BUILTIN_ACP_RUNTIMES,
  BUILTIN_RUNTIME_DEFINITIONS,
  isBuiltinAcpRuntime,
} from "../../packages/services/src/agent-runtime/builtin/builtinRuntimeCatalog.ts";
import { ensureBuiltinRuntimeInstalled } from "../../packages/services/src/agent-runtime/builtin/builtinRuntimeInstaller.ts";

const root = process.env.CODEZ_ACP_RUNTIMES_DIR?.trim();
if (!root) throw new Error("Set CODEZ_ACP_RUNTIMES_DIR");
const requested = process.argv.slice(2);
const runtimes = requested.length ? requested : [...BUILTIN_ACP_RUNTIMES];
for (const runtime of runtimes) {
  if (!isBuiltinAcpRuntime(runtime)) throw new Error(`Unknown runtime ${runtime}`);
  const definition = BUILTIN_RUNTIME_DEFINITIONS[runtime];
  const reason = definition.unsupportedReason(process.platform);
  if (reason) {
    console.log(`skip ${runtime}: ${reason}`);
    continue;
  }
  const started = Date.now();
  const dir = await ensureBuiltinRuntimeInstalled(definition, { root });
  console.log(
    `installed ${runtime} ${definition.version} in ${Math.round((Date.now() - started) / 1000)}s: ${dir}`,
  );
}
