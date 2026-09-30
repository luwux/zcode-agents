#!/usr/bin/env node
// Desktop end-to-end suite for the built-in ACP runtimes (Claude Code, Codex, Pi).
//
// Launches the real CodeZ Electron app (production bundles, throwaway HOME + data dir) with
// --remote-debugging-port and drives it over CDP with Playwright using real input only.
//
//   node scripts/acp-cdp/run-cdp-e2e.mjs [--mode replay|live] [--runtime claude-code,codex,pi]
//       [--artifacts DIR] [--runtimes-cache DIR] [--no-build] [--no-install] [--no-isolate]
//       [--keep] [--speed 5] [--turn-timeout-ms N] [--case SUBSTRING]
//       [--seed-model-catalog codex]   (diagnostic workaround, see README "Findings")
//
// replay (default): every runtime talks to scripts/acp-replay/replay-proxy.mjs with a dummy key.
//   On Linux the suite runs inside `unshare -rn` with only loopback up (no egress at all).
// live: OpenRouter `xiaomi/mimo-v2.6-flash`, key read from OPENROUTER_API_KEY (never logged; it
//   is only written into the app's encrypted credential store inside the throwaway data dir).
// Anything that cannot run is reported as SKIPPED with a reason; nothing is faked.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { resolveElectronBinary } from "./lib/app.mjs";
import { buildCases, LIVE_MODEL, RUNTIMES } from "./lib/cases.mjs";
import { runCase } from "./lib/flow.mjs";
import { findSecretInArtifacts } from "./lib/secret-scan.mjs";
import { cdpDir, desktopDir, log, redact, replayDir, repoRoot, servicesDir } from "./lib/util.mjs";

// 读取后立即从本进程环境移除，构建/子进程都不会继承 Key。
const apiKey = process.env.OPENROUTER_API_KEY?.trim() || null;
delete process.env.OPENROUTER_API_KEY;

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "replay" },
    runtime: { type: "string" },
    case: { type: "string" },
    artifacts: { type: "string" },
    "runtimes-cache": { type: "string" },
    "no-build": { type: "boolean", default: false },
    "no-install": { type: "boolean", default: false },
    "no-isolate": { type: "boolean", default: false },
    keep: { type: "boolean", default: false },
    // 回放速度：录制时间间隔除以该值（代理对单个间隔封顶 1.5s）。太快会在两次 DOM 轮询之间就完成整轮。
    speed: { type: "string", default: "5" },
    "turn-timeout-ms": { type: "string" },
    "sync-timeout-ms": { type: "string", default: "180000" },
    // 诊断用变通：对列出的 Runtime 跳过设置页同步，改由应用自己的 discoverAcpRuntimeConfig()
    // （不逐个探测模型）+ saveAcpModels() 写入模型目录；结果会标注。
    "seed-model-catalog": { type: "string" },
    inner: { type: "string" },
  },
});

function fail(message) {
  process.stderr.write(`[acp-cdp] ERROR: ${message}\n`);
  process.exit(1);
}

async function runLogged(label, command, args, { cwd = repoRoot, env = process.env, logDir }) {
  log(`${label}: ${command} ${args.join(" ")}`);
  const logPath = join(logDir, `${label}.log`);
  const chunks = [];
  const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (chunk) => chunks.push(chunk));
  child.stderr.on("data", (chunk) => chunks.push(chunk));
  const code = await new Promise((done) => {
    child.once("exit", done);
    child.once("error", (error) => {
      chunks.push(Buffer.from(`\n[acp-cdp] spawn failed: ${error.message}\n`));
      done(-1);
    });
  });
  await writeFile(logPath, Buffer.concat(chunks));
  if (code !== 0) throw new Error(`${label} failed (exit ${code}); see ${logPath}`);
}

async function build(artifacts) {
  const logDir = join(artifacts, "build");
  await mkdir(logDir, { recursive: true });
  const electron = resolveElectronBinary();
  if (!existsSync(electron))
    await runLogged("electron-install", process.execPath, ["install.js"], {
      cwd: join(repoRoot, "node_modules", "electron"),
      logDir,
    });
  // 存储启动需要随包 Agent（缺失时界面停在 "Startup preparation failed"）。
  await runLogged("desktop-agent-cli", process.execPath, ["scripts/build-desktop-agent-cli.mjs"], {
    logDir,
  });
  // main/preload/host (tsup) + renderer (vite build)；Electron 直接加载 out/，无需 Vite dev server。
  await runLogged(
    "desktop-bundles",
    "pnpm",
    ["--filter", "@zcode/desktop", "build:no-runtime-assets"],
    {
      logDir,
    },
  );
}

