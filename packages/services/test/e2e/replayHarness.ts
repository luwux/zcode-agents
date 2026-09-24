/** 离线回放 e2e 的共享夹具：本地回放代理、一次性 git 工作区与轮询等待。 */
import { spawn, execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const replayDir = resolve(here, "../../../../scripts/acp-replay");
export const replayEnabled =
  process.env.CODEZ_E2E_REPLAY === "1" && Boolean(process.env.CODEZ_ACP_RUNTIMES_DIR);
export const replaySkip = replayEnabled
  ? false
  : "set CODEZ_E2E_REPLAY=1 and CODEZ_ACP_RUNTIMES_DIR (use run-replay-e2e.mjs)";

export async function startProxy(
  fixture: string,
  workspace: string,
  log: string,
  timing: { speed?: number; maxDelayMs?: number } = {},
) {
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
      String(timing.speed ?? 50),
      ...(timing.maxDelayMs === undefined ? [] : ["--max-delay-ms", String(timing.maxDelayMs)]),
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const line = await new Promise<string>((resolveLine, reject) => {
    const rl = createInterface({ input: child.stdout! });
    rl.once("line", resolveLine);
    child.once("exit", (code) => reject(new Error(`replay proxy exited ${code}`)));
  });
  return { child, url: (JSON.parse(line) as { url: string }).url };
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  ms: number,
  label: string,
) {
  const deadline = Date.now() + ms;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

export async function makeWorkspace(root: string): Promise<string> {
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(
    join(workspace, "README.md"),
    "# Replay workspace\n\nThrowaway repository for replay tests.\n",
  );
  await writeFile(
    join(workspace, "package.json"),
    `${JSON.stringify({ name: "replay-workspace", private: true, version: "0.0.0" }, null, 2)}\n`,
  );
  const git = (...args: string[]) => execFileSync("git", args, { cwd: workspace, stdio: "ignore" });
  git("init", "-q");
  git("-c", "user.email=replay@example.invalid", "-c", "user.name=Replay", "add", ".");
  git("-c", "user.email=replay@example.invalid", "-c", "user.name=Replay", "commit", "-qm", "init");
  return workspace;
}
