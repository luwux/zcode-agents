// Throwaway workspace, replay proxy and config seeding for one case.
import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { cdpDir, redact, replayDir, servicesDir } from "./util.mjs";

export async function makeWorkspace(root) {
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(
    join(workspace, "README.md"),
    "# CDP e2e workspace\n\nThrowaway repository for the desktop ACP e2e suite.\n",
  );
  await writeFile(
    join(workspace, "package.json"),
    `${JSON.stringify({ name: "cdp-e2e-workspace", private: true, version: "0.0.0" }, null, 2)}\n`,
  );
  const identity = [
    "-c",
    "user.email=cdp-e2e@example.invalid",
    "-c",
    "user.name=CDP E2E",
    "-c",
    "commit.gpgsign=false",
  ];
  const git = (...args) => {
    try {
      execFileSync("git", args, { cwd: workspace, stdio: ["ignore", "ignore", "pipe"] });
    } catch (error) {
      throw new Error(`git ${args.join(" ")} failed: ${String(error.stderr ?? error).trim()}`);
    }
  };
  git("init", "-q");
  git(...identity, "add", ".");
  git(...identity, "commit", "-qm", "init");
  return workspace;
}

export async function readFixture(name) {
  return JSON.parse(await readFile(join(replayDir, "fixtures", name), "utf8"));
}

/** Starts scripts/acp-replay/replay-proxy.mjs bound to 127.0.0.1 and returns its base URL. */
export async function startReplayProxy({ fixture, workspace, log, speed }) {
  const child = spawn(
    process.execPath,
    [
      join(replayDir, "replay-proxy.mjs"),
      "--fixture",
      join(replayDir, "fixtures", fixture),
      "--workspace",
      workspace,
      "--log",
      log,
      "--speed",
      String(speed),
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const line = await new Promise((resolve, reject) => {
    const rl = createInterface({ input: child.stdout });
    rl.once("line", resolve);
    child.once("exit", (code) => reject(new Error(`replay proxy exited ${code}`)));
  });
  return { child, url: JSON.parse(line).url };
}

export async function readProxyLog(path) {
  const text = await readFile(path, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/**
 * Writes agent-configs.json and the encrypted API key with the app's own modules.
 * The key travels over stdin only; HOME must match the app's HOME (credential cipher key).
 */
export async function seedAgentConfigs({
  home,
  dataDir,
  configs,
  apiKey,
  apiKeyFor,
  discoverModelCatalogFor = [],
  workspace,
  extraEnv = {},
  secrets,
}) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", join(cdpDir, "seed-agent-configs.ts")],
    {
      cwd: servicesDir,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        TMPDIR: process.env.TMPDIR ?? "/tmp",
        ZCODE_DATA_BASE_DIR: dataDir,
        ...extraEnv,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.stdin.end(
    JSON.stringify({ dataDir, configs, apiKey, apiKeyFor, discoverModelCatalogFor, workspace }),
  );
  const code = await new Promise((resolve) => child.once("exit", resolve));
  if (code !== 0)
    throw new Error(`seeding agent configs failed (${code}): ${redact(stderr, secrets).trim()}`);
  return JSON.parse(stdout.trim().split("\n").at(-1));
}
