import { createHash } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { createCredentialService } from "#src/credential/credentialService.js";
import type { ICredentialService } from "#src/credential/credential.js";
import { getZCodeDataRootDir } from "#src/paths.js";
import {
  secretCredentialKey,
  type AgentConfig,
} from "#src/agent-runtime/builtin/agentConfigRegistry.js";
import {
  BUILTIN_RUNTIME_DEFINITIONS,
  claudeNativeBinaryCandidates,
  codexNativeBinaryCandidate,
} from "#src/agent-runtime/builtin/builtinRuntimeCatalog.js";
import { ensureBuiltinRuntimeInstalled } from "#src/agent-runtime/builtin/builtinRuntimeInstaller.js";
import { buildBuiltinLaunchEnv } from "#src/agent-runtime/builtin/builtinRuntimeEnv.js";
import { nodeModeEnv } from "#src/agent-runtime/builtin/builtinProcess.js";

export interface AcpLaunch {
  executable: string;
  args: readonly string[];
  /** 缺省时沿用 Host 进程 env（自定义 agent_servers 的既有行为）。 */
  env?: NodeJS.ProcessEnv;
}

let credentials: ICredentialService | null = null;
function credentialService(): ICredentialService {
  credentials ??= createCredentialService();
  return credentials;
}

/** 测试与离线回放可将安装目录指到共享缓存，避免每次重新下载数百 MB。 */
export function builtinRuntimesRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEZ_ACP_RUNTIMES_DIR?.trim() || join(getZCodeDataRootDir(), "acp-runtimes");
}

export function builtinConfigHome(configId: string): string {
  return join(getZCodeDataRootDir(), "acp-homes", configId);
}

/** fingerprint 只标识原生会话存储（runtime + 配置 + home 归属），不含秘密或 Provider 路由。 */
export function builtinConfigFingerprint(config: AgentConfig): string {
  const home = config.auth === "cli-login" ? "global" : `private:${config.id}`;
  return createHash("sha256")
    .update(JSON.stringify(["builtin", config.runtime, config.id, home]))
    .digest("hex");
}

export async function loadBuiltinConfigApiKey(configId: string): Promise<string | null> {
  return credentialService().load(secretCredentialKey(configId));
}

export async function saveBuiltinConfigApiKey(
  configId: string,
  apiKey: string | null,
): Promise<void> {
  if (apiKey === null) await credentialService().delete(secretCredentialKey(configId));
  else await credentialService().save(secretCredentialKey(configId), apiKey);
}

function isMusl(): boolean {
  const report = process.report?.getReport() as
    | { header?: { glibcVersionRuntime?: string } }
    | undefined;
  return !report?.header?.glibcVersionRuntime;
}

async function firstReadable(dir: string, candidates: readonly string[]): Promise<string> {
  for (const candidate of candidates) {
    const path = join(dir, candidate);
    try {
      await access(path, constants.X_OK);
      return path;
    } catch {
      // 继续下一个候选。
    }
  }
  throw new Error(`Managed native binary is missing under ${dir}`);
}

async function resolveNativeBinary(
  config: AgentConfig,
  installDir: string,
): Promise<string | undefined> {
  if (config.runtime === "claude-code")
    return firstReadable(
      installDir,
      claudeNativeBinaryCandidates(
        process.platform,
        process.arch,
        process.platform === "linux" && isMusl(),
      ),
    );
  if (config.runtime === "codex") {
    const candidate = codexNativeBinaryCandidate(process.platform, process.arch);
    if (!candidate)
      throw new Error(`Codex is not available for ${process.platform}-${process.arch}`);
    return firstReadable(installDir, [candidate]);
  }
  return undefined;
}

export interface BuiltinLaunchOptions {
  hostEnv?: NodeJS.ProcessEnv;
  apiKey?: string | null;
}

/** 安装（首次）→ 构造隔离 env → process.execPath + 适配器入口，全程 argv，不经 shell。 */
export async function resolveBuiltinLaunch(
  config: AgentConfig,
  options: BuiltinLaunchOptions = {},
): Promise<AcpLaunch> {
  const definition = BUILTIN_RUNTIME_DEFINITIONS[config.runtime];
  const hostEnv = options.hostEnv ?? process.env;
  const installDir = await ensureBuiltinRuntimeInstalled(definition, {
    root: builtinRuntimesRoot(hostEnv),
    env: hostEnv,
  });
  const apiKey =
    options.apiKey !== undefined
      ? options.apiKey
      : config.auth === "byok"
        ? await loadBuiltinConfigApiKey(config.id)
        : null;
  const plan = buildBuiltinLaunchEnv({
    config,
    hostEnv,
    apiKey,
    configHome: builtinConfigHome(config.id),
    nativeBinary: await resolveNativeBinary(config, installDir),
  });
  if (plan.problem) throw new Error(`${config.name}: ${plan.problem}`);
  if (plan.nativeHome !== "global") await mkdir(plan.nativeHome, { recursive: true, mode: 0o700 });
  for (const file of plan.files) {
    await mkdir(dirname(file.path), { recursive: true, mode: 0o700 });
    await writeFile(file.path, file.content, { mode: 0o600 });
  }
  return {
    executable: process.execPath,
    args: [join(installDir, definition.adapterEntry), ...plan.args],
    env: nodeModeEnv(plan.env),
  };
}
