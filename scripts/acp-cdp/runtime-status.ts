// Prints which pinned built-in runtimes are installed in CODEZ_ACP_RUNTIMES_DIR (JSON on stdout).
import {
  BUILTIN_ACP_RUNTIMES,
  BUILTIN_RUNTIME_DEFINITIONS,
} from "../../packages/services/src/agent-runtime/builtin/builtinRuntimeCatalog.ts";
import { isBuiltinRuntimeInstalled } from "../../packages/services/src/agent-runtime/builtin/builtinRuntimeInstaller.ts";

const root = process.env.CODEZ_ACP_RUNTIMES_DIR?.trim();
if (!root) throw new Error("Set CODEZ_ACP_RUNTIMES_DIR");
const statuses = [];
for (const runtime of BUILTIN_ACP_RUNTIMES) {
  const definition = BUILTIN_RUNTIME_DEFINITIONS[runtime];
  statuses.push({
    runtime,
    version: definition.version,
    installed: await isBuiltinRuntimeInstalled(root, definition),
    unsupported: definition.unsupportedReason(process.platform),
  });
}
process.stdout.write(`${JSON.stringify(statuses)}\n`);
