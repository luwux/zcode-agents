import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWritePrivateTextFile } from "@zcode/shared/node";
import { createCredentialService } from "#src/credential/credentialService.js";
import type { ICredentialService } from "#src/credential/credential.js";
import { getZCodeDataRootDir } from "#src/paths.js";
import {
  secretCredentialKey,
  type AgentConfig,
} from "#src/agent-runtime/builtin/agentConfigRegistry.js";
import { BUILTIN_RUNTIME_DEFINITIONS } from "#src/agent-runtime/builtin/builtinRuntimeCatalog.js";
import {
  discardBrokenInstall,
  ensureBuiltinRuntimeInstalled,
  findNativeBinary,
} from "#src/agent-runtime/builtin/builtinRuntimeInstaller.js";
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

const STRIP_ELECTRON_NODE_MODE =
  'delete process.env.ELECTRON_RUN_AS_NODE; const { pathToFileURL } = await import("node:url"); await import(pathToFileURL(process.argv[1]).href);';

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
  const root = builtinRuntimesRoot(hostEnv);
  let installDir = await ensureBuiltinRuntimeInstalled(definition, { root, env: hostEnv });
  let nativeBinary = await findNativeBinary(installDir, definition);
  if (
    !nativeBinary &&
    definition.nativeBinaryCandidates(process.platform, process.arch, false).length
  ) {
    // 修复原因：旧版本安装器可能发布了缺原生二进制的目录；丢弃后重装一次，而不是永久失败。
    await discardBrokenInstall(root, definition);
    installDir = await ensureBuiltinRuntimeInstalled(definition, { root, env: hostEnv });
    nativeBinary = await findNativeBinary(installDir, definition);
    if (!nativeBinary)
      throw new Error(
        `${definition.name} native binary is missing for ${process.platform}-${process.arch}`,
      );
  }
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
    ...(nativeBinary ? { nativeBinary } : {}),
  });
  if (plan.problem) throw new Error(`${config.name}: ${plan.problem}`);
  if (plan.nativeHome !== "global") await mkdir(plan.nativeHome, { recursive: true, mode: 0o700 });
  for (const file of plan.files) {
    // 原子替换且内容未变时跳过：并发启动同一配置时不会读到被截断的 config.toml/models.json。
    const current = await readFile(file.path, "utf8").catch(() => null);
    if (current !== file.content) await atomicWritePrivateTextFile(file.path, file.content);
  }
  const entry = join(installDir, definition.adapterEntry);
  if (process.versions.electron && !definition.childrenNeedNodeMode)
    // 修复原因：ELECTRON_RUN_AS_NODE 会被 Agent 执行的命令继承（electron .、code 等变成纯 Node）。
    // 适配器只需在自身进程以 Node 模式启动；加载前删除该变量，argv[1] 仍是适配器入口。
    return {
      executable: process.execPath,
      args: ["--input-type=module", "-e", STRIP_ELECTRON_NODE_MODE, entry, ...plan.args],
      env: nodeModeEnv(plan.env),
    };
  return { executable: process.execPath, args: [entry, ...plan.args], env: nodeModeEnv(plan.env) };
}
