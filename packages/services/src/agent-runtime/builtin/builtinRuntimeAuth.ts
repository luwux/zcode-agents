import { spawn } from "node:child_process";
import type { AuthMethod } from "@agentclientprotocol/sdk";
import { AcpConnection } from "#src/agent-runtime/acpConnection.js";
import { acpStartupGate } from "#src/agent-runtime/acpStartupGate.js";
import {
  acpAuthStateStore,
  summarizeAuthMethods,
  type AcpAuthSnapshot,
  type AcpAuthStateStore,
} from "#src/agent-runtime/acpAuthState.js";
import type { AgentConfig } from "#src/agent-runtime/builtin/agentConfigRegistry.js";
import type { AcpLaunch } from "#src/agent-runtime/builtin/builtinRuntimeLaunch.js";

const LOGIN_TIMEOUT_MS = 10 * 60_000;
const OUTPUT_TAIL = 4_000;

/** 订阅配置的首选方法：Claude 订阅登录优先于 Console；Codex 走 ChatGPT。 */
const PREFERRED_METHODS: Record<AgentConfig["runtime"], readonly string[]> = {
  "claude-code": ["claude-ai-login", "claude-login", "console-login"],
  codex: ["chat-gpt", "chat-gpt-device-code"],
  pi: [],
};

export function selectAuthMethod(
  config: AgentConfig,
  methods: readonly AuthMethod[] | undefined,
  requested?: string,
): AuthMethod {
  const available = methods ?? [];
  if (requested) {
    const method = available.find((candidate) => candidate.id === requested);
    if (!method) throw new Error(`Auth method ${JSON.stringify(requested)} is not offered`);
    return method;
  }
  for (const id of PREFERRED_METHODS[config.runtime]) {
    const method = available.find((candidate) => candidate.id === id);
    if (method) return method;
  }
  throw new Error(`${config.name} does not offer a subscription sign-in method`);
}

export interface BuiltinLoginDependencies {
  resolveLaunch(config: AgentConfig): Promise<AcpLaunch>;
  cwd: string;
  authStates?: AcpAuthStateStore;
  /** 登录进程输出（可能含登录 URL / 设备码）；不写日志。 */
  onOutput?: (chunk: string) => void;
}

export interface BuiltinLoginHandle {
  /** 已出现登录 URL/设备码或登录已结束时 resolve，便于调用方尽早展示。 */
  started: Promise<{ message?: string }>;
  completion: Promise<AcpAuthSnapshot>;
}

function assertLoginAllowed(config: AgentConfig): void {
  if (config.auth === "byok") throw new Error("BYOK configurations authenticate with an API key");
}

/**
 * 登录状态迁移：authenticating →（进程/authenticate 成功）authenticated，失败 → auth-required。
 * 终端方法按 ACP 约定以相同 argv/env 另起适配器进程，凭据只写入该配置的 CLI home。
 */
export function startBuiltinLogin(
  config: AgentConfig,
  options: { methodId?: string; deviceAuth?: boolean },
  deps: BuiltinLoginDependencies,
): BuiltinLoginHandle {
  assertLoginAllowed(config);
  const states = deps.authStates ?? acpAuthStateStore;
  states.markAuthenticating(config.id);
  let announce: (value: { message?: string }) => void = () => {};
  const started = new Promise<{ message?: string }>((resolve) => {
    announce = resolve;
  });
  const completion = (async (): Promise<AcpAuthSnapshot> => {
    try {
      const launch = await deps.resolveLaunch(config);
      if (options.deviceAuth) {
        if (config.runtime !== "codex")
          throw new Error("Device sign-in is only available for Codex");
        const codex = launch.env?.CODEX_PATH;
        if (!codex) throw new Error("Managed Codex binary is unavailable");
        await runLoginProcess(codex, ["login", "--device-auth"], launch.env, deps, announce);
      } else {
        const connection = await acpStartupGate.run(() =>
          AcpConnection.open(
            {
              executable: launch.executable,
              args: launch.args,
              cwd: deps.cwd,
              env: launch.env ?? {},
            },
            {
              onUpdate: () => {},
              requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
            },
          ),
        );
        let method: AuthMethod;
        try {
          states.recordMethods(
            config.id,
            summarizeAuthMethods(connection.initializeResponse.authMethods),
          );
          method = selectAuthMethod(
            config,
            connection.initializeResponse.authMethods,
            options.methodId,
          );
          if (!("type" in method) || method.type !== "terminal") {
            announce({ message: `Continue sign-in for ${config.name} in your browser` });
            await connection.authenticate(method.id);
          }
        } finally {
          await connection.close();
        }
        if ("type" in method && method.type === "terminal")
          await runLoginProcess(
            launch.executable,
            [...launch.args, ...(method.args ?? [])],
            { ...launch.env, ...method.env },
            deps,
            announce,
          );
      }
      states.markAuthenticated(config.id);
    } catch (error) {
      states.markAuthRequired(
        config.id,
        `Sign-in failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      announce({});
    }
    return states.get(config.id);
  })();
  return { started, completion };
}

/** 登出只作用于该配置的私有 home；cli-login 共享用户全局登录，拒绝代为登出。 */
export async function logoutBuiltinRuntime(
  config: AgentConfig,
  deps: BuiltinLoginDependencies,
): Promise<AcpAuthSnapshot> {
  assertLoginAllowed(config);
  if (config.auth === "cli-login")
    throw new Error("This configuration uses your global CLI login; sign out with the CLI itself");
  const states = deps.authStates ?? acpAuthStateStore;
  const launch = await deps.resolveLaunch(config);
  if (config.runtime === "claude-code")
    await runLoginProcess(
      launch.executable,
      [...launch.args, "--cli", "auth", "logout"],
      launch.env,
      deps,
      () => {},
    );
  else if (config.runtime === "codex") {
    const codex = launch.env?.CODEX_PATH;
    if (!codex) throw new Error("Managed Codex binary is unavailable");
    await runLoginProcess(codex, ["logout"], launch.env, deps, () => {});
  }
  states.markAuthRequired(config.id, "Signed out");
  return states.get(config.id);
}

const URL_PATTERN = /https?:\/\/\S+/;

async function runLoginProcess(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv | undefined,
  deps: BuiltinLoginDependencies,
  announce: (value: { message?: string }) => void,
): Promise<void> {
  const child = spawn(command, [...args], {
    cwd: deps.cwd,
    env: env ?? {},
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  const onChunk = (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    deps.onOutput?.(text);
    output = (output + text).slice(-OUTPUT_TAIL);
    if (URL_PATTERN.test(output)) announce({ message: output.trim() });
  };
  child.stdout.on("data", onChunk);
  child.stderr.on("data", onChunk);
  const timeout = setTimeout(() => child.kill("SIGTERM"), LOGIN_TIMEOUT_MS);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    if (code !== 0) throw new Error(`login process exited with ${code}`);
  } finally {
    clearTimeout(timeout);
  }
}
