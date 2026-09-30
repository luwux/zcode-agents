import {
  access,
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";
import { agentRuntimeIdSchema } from "@zcode/shared";
import { getAppConfigDir } from "#src/paths.js";

export interface ConfiguredAcpServer {
  id: string;
  name: string;
  command: string;
  args: readonly string[];
  fingerprint: string;
}

export interface AgentServerRegistryIssue {
  id: string;
  message: string;
}

export interface AgentServerRegistrySnapshot {
  path: string;
  servers: readonly ConfiguredAcpServer[];
  issues: readonly AgentServerRegistryIssue[];
}

const TRANSITIONAL_BUILTIN_IDS = new Set([
  // 内置 Runtime 默认配置 ID（agent-configs.json 命名空间）。
  "claude-code",
  "codex",
  "pi",
  "qoder-acp",
  "cline-acp",
  "codebuddy-acp",
  "workbuddy-acp",
]);

export function getAgentServersConfigPath(): string {
  return join(getAppConfigDir(), "agent-servers.json");
}

export function fingerprintAcpServer(command: string, args: readonly string[]): string {
  return createHash("sha256")
    .update(JSON.stringify([command, args]))
    .digest("hex");
}

/** Host 每次解析配置；无效项按 ID 隔离，不把用户输入交给 shell。 */
export async function readAgentServersRegistry(
  path = getAgentServersConfigPath(),
): Promise<AgentServerRegistrySnapshot> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { path, servers: [], issues: [] };
    return {
      path,
      servers: [],
      issues: [
        { id: "agent_servers", message: `Configuration could not be read: ${String(error)}` },
      ],
    };
  }
  if (
    !isPlainObject(raw) ||
    !hasOnlyKeys(raw, ["agent_servers"]) ||
    !isPlainObject(raw.agent_servers)
  )
    return {
      path,
      servers: [],
      issues: [{ id: "agent_servers", message: "Expected only an agent_servers object" }],
    };

  const servers: ConfiguredAcpServer[] = [];
  const issues: AgentServerRegistryIssue[] = [];
  for (const [id, value] of Object.entries(raw.agent_servers)) {
    const validId =
      agentRuntimeIdSchema.safeParse(id).success &&
      id !== "zcode-cli" &&
      !TRANSITIONAL_BUILTIN_IDS.has(id);
    if (!validId) {
      issues.push({ id, message: "Invalid or reserved Agent ID" });
      continue;
    }
    if (
      !isPlainObject(value) ||
      !hasOnlyKeys(value, ["name", "command", "args"]) ||
      typeof value.name !== "string" ||
      !value.name.trim() ||
      typeof value.command !== "string" ||
      !isAbsolute(value.command) ||
      !Array.isArray(value.args) ||
      !value.args.every((arg) => typeof arg === "string")
    ) {
      issues.push({ id, message: "Expected name, absolute command and string-array args" });
      continue;
    }
    try {
      const command = await realpath(value.command);
      if (!(await stat(command)).isFile()) throw new Error("not a file");
      await access(command, constants.X_OK);
      servers.push({
        id,
        name: value.name.trim(),
        command,
        args: [...value.args],
        fingerprint: fingerprintAcpServer(command, value.args),
      });
    } catch {
      issues.push({ id, message: `Command is missing or not executable: ${value.command}` });
    }
  }
  return { path, servers, issues };
}

/** 保存只修改指定 ID，拒绝覆盖格式错误的现有配置。 */
export async function saveAgentServerConfig(input: {
  id: string;
  name: string;
  command: string;
  args: readonly string[];
}): Promise<AgentServerRegistrySnapshot> {
  if (
    !agentRuntimeIdSchema.safeParse(input.id).success ||
    input.id === "zcode-cli" ||
    TRANSITIONAL_BUILTIN_IDS.has(input.id)
  )
    throw new Error("Agent ID is invalid or reserved");
  if (
    !input.name.trim() ||
    !isAbsolute(input.command) ||
    !input.args.every((arg) => typeof arg === "string")
  )
    throw new Error("Expected name, absolute command and string-array args");
  const command = await realpath(input.command);
  if (!(await stat(command)).isFile()) throw new Error("Agent command must be a file");
  await access(command, constants.X_OK);
  const path = getAgentServersConfigPath();
  let existing: unknown = { agent_servers: {} };
  try {
    existing = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (
    !isPlainObject(existing) ||
    !hasOnlyKeys(existing, ["agent_servers"]) ||
    !isPlainObject(existing.agent_servers)
  )
    throw new Error("Existing agent_servers configuration is invalid");
  const next = {
    agent_servers: {
      ...existing.agent_servers,
      [input.id]: { name: input.name.trim(), command, args: [...input.args] },
    },
  };
  await writeAgentServersDocument(path, next);
  return readAgentServersRegistry(path);
}

/** 删除只移除指定自定义 ID，保留其他条目与历史会话绑定。 */
export async function deleteAgentServerConfig(id: string): Promise<AgentServerRegistrySnapshot> {
  if (
    !agentRuntimeIdSchema.safeParse(id).success ||
    id === "zcode-cli" ||
    TRANSITIONAL_BUILTIN_IDS.has(id)
  )
    throw new Error("Agent ID is invalid or reserved");
  const path = getAgentServersConfigPath();
  const existing = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (
    !isPlainObject(existing) ||
    !hasOnlyKeys(existing, ["agent_servers"]) ||
    !isPlainObject(existing.agent_servers)
  )
    throw new Error("Existing agent_servers configuration is invalid");
  if (!Object.hasOwn(existing.agent_servers, id)) throw new Error("ACP supplier is not configured");
  const { [id]: _removed, ...remaining } = existing.agent_servers;
  await writeAgentServersDocument(path, { agent_servers: remaining });
  return readAgentServersRegistry(path);
}

async function writeAgentServersDocument(path: string, document: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
