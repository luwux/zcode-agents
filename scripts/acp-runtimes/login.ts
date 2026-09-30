// Subscription sign-in for a built-in ACP runtime configuration, using the same backend code path
// as the app (startBuiltinLogin). Credentials are written only by the CLI itself into the config's
// private home under the CodeZ data root (never ~/.claude or ~/.codex unless the config is cli-login).
//
//   node --import tsx scripts/acp-runtimes/login.ts <configId> [--method <authMethodId>] [--device-auth]
//   node --import tsx scripts/acp-runtimes/login.ts <configId> --logout
//   node --import tsx scripts/acp-runtimes/login.ts <configId> --status
//
// Run from packages/services (so `#src/*` imports resolve). ZCODE_DATA_BASE_DIR selects a data root
// other than the default (~). Quit the CodeZ app first so the two processes do not race on the home.
import { parseArgs } from "node:util";
import { findAgentConfig } from "../../packages/services/src/agent-runtime/builtin/agentConfigRegistry.ts";
import {
  logoutBuiltinRuntime,
  startBuiltinLogin,
} from "../../packages/services/src/agent-runtime/builtin/builtinRuntimeAuth.ts";
import {
  builtinConfigHome,
  resolveBuiltinLaunch,
} from "../../packages/services/src/agent-runtime/builtin/builtinRuntimeLaunch.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    method: { type: "string" },
    "device-auth": { type: "boolean", default: false },
    logout: { type: "boolean", default: false },
    status: { type: "boolean", default: false },
  },
});
const id = positionals[0];
if (!id)
  throw new Error("usage: login.ts <configId> [--method id] [--device-auth] [--logout|--status]");
const config = await findAgentConfig(id);
if (!config) throw new Error(`Unknown agent config ${id}`);
const deps = {
  resolveLaunch: resolveBuiltinLaunch,
  cwd: process.cwd(),
  interactive: process.stdin.isTTY === true,
  onOutput: (chunk: string) => process.stdout.write(chunk),
};
console.log(`[login] ${config.name} (${config.runtime}, auth=${config.auth})`);
console.log(
  `[login] private home: ${config.auth === "cli-login" ? "(global CLI home)" : builtinConfigHome(config.id)}`,
);
if (values.status) {
  const launch = await resolveBuiltinLaunch(config);
  const { spawnSync } = await import("node:child_process");
  const [command, args] =
    config.runtime === "codex"
      ? [launch.env!.CODEX_PATH!, ["login", "status"]]
      : [launch.executable, [...launch.args, "--cli", "auth", "status"]];
  spawnSync(command, args, { env: launch.env, stdio: "inherit" });
} else if (values.logout) {
  console.log(await logoutBuiltinRuntime(config, deps));
} else {
  const handle = startBuiltinLogin(
    config,
    { methodId: values.method, deviceAuth: values["device-auth"] },
    deps,
  );
  const started = await handle.started;
  if (started.message) console.log(`\n[login] ${started.message}`);
  console.log(await handle.completion);
}
