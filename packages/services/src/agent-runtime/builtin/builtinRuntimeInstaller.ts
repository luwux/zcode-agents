import { randomBytes } from "node:crypto";
import { access, cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { withFileLock } from "@zcode/shared/node";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import {
  builtinPackageJson,
  type BuiltinRuntimeDefinition,
} from "#src/agent-runtime/builtin/builtinRuntimeCatalog.js";
import {
  findExecutableOnPath,
  nodeModeEnv,
  resolveNpmCli,
  runArgv,
} from "#src/agent-runtime/builtin/builtinProcess.js";

const logger = createServiceLogger("acpBuiltinInstaller");
const COMPLETE_MARKER = ".codez-complete";
const NPM_TIMEOUT_MS = 15 * 60_000;
const GIT_TIMEOUT_MS = 5 * 60_000;
const BUILD_TIMEOUT_MS = 5 * 60_000;
// 安装可能持续数分钟；其他进程等待同一安装时不能用凭据锁的 8 秒上限。
const INSTALL_LOCK_MAX_WAIT_MS = 20 * 60_000;

/** 安装子进程只继承网络、证书与 npm 缓存相关变量，不带任何 Provider 凭据。 */
const INSTALL_ENV_ALLOWLIST = [
  "PATH",
  "Path",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "SystemRoot",
  "TEMP",
  "TMP",
  "TMPDIR",
  "LANG",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "npm_config_registry",
  "npm_config_cache",
  "npm_config_cafile",
  "NPM_CONFIG_REGISTRY",
  "NPM_CONFIG_CACHE",
  "NPM_CONFIG_CAFILE",
];

export interface BuiltinInstallOptions {
  /** `<数据根>/acp-runtimes` */
  root: string;
  env?: NodeJS.ProcessEnv;
}

export function builtinInstallDir(root: string, definition: BuiltinRuntimeDefinition): string {
  return join(root, definition.runtime, definition.version);
}

export async function isBuiltinRuntimeInstalled(
  root: string,
  definition: BuiltinRuntimeDefinition,
): Promise<boolean> {
  try {
    await access(join(builtinInstallDir(root, definition), COMPLETE_MARKER), constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

const inFlight = new Map<string, Promise<string>>();

/**
 * 发布语义：只在同级临时目录内安装并校验，完成标记写入后整体 rename；
 * 进程内 promise 去重，目录锁覆盖多个 Host 进程同时首次使用。
 */
export function ensureBuiltinRuntimeInstalled(
  definition: BuiltinRuntimeDefinition,
  options: BuiltinInstallOptions,
): Promise<string> {
  const target = builtinInstallDir(options.root, definition);
  const pending = inFlight.get(target);
  if (pending) return pending;
  const install = (async () => {
    if (await isBuiltinRuntimeInstalled(options.root, definition)) return target;
    const unsupported = definition.unsupportedReason(process.platform);
    if (unsupported) throw new Error(unsupported);
    await mkdir(join(options.root, definition.runtime), { recursive: true });
    return withFileLock(
      `${target}.install`,
      async () => {
        if (await isBuiltinRuntimeInstalled(options.root, definition)) return target;
        await installInto(target, definition, options.env ?? process.env);
        return target;
      },
      { lockMaxWaitMs: INSTALL_LOCK_MAX_WAIT_MS },
    );
  })();
  inFlight.set(target, install);
  void install
    .finally(() => {
      if (inFlight.get(target) === install) inFlight.delete(target);
    })
    .catch(() => {});
  return install;
}

async function installInto(
  target: string,
  definition: BuiltinRuntimeDefinition,
  hostEnv: NodeJS.ProcessEnv,
): Promise<void> {
  const env: NodeJS.ProcessEnv = { npm_config_update_notifier: "false", npm_config_fund: "false" };
  for (const key of INSTALL_ENV_ALLOWLIST) if (hostEnv[key] !== undefined) env[key] = hostEnv[key];
  const npmCli = await resolveNpmCli(hostEnv);
  if (!npmCli)
    throw new Error(`Installing ${definition.name} requires npm (install Node.js) on PATH`);
  const staging = `${target}.staging-${process.pid}-${randomBytes(4).toString("hex")}`;
  logger.info(undefined, "installing built-in ACP runtime", {
    runtime: definition.runtime,
    version: definition.version,
  });
  try {
    await mkdir(staging, { recursive: true });
    await writeFile(join(staging, "package.json"), builtinPackageJson(definition));
    await writeFile(
      join(staging, "package-lock.json"),
      `${JSON.stringify(definition.lockfile, null, 2)}\n`,
    );
    // --ignore-scripts：所需原生二进制都以 optionalDependencies 分发，不运行第三方安装脚本。
    const npm = await runArgv(
      process.execPath,
      [npmCli, "ci", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"],
      { cwd: staging, env: nodeModeEnv(env), timeoutMs: NPM_TIMEOUT_MS },
    );
    if (npm.code !== 0) throw new Error(`npm ci failed (${npm.code}): ${npm.output.trim()}`);
    if (definition.adapterSource) await buildAdapterFromSource(staging, definition, env);
    await access(join(staging, definition.adapterEntry), constants.R_OK);
    await writeFile(
      join(staging, COMPLETE_MARKER),
      `${JSON.stringify({ runtime: definition.runtime, version: definition.version })}\n`,
    );
    await rm(target, { recursive: true, force: true });
    await rename(staging, target);
    logger.info(undefined, "installed built-in ACP runtime", { runtime: definition.runtime });
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/** Pi 适配器未发布到 npm：按固定 commit 拉取源码（commit 哈希即内容校验），用锁定的 typescript 编译。 */
async function buildAdapterFromSource(
  staging: string,
  definition: BuiltinRuntimeDefinition,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const source = definition.adapterSource!;
  const git = await findExecutableOnPath("git", env);
  if (!git) throw new Error(`Installing ${definition.name} requires git on PATH`);
  const checkout = join(staging, ".adapter-src");
  await mkdir(checkout, { recursive: true });
  const gitEnv = { ...env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" };
  for (const args of [
    ["init", "-q"],
    ["fetch", "-q", "--depth", "1", source.repository, source.commit],
    ["checkout", "-q", "FETCH_HEAD"],
  ]) {
    const result = await runArgv(git, args, {
      cwd: checkout,
      env: gitEnv,
      timeoutMs: GIT_TIMEOUT_MS,
    });
    if (result.code !== 0)
      throw new Error(`git ${args[0]} failed (${result.code}): ${result.output.trim()}`);
  }
  const head = await runArgv(git, ["rev-parse", "HEAD"], {
    cwd: checkout,
    env: gitEnv,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (head.output.trim() !== source.commit)
    throw new Error(`${definition.name} adapter source does not match the pinned commit`);
  const adapter = join(staging, "adapter");
  await mkdir(adapter, { recursive: true });
  for (const path of source.paths)
    await cp(join(checkout, path), join(adapter, path), { recursive: true });
  await rm(checkout, { recursive: true, force: true });
  const tsc = await runArgv(
    process.execPath,
    [join(staging, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"],
    { cwd: adapter, env: nodeModeEnv(env), timeoutMs: BUILD_TIMEOUT_MS },
  );
  if (tsc.code !== 0)
    throw new Error(`${definition.name} adapter build failed: ${tsc.output.trim()}`);
  const manifest = JSON.parse(await readFile(join(adapter, "package.json"), "utf8")) as {
    type?: string;
  };
  if (manifest.type !== "module") throw new Error(`${definition.name} adapter manifest changed`);
}
