#!/usr/bin/env node
// Offline replay e2e for the built-in Claude Code / Codex / Pi runtimes.
//
// 1. Installs the pinned runtimes with the production installer into a cache dir (needs network).
// 2. Runs packages/services/test/e2e/builtinRuntimesReplay.e2e.ts with a throwaway HOME. On Linux
//    the run happens inside `unshare -rn` with only loopback up, so the CLIs cannot reach any
//    network except the local replay proxy. Elsewhere egress is only discouraged via a dead proxy.
//
// Usage: node scripts/acp-replay/run-replay-e2e.mjs [--cache DIR] [--artifacts DIR] [--no-install]
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const services = join(repo, "packages/services");
const { values } = parseArgs({
  options: {
    cache: { type: "string", default: join(tmpdir(), "codez-acp-runtimes-cache") },
    artifacts: { type: "string" },
    "no-install": { type: "boolean", default: false },
    pattern: { type: "string" },
  },
});
const cache = resolve(values.cache);
mkdirSync(cache, { recursive: true });

if (!values["no-install"]) {
  execFileSync(process.execPath, ["--import", "tsx", join(here, "install-runtimes.ts")], {
    cwd: services,
    stdio: "inherit",
    env: { ...process.env, CODEZ_ACP_RUNTIMES_DIR: cache },
  });
}

const home = mkdtempSync(join(tmpdir(), "codez-replay-home-"));
const env = {
  PATH: process.env.PATH,
  HOME: home,
  LANG: process.env.LANG ?? "C.UTF-8",
  TMPDIR: process.env.TMPDIR ?? tmpdir(),
  CODEZ_ACP_RUNTIMES_DIR: cache,
  CODEZ_E2E_REPLAY: "1",
  ...(values.artifacts ? { CODEZ_E2E_ARTIFACTS: resolve(values.artifacts) } : {}),
};
const testArgs = [
  "--import",
  "tsx",
  "--test",
  ...(values.pattern ? ["--test-name-pattern", values.pattern] : []),
  "test/e2e/builtinRuntimesReplay.e2e.ts",
];

let command = process.execPath;
let args = testArgs;
const canIsolate =
  process.platform === "linux" &&
  spawnSync("unshare", ["-rn", "true"], { stdio: "ignore" }).status === 0 &&
  spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;
if (canIsolate) {
  command = "unshare";
  args = ["-rn", "python3", join(here, "loopback-only.py"), process.execPath, ...testArgs];
  console.log("[replay-e2e] running in a loopback-only network namespace");
} else if (process.env.CI) {
  // CI 必须满足“仅 loopback”的隔离承诺；无法建立网络命名空间时失败而不是静默降级。
  console.error(
    "[replay-e2e] network namespace unavailable in CI; refusing to run without isolation",
  );
  process.exit(1);
} else {
  // 无法创建网络命名空间时退化为死代理：遵守代理变量的客户端无法外连；这不是强隔离。
  Object.assign(env, {
    HTTPS_PROXY: "http://127.0.0.1:9",
    HTTP_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "127.0.0.1,localhost",
  });
  console.log(
    "[replay-e2e] WARNING: network namespace unavailable; egress only blocked via dead proxy",
  );
}
const result = spawnSync(command, args, { cwd: services, stdio: "inherit", env });
process.exit(result.status ?? 1);