function verifyBuildOutputs() {
  const required = [
    join(desktopDir, "out", "main", "index.js"),
    join(desktopDir, "out", "host", "index.js"),
    join(desktopDir, "out", "renderer", "index.html"),
    join(desktopDir, "out", "metadata", "build-meta.json"),
    join(desktopDir, "bundled-agents"),
    resolveElectronBinary(),
  ];
  const missing = required.filter((path) => !existsSync(path));
  if (missing.length) fail(`build outputs missing (run without --no-build): ${missing.join(", ")}`);
  // `pnpm typecheck` 的 tsc -b 会按 tsconfig.host.json 把未打包的 JS/.d.ts 写进 out/host，覆盖 tsup
  // 产物；Host 随后在启动时因找不到 services 源码模块而退出。检测到就要求重新构建。
  if (existsSync(join(desktopDir, "out", "host", "index.d.ts")))
    fail(
      "packages/desktop/out/host contains tsc output (pnpm typecheck emits into out/host and " +
        "replaces the tsup bundle); run without --no-build",
    );
}

async function prepareRuntimes({ runtimes, cache, install, artifacts }) {
  const logDir = join(artifacts, "build");
  await mkdir(logDir, { recursive: true });
  const env = { ...process.env, CODEZ_ACP_RUNTIMES_DIR: cache };
  const skips = {};
  if (install) {
    for (const runtime of runtimes) {
      try {
        await runLogged(
          `install-${runtime}`,
          process.execPath,
          ["--import", "tsx", join(replayDir, "install-runtimes.ts"), runtime],
          { cwd: servicesDir, env, logDir },
        );
      } catch (error) {
        skips[runtime] = `runtime install failed: ${error.message}`;
      }
    }
  }
  const status = spawnSync(
    process.execPath,
    ["--import", "tsx", join(cdpDir, "runtime-status.ts")],
    { cwd: servicesDir, env, encoding: "utf8" },
  );
  if (status.status !== 0) fail(`runtime-status failed: ${status.stderr}`);
  for (const entry of JSON.parse(status.stdout.trim())) {
    if (!runtimes.includes(entry.runtime) || skips[entry.runtime]) continue;
    if (entry.unsupported)
      skips[entry.runtime] = `unsupported on ${process.platform}: ${entry.unsupported}`;
    else if (!entry.installed)
      skips[entry.runtime] =
        `${entry.runtime} ${entry.version} is not installed in ${cache}` +
        (install ? "" : " (--no-install was given)");
  }
  return skips;
}

function canIsolate() {
  return (
    process.platform === "linux" &&
    spawnSync("unshare", ["-rn", "true"], { stdio: "ignore" }).status === 0 &&
    spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0
  );
}

function printSummary(results, header) {
  const width = Math.max(...results.map((item) => item.id.length), 10);
  const lines = [header];
  for (const item of results) {
    const status = item.status.toUpperCase().padEnd(12);
    const reason = item.reason ? ` ${item.reason}` : "";
    lines.push(`${item.id.padEnd(width)}  ${status}${reason}`);
  }
  process.stdout.write(`\n${lines.join("\n")}\n`);
  return lines.join("\n");
}

async function runSuite(state) {
  const cases = buildCases({ mode: state.mode, runtimes: state.runtimes }).filter(
    (item) => !state.caseFilter || item.id.includes(state.caseFilter),
  );
  const scratch = await mkdtemp(join(tmpdir(), "codez-acp-cdp-"));
  const appEnv = {};
  if (state.mode === "live") {
    // Live：CLI 需要真实网络；只透传代理与证书变量，不透传任何凭据。
    for (const name of [
      "HTTPS_PROXY",
      "HTTP_PROXY",
      "NO_PROXY",
      "https_proxy",
      "http_proxy",
      "no_proxy",
      "NODE_EXTRA_CA_CERTS",
      "SSL_CERT_FILE",
    ])
      if (process.env[name]) appEnv[name] = process.env[name];
  } else if (!state.isolated) {
    // 无网络命名空间时退化为死代理（与 run-replay-e2e 相同）：只挡住遵守代理变量的客户端。
    Object.assign(appEnv, {
      HTTPS_PROXY: "http://127.0.0.1:9",
      HTTP_PROXY: "http://127.0.0.1:9",
      NO_PROXY: "127.0.0.1,localhost",
    });
  }
  const results = [];
  for (const testCase of cases) {
    const started = Date.now();
    const result = await runCase(testCase, {
      artifacts: state.artifacts,
      scratch,
      runtimesDir: state.cache,
      runtimeSkips: state.runtimeSkips,
      speed: Number(state.speed),
      turnTimeoutMs: state.turnTimeoutMs,
      syncTimeoutMs: state.syncTimeoutMs,
      keep: state.keep,
      apiKey: state.mode === "live" ? apiKey : null,
      liveModel: LIVE_MODEL,
      seedModelCatalog: state.seedModelCatalog,
      appEnv,
    });
    result.seconds = Math.round((Date.now() - started) / 100) / 10;
    results.push(result);
    log(
      `RESULT ${result.id} ${result.status.toUpperCase()} (${result.seconds}s)${
        result.reason ? ` — ${result.reason}` : ""
      }`,
    );
  }
  if (!state.keep) await rm(scratch, { recursive: true, force: true }).catch(() => {});
  const summary = {
    mode: state.mode,
    platform: `${process.platform}-${process.arch}`,
    isolation: state.isolated ? "loopback-only network namespace" : state.isolationNote,
    runtimesCache: state.cache,
    artifacts: state.artifacts,
    results: results.map(({ id, runtime, title, status, reason, seconds, artifacts }) => ({
      id,
      runtime,
      title,
      status,
      reason,
      seconds,
      artifacts,
    })),
  };
  const text = printSummary(
    results,
    `CodeZ desktop ACP CDP e2e — mode=${state.mode} isolation=${summary.isolation}`,
  );
  await writeFile(
    join(state.artifacts, "summary.json"),
    `${redact(JSON.stringify(summary, null, 2), apiKey ? [apiKey] : [])}\n`,
  );
  await writeFile(join(state.artifacts, "summary.txt"), `${text}\n`);
  if (state.mode === "live" && apiKey) {
    // 兜底检查：Key 只允许进入临时数据目录里的加密凭据库，任何产物（含 trace.zip 内条目）都不得出现。
    const leaks = await findSecretInArtifacts(state.artifacts, apiKey);
    await writeFile(
      join(state.artifacts, "secret-scan.json"),
      `${JSON.stringify({ scanned: state.artifacts, leaks }, null, 2)}\n`,
    );
    if (leaks.length) {
      process.stderr.write(
        `[acp-cdp] ERROR: the API key was found in artifacts (delete them now):\n  ${leaks.join("\n  ")}\n`,
      );
      return 1;
    }
    log("secret scan: API key not found in any artifact");
  }
  return results.some((item) => item.status === "failed") ? 1 : 0;
}

