import claudeCodeLock from "./manifests/claude-code.package-lock.json" with { type: "json" };
import codexLock from "./manifests/codex.package-lock.json" with { type: "json" };
import piLock from "./manifests/pi.package-lock.json" with { type: "json" };

export const BUILTIN_ACP_RUNTIMES = ["claude-code", "codex", "pi"] as const;
export type BuiltinAcpRuntime = (typeof BUILTIN_ACP_RUNTIMES)[number];

export type AgentAuthMode = "byok" | "subscription" | "cli-login";

/** 版本号参与安装目录名；lockfile 变更必须同步提升版本，已发布目录不会被原地改写。 */
export interface BuiltinRuntimeDefinition {
  runtime: BuiltinAcpRuntime;
  name: string;
  version: string;
  /** npm lockfile v3；根条目即安装目录的 package.json 依赖。 */
  lockfile: { name: string; packages: Record<string, unknown> };
  /** 相对安装目录的适配器入口（以 process.execPath 运行）。 */
  adapterEntry: string;
  /** 从源码构建的适配器（仅 Pi）。 */
  adapterSource?: {
    repository: string;
    commit: string;
    /** 源码中需要复制进安装目录的路径。 */
    paths: readonly string[];
  };
  authModes: readonly AgentAuthMode[];
  /** 受管原生二进制候选（相对安装目录）；安装发布前与启动时都必须存在其一。 */
  nativeBinaryCandidates(platform: NodeJS.Platform, arch: string, musl: boolean): string[];
  /** 适配器本身是否需要 ELECTRON_RUN_AS_NODE 传给其子进程（Pi 以 process.execPath 启动 pi）。 */
  childrenNeedNodeMode: boolean;
  /** 平台不受支持时的原因；null 表示支持。 */
  unsupportedReason(platform: NodeJS.Platform): string | null;
}

export const BUILTIN_RUNTIME_DEFINITIONS: Readonly<
  Record<BuiltinAcpRuntime, BuiltinRuntimeDefinition>
> = {
  "claude-code": {
    runtime: "claude-code",
    name: "Claude Code",
    version: "0.81.2-cc2.1.280",
    lockfile: claudeCodeLock,
    adapterEntry: "node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js",
    authModes: ["subscription", "byok", "cli-login"],
    nativeBinaryCandidates: (platform, arch, musl) =>
      claudeNativeBinaryCandidates(platform, arch, musl),
    childrenNeedNodeMode: false,
    unsupportedReason: () => null,
  },
  codex: {
    runtime: "codex",
    name: "Codex",
    version: "1.13.1-cx0.156.1",
    lockfile: codexLock,
    adapterEntry: "node_modules/@agentclientprotocol/codex-acp/dist/index.js",
    authModes: ["subscription", "byok", "cli-login"],
    nativeBinaryCandidates: (platform, arch) => {
      const candidate = codexNativeBinaryCandidate(platform, arch);
      return candidate ? [candidate] : [];
    },
    childrenNeedNodeMode: false,
    unsupportedReason: () => null,
  },
  pi: {
    runtime: "pi",
    name: "Pi",
    version: "0.2.0-350df43-pi0.87.0",
    lockfile: piLock,
    adapterEntry: "adapter/dist/index.js",
    adapterSource: {
      repository: "https://github.com/LodyAI/acp-extension-pi.git",
      commit: "350df43901e5fdf159c52119ddd43e2359249ad4",
      paths: ["src", "tsconfig.json", "package.json", "LICENSE"],
    },
    authModes: ["byok", "cli-login"],
    nativeBinaryCandidates: () => [],
    childrenNeedNodeMode: true,
    // acp-extension-pi 在 Windows 依赖 CI 预编译的 Job 原生模块；源码安装无法获得，缺失时适配器会拒绝启动。
    unsupportedReason: (platform) =>
      platform === "win32"
        ? "Pi requires acp-extension-pi's prebuilt Windows job module, which source installs cannot provide"
        : null,
  },
};

/** 与 agent_servers 共享命名空间：旧内置 ACP ID 仍用于历史会话恢复，内置配置不得占用。 */
export const RESERVED_AGENT_IDS: ReadonlySet<string> = new Set([
  "zcode-cli",
  "qoder-acp",
  "cline-acp",
  "codebuddy-acp",
  "workbuddy-acp",
]);

export function isBuiltinAcpRuntime(value: string): value is BuiltinAcpRuntime {
  return (BUILTIN_ACP_RUNTIMES as readonly string[]).includes(value);
}

/** 从 lockfile 根条目生成安装目录的 package.json，保证 npm ci 的清单与锁一致。 */
export function builtinPackageJson(definition: BuiltinRuntimeDefinition): string {
  const root = definition.lockfile.packages[""] as
    | { name?: string; dependencies?: Record<string, string> }
    | undefined;
  if (!root?.dependencies) throw new Error(`Lockfile for ${definition.runtime} has no root entry`);
  return `${JSON.stringify(
    { name: root.name ?? definition.lockfile.name, private: true, dependencies: root.dependencies },
    null,
    2,
  )}\n`;
}

/** Claude SDK 自带与适配器同版本线的原生 claude；按 libc 选择与 claude-agent-acp 相同的候选顺序。 */
export function claudeNativeBinaryCandidates(
  platform: NodeJS.Platform,
  arch: string,
  musl: boolean,
): string[] {
  const base = "node_modules/@anthropic-ai/claude-agent-sdk";
  if (platform === "linux") {
    const glibc = `${base}-linux-${arch}/claude`;
    const muslPath = `${base}-linux-${arch}-musl/claude`;
    return musl ? [muslPath, glibc] : [glibc, muslPath];
  }
  return [`${base}-${platform}-${arch}/claude${platform === "win32" ? ".exe" : ""}`];
}

const CODEX_TARGETS: Record<string, string> = {
  "linux-x64": "x86_64-unknown-linux-musl",
  "linux-arm64": "aarch64-unknown-linux-musl",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
  "win32-x64": "x86_64-pc-windows-msvc",
  "win32-arm64": "aarch64-pc-windows-msvc",
};

export function codexNativeBinaryCandidate(platform: NodeJS.Platform, arch: string): string | null {
  const triple = CODEX_TARGETS[`${platform}-${arch}`];
  if (!triple) return null;
  const executable = platform === "win32" ? "codex.exe" : "codex";
  return `node_modules/@openai/codex-${platform}-${arch}/vendor/${triple}/bin/${executable}`;
}
