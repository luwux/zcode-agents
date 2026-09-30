import { spawn } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";

const OUTPUT_TAIL_BYTES = 4_000;

/** 只按 argv 执行；stdout/stderr 仅保留尾部用于错误原因，不回显到日志。 */
export async function runArgv(
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal },
): Promise<{ code: number | null; output: string }> {
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    signal: options.signal,
  });
  let output = "";
  const append = (chunk: Buffer) => {
    output = (output + chunk.toString("utf8")).slice(-OUTPUT_TAIL_BYTES);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  const timeout = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode) => resolve(exitCode));
    });
    return { code, output };
  } finally {
    clearTimeout(timeout);
  }
}

export function trustedPathEntries(env: NodeJS.ProcessEnv): string[] {
  const entries = (env.PATH ?? env.Path ?? "")
    .split(delimiter)
    .filter((entry) => isAbsolute(entry));
  if (process.platform === "darwin") {
    // Finder 启动的 App 只继承精简 PATH；补常见安装位置以找到用户的 npm/git。
    for (const fallback of ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]) {
      if (!entries.includes(fallback)) entries.push(fallback);
    }
  }
  return entries;
}

export async function findExecutableOnPath(
  name: string,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  const names = process.platform === "win32" ? [`${name}.exe`, `${name}.cmd`, name] : [name];
  for (const entry of trustedPathEntries(env)) {
    for (const candidate of names) {
      const path = join(entry, candidate);
      try {
        await access(path, constants.X_OK);
        return await realpath(path);
      } catch {
        // 继续查找下一个 PATH 条目。
      }
    }
  }
  return null;
}

/**
 * npm 以 JS 入口经 process.execPath 运行：Windows 的 npm.cmd 需要 shell，Electron 打包态也没有独立 node。
 * `CODEZ_NPM_CLI` 可显式指定 npm-cli.js。
 */
export async function resolveNpmCli(env: NodeJS.ProcessEnv): Promise<string | null> {
  const candidates: string[] = [];
  const explicit = env.CODEZ_NPM_CLI?.trim();
  if (explicit) candidates.push(explicit);
  const npm = await findExecutableOnPath("npm", env);
  if (npm) {
    if (npm.endsWith(".js")) candidates.push(npm);
    const dir = dirname(npm);
    candidates.push(
      join(dir, "node_modules", "npm", "bin", "npm-cli.js"),
      join(dir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    );
  }
  for (const candidate of candidates) {
    if (!isAbsolute(candidate)) continue;
    try {
      await access(candidate, constants.R_OK);
      return await realpath(candidate);
    } catch {
      // 继续尝试下一个候选。
    }
  }
  return null;
}

/** Electron utility process 的 execPath 是 Electron Helper，必须显式以 Node 模式运行子进程。 */
export function nodeModeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return process.versions.electron ? { ...env, ELECTRON_RUN_AS_NODE: "1" } : env;
}