if (values.inner) {
  // 网络命名空间内的内层进程：只运行用例，构建与安装已在外层完成。
  const state = JSON.parse(await readFile(values.inner, "utf8"));
  process.exit(await runSuite(state));
}

const [major] = process.versions.node.split(".").map(Number);
if (major < 24) fail(`Node ${process.versions.node} is too old; mise.toml pins Node 24`);
const mode = values.mode;
if (mode !== "replay" && mode !== "live") fail(`--mode must be replay or live, got ${mode}`);
const runtimes = values.runtime ? values.runtime.split(",").map((item) => item.trim()) : RUNTIMES;
for (const runtime of runtimes) if (!RUNTIMES.includes(runtime)) fail(`unknown runtime ${runtime}`);
const artifacts = resolve(
  values.artifacts ??
    join(tmpdir(), `codez-acp-cdp-${mode}-${new Date().toISOString().replace(/[:.]/g, "-")}`),
);
await mkdir(artifacts, { recursive: true });
log(`artifacts: ${artifacts}`);

if (mode === "live" && !apiKey) {
  const reason = "OPENROUTER_API_KEY is not set; live mode needs an OpenRouter key";
  const results = buildCases({ mode, runtimes }).map((item) => ({
    id: item.id,
    runtime: item.runtime,
    title: item.title,
    status: "skipped",
    reason: item.skip ?? reason,
  }));
  const text = printSummary(results, "CodeZ desktop ACP CDP e2e — mode=live (not run)");
  await writeFile(join(artifacts, "summary.txt"), `${text}\n`);
  await writeFile(
    join(artifacts, "summary.json"),
    `${JSON.stringify({ mode, results }, null, 2)}\n`,
  );
  process.exit(0);
}

try {
  if (values["no-build"]) verifyBuildOutputs();
  else await build(artifacts);
  verifyBuildOutputs();
} catch (error) {
  fail(error.message);
}

const cache = resolve(
  values["runtimes-cache"] ??
    process.env.CODEZ_ACP_RUNTIMES_DIR ??
    join(tmpdir(), "codez-acp-runtimes-cache"),
);
await mkdir(cache, { recursive: true });
const runtimeSkips = await prepareRuntimes({
  runtimes,
  cache,
  install: !values["no-install"],
  artifacts,
});

const isolate = mode === "replay" && !values["no-isolate"] && canIsolate();
const state = {
  mode,
  runtimes,
  caseFilter: values.case ?? null,
  artifacts,
  cache,
  runtimeSkips,
  speed: values.speed,
  turnTimeoutMs: Number(values["turn-timeout-ms"] ?? (mode === "live" ? 300_000 : 180_000)),
  syncTimeoutMs: Number(values["sync-timeout-ms"]),
  keep: values.keep,
  seedModelCatalog: values["seed-model-catalog"]
    ? values["seed-model-catalog"].split(",").map((item) => item.trim())
    : [],
  isolated: isolate,
  isolationNote:
    mode === "live"
      ? "none (live mode needs network)"
      : values["no-isolate"]
        ? "none (--no-isolate); egress only discouraged via dead proxy env"
        : `none (network namespaces unavailable on ${process.platform}); egress only discouraged via dead proxy env`,
};

if (!isolate) process.exit(await runSuite(state));

const statePath = join(artifacts, "inner-state.json");
await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
log("running the suite inside a loopback-only network namespace (unshare -rn)");
const inner = spawnSync(
  "unshare",
  [
    "-rn",
    "python3",
    join(replayDir, "loopback-only.py"),
    process.execPath,
    join(cdpDir, "run-cdp-e2e.mjs"),
    "--inner",
    statePath,
  ],
  { stdio: "inherit", env: process.env },
);
process.exit(inner.status ?? 1);
