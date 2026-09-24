/* oxlint-disable eslint(max-lines) -- ACP 连接的会话配置、模式确认与进程生命周期共享原生连接状态。 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Client,
  type ContentBlock,
  type InitializeResponse,
  type McpServer,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type SessionConfigOption,
  type SessionModeState,
} from "@agentclientprotocol/sdk";
import {
  shouldSpawnInDetachedProcessGroup,
  terminateProcessTreeAndWait,
} from "#src/process/processTreeTerminator.js";
import {
  buildAcpProjectMemoryContent,
  readAcpProjectMemoryIndex,
} from "#src/agent-runtime/acpProjectMemory.js";
import { AcpHostCapabilities } from "#src/agent-runtime/acpHostCapabilities.js";

const HANDSHAKE_TIMEOUT_MS = 10_000;
const SESSION_SETUP_TIMEOUT_MS = 60_000;
const CANCEL_TIMEOUT_MS = 5_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    }),
  ]).finally(() => clearTimeout(timeout));
}

export interface AcpLaunchConfig {
  executable: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  memory?: { workspaceIdentity?: string; isEnabled: () => boolean | Promise<boolean> };
  /** 后台记忆提取只允许模型返回文本，不向 Agent 暴露 Client 工具。 */
  textOnly?: boolean;
}

export interface AcpSessionObserver {
  onUpdate(notification: SessionNotification): void | Promise<void>;
  requestPermission(request: RequestPermissionRequest): Promise<RequestPermissionResponse>;
  onExit?(code: number | null, signal: NodeJS.Signals | null): void;
}

export interface AcpThinkingLevel {
  value: string;
  name: string;
  description?: string;
  selected: boolean;
}

export interface AcpModelOption {
  id: string;
  name: string;
  description?: string;
  selected: boolean;
}

const ACP_MODEL_PREFIX = "acp:model:";

function encodeModelOption(configId: string, value: string): string {
  return `${ACP_MODEL_PREFIX}${encodeURIComponent(configId)}:${encodeURIComponent(value)}`;
}

function decodeModelOption(id: string): { configId: string; value: string } | null {
  if (!id.startsWith(ACP_MODEL_PREFIX)) return null;
  const separator = id.indexOf(":", ACP_MODEL_PREFIX.length);
  if (separator < 0) return null;
  try {
    return {
      configId: decodeURIComponent(id.slice(ACP_MODEL_PREFIX.length, separator)),
      value: decodeURIComponent(id.slice(separator + 1)),
    };
  } catch {
    return null;
  }
}

function isThinkingOption(option: SessionConfigOption): boolean {
  return (
    option.type === "select" &&
    (option.category === "thought_level" ||
      (option.category === "model" && option.id === "reasoning_effort"))
  );
}

function thinkingValues(
  option: SessionConfigOption,
): Array<{ value: string; name: string; description?: string | null }> {
  if (option.type !== "select") return [];
  return option.options.flatMap((entry) => ("options" in entry ? entry.options : [entry]));
}

/** 一个受管进程只承载一条工作台会话；Host 负责持久绑定和发布投影。 */
export class AcpConnection {
  private nativeSessionId: string | null = null;
  private readonly commandResults = new Map<string, Promise<PromptResponse>>();
  private inFlight: Promise<PromptResponse> | null = null;
  private closed = false;
  private configOptions: SessionConfigOption[] = [];
  private modes: SessionModeState | null = null;
  private readonly pendingPermissionCancels = new Set<() => void>();

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly connection: ClientSideConnection,
    readonly initializeResponse: InitializeResponse,
    private readonly config: AcpLaunchConfig,
    private readonly hostCapabilities: AcpHostCapabilities,
  ) {}

  static async open(config: AcpLaunchConfig, observer: AcpSessionObserver): Promise<AcpConnection> {
    const child = spawn(config.executable, [...config.args], {
      cwd: config.cwd,
      env: config.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: shouldSpawnInDetachedProcessGroup(),
    });
    // Stderr may contain provider secrets. Drain it without echoing raw bytes.
    child.stderr.resume();
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      const stream = ndJsonStream(
        Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      );
      let active: AcpConnection | null = null;
      const hostCapabilities = new AcpHostCapabilities(
        config.cwd,
        config.memory?.workspaceIdentity,
        config.memory?.isEnabled,
        () => active?.sessionId ?? null,
        (request) =>
          active?.resolvePermissionRequest(request, observer) ??
          Promise.resolve({ outcome: { outcome: "cancelled" } }),
      );
      const client: Client = {
        async sessionUpdate(notification) {
          if (active?.sessionId && notification.sessionId !== active.sessionId) return;
          if (notification.update.sessionUpdate === "config_option_update")
            active?.updateConfigOptions(notification.update.configOptions);
          if (notification.update.sessionUpdate === "current_mode_update" && active?.modes)
            active.modes = { ...active.modes, currentModeId: notification.update.currentModeId };
          await observer.onUpdate(notification);
        },
        requestPermission(request) {
          return (
            active?.resolvePermissionRequest(request, observer) ??
            Promise.resolve({ outcome: { outcome: "cancelled" } })
          );
        },
        ...(config.textOnly
          ? {}
          : {
              readTextFile: hostCapabilities.readTextFile,
              writeTextFile: hostCapabilities.writeTextFile,
              createTerminal: hostCapabilities.createTerminal,
              terminalOutput: hostCapabilities.terminalOutput,
              waitForTerminalExit: hostCapabilities.waitForTerminalExit,
              killTerminal: hostCapabilities.killTerminal,
              releaseTerminal: hostCapabilities.releaseTerminal,
            }),
      };
      const connection = new ClientSideConnection(() => client, stream);
      const initializeResponse = await withTimeout(
        connection.initialize({
          protocolVersion: PROTOCOL_VERSION,
          // auth.terminal：订阅登录由 Host 以相同 argv/env 另起 CLI 登录进程完成（ACP terminal auth）。
          clientCapabilities: config.textOnly
            ? {}
            : {
                fs: { readTextFile: true, writeTextFile: true },
                terminal: true,
                auth: { terminal: true },
              },
          clientInfo: { name: "CodeZ", version: "1" },
        }),
        HANDSHAKE_TIMEOUT_MS,
        "ACP initialize",
      );
      if (initializeResponse.protocolVersion !== PROTOCOL_VERSION)
        throw new Error(`Unsupported ACP protocol version ${initializeResponse.protocolVersion}`);
      active = new AcpConnection(child, connection, initializeResponse, config, hostCapabilities);
      child.once("exit", (code, signal) => {
        active?.markExited();
        void hostCapabilities.close().catch(() => {});
        observer.onExit?.(code, signal);
      });
      return active;
    } catch (error) {
      await terminateProcessTreeAndWait(child, { ownedProcessGroupId: child.pid });
      throw error;
    }
  }

  /** 调用 Agent 公布的非终端认证方法（例如 Codex 的 chat-gpt）；终端方法由调用方另起进程。 */
  async authenticate(methodId: string): Promise<void> {
    if (this.closed) throw new Error("ACP process is closed");
    const method = this.initializeResponse.authMethods?.find(
      (candidate) => candidate.id === methodId,
    );
    if (!method)
      throw new Error(`ACP Agent does not advertise auth method ${JSON.stringify(methodId)}`);
    if ("type" in method && method.type === "terminal")
      throw new Error("Terminal auth methods must be run as a separate login process");
    await this.connection.authenticate({ methodId });
  }

  get sessionId(): string | null {
    return this.nativeSessionId;
  }

  thinkingLevels(): AcpThinkingLevel[] {
    const option = this.configOptions.find(isThinkingOption);
    if (!option || option.type !== "select") return [];
    return thinkingValues(option).map((value) => ({
      value: value.value,
      name: value.name,
      ...(value.description ? { description: value.description } : {}),
      selected: option.currentValue === value.value,
    }));
  }

  modelOptions(): AcpModelOption[] {
    return this.configOptions.flatMap((option) => {
      if (option.type !== "select" || option.category !== "model" || isThinkingOption(option))
        return [];
      return thinkingValues(option).map((value) => ({
        id: encodeModelOption(option.id, value.value),
        name: value.name,
        ...(value.description ? { description: value.description } : {}),
        selected: option.currentValue === value.value,
      }));
    });
  }

  async setModel(
    modelId: string,
  ): Promise<{ models: AcpModelOption[]; thinkingLevels: AcpThinkingLevel[] }> {
    const sessionId = this.requireSession();
    if (this.inFlight) throw new Error("ACP model cannot change during a prompt");
    const selection = decodeModelOption(modelId);
    if (!selection) throw new Error("Invalid ACP model selection");
    const option = this.configOptions.find(
      (candidate) =>
        candidate.type === "select" &&
        candidate.category === "model" &&
        !isThinkingOption(candidate) &&
        candidate.id === selection.configId,
    );
    if (
      !option ||
      option.type !== "select" ||
      !thinkingValues(option).some((candidate) => candidate.value === selection.value)
    )
      throw new Error("ACP model is unavailable");
    if (option.currentValue !== selection.value) {
      const updated = await withTimeout(
        this.connection.setSessionConfigOption({
          sessionId,
          configId: option.id,
          value: selection.value,
        }),
        SESSION_SETUP_TIMEOUT_MS,
        "ACP model selection",
      );
      this.updateConfigOptions(updated.configOptions);
      if (!this.modelOptions().some((model) => model.id === modelId && model.selected))
        throw new Error("ACP Agent did not confirm the requested model");
    }
    return { models: this.modelOptions(), thinkingLevels: this.thinkingLevels() };
  }

  async setThinkingLevel(value: string): Promise<AcpThinkingLevel[]> {
    const sessionId = this.requireSession();
    if (this.inFlight) throw new Error("ACP thought level cannot change during a prompt");
    const option = this.configOptions.find(isThinkingOption);
    if (!option || option.type !== "select")
      throw new Error("ACP Agent does not expose thought levels");
    if (!thinkingValues(option).some((candidate) => candidate.value === value))
      throw new Error(`ACP thought level ${JSON.stringify(value)} is unavailable`);
    if (option.currentValue === value) return this.thinkingLevels();
    const updated = await withTimeout(
      this.connection.setSessionConfigOption({ sessionId, configId: option.id, value }),
      SESSION_SETUP_TIMEOUT_MS,
      "ACP session/set_config_option",
    );
    this.updateConfigOptions(updated.configOptions);
    if (!this.thinkingLevels().some((level) => level.value === value && level.selected))
      throw new Error("ACP Agent did not confirm the requested thought level");
    return this.thinkingLevels();
  }

  async createSession(cwd: string, mcpServers: McpServer[] = []): Promise<string> {
    this.assertUnbound();
    const response = await withTimeout(
      this.connection.newSession({
        cwd,
        mcpServers,
      }),
      SESSION_SETUP_TIMEOUT_MS,
      "ACP session/new",
    );
    this.nativeSessionId = response.sessionId;
    this.modes = response.modes ?? null;
    if (response.configOptions) this.updateConfigOptions(response.configOptions);
    return response.sessionId;
  }

  async loadSession(
    nativeSessionId: string,
    cwd: string,
    mcpServers: McpServer[] = [],
  ): Promise<void> {
    this.assertUnbound();
    if (!this.initializeResponse.agentCapabilities?.loadSession)
      throw new Error("ACP Agent does not support session/load");
    const response = await withTimeout(
      this.connection.loadSession({
        sessionId: nativeSessionId,
        cwd,
        mcpServers,
      }),
      SESSION_SETUP_TIMEOUT_MS,
      "ACP session/load",
    );
    this.nativeSessionId = nativeSessionId;
    this.modes = response.modes ?? null;
    if (response.configOptions) this.updateConfigOptions(response.configOptions);
  }

  modeState(): SessionModeState | null {
    if (this.modes) return this.modes;
    const option = this.configOptions.find(
      (candidate) => candidate.category === "mode" && candidate.type === "select",
    );
    if (!option || option.type !== "select") return null;
    return {
      currentModeId: option.currentValue,
      availableModes: thinkingValues(option).map(({ value, name, description }) => ({
        id: value,
        name,
        ...(description ? { description } : {}),
      })),
    };
  }

  async setMode(modeId: string): Promise<SessionModeState> {
    const sessionId = this.requireSession();
    const modes = this.modeState();
    if (!modes?.availableModes.some((mode) => mode.id === modeId))
      throw new Error(`ACP Agent does not advertise mode ${JSON.stringify(modeId)}`);
    if (modes.currentModeId === modeId) return modes;
    if (this.modes) {
      await withTimeout(
        this.connection.setSessionMode({ sessionId, modeId }),
        SESSION_SETUP_TIMEOUT_MS,
        "ACP session/set_mode",
      );
      // set_mode 成功回包是本次切换的确认；Agent 也可经通知自行切换。
      this.modes = { ...this.modes, currentModeId: modeId };
      return this.modes;
    }
    const option = this.configOptions.find(
      (candidate) => candidate.category === "mode" && candidate.type === "select",
    );
    if (!option) throw new Error("ACP Agent mode option disappeared");
    const updated = await withTimeout(
      this.connection.setSessionConfigOption({ sessionId, configId: option.id, value: modeId }),
      SESSION_SETUP_TIMEOUT_MS,
      "ACP session/set_config_option",
    );
    this.updateConfigOptions(updated.configOptions);
    const confirmed = this.modeState();
    if (confirmed?.currentModeId !== modeId)
      throw new Error("ACP Agent did not confirm the requested mode");
    return confirmed;
  }

  prompt(commandId: string, prompt: ContentBlock[]): Promise<PromptResponse> {
    const sessionId = this.requireSession();
    const prior = this.commandResults.get(commandId);
    if (prior) return prior;
    if (this.inFlight) throw new Error("ACP session is already running a prompt");
    const result = (async () => {
      const memory = this.config.memory
        ? await readAcpProjectMemoryIndex({
            workspacePath: this.config.cwd,
            workspaceIdentity: this.config.memory.workspaceIdentity,
            enabled: await this.config.memory.isEnabled(),
          })
        : null;
      const memoryBlocks = buildAcpProjectMemoryContent(
        memory,
        this.initializeResponse.agentCapabilities,
      );
      return this.connection.prompt({ sessionId, prompt: [...memoryBlocks, ...prompt] });
    })();
    this.commandResults.set(commandId, result);
    this.inFlight = result;
    void result
      .finally(() => {
        if (this.inFlight === result) this.inFlight = null;
      })
      .catch(() => {});
    return result;
  }

  async cancel(): Promise<void> {
    const sessionId = this.requireSession();
    if (!this.inFlight) return;
    await this.connection.cancel({ sessionId });
    this.cancelPendingPermissions();
    try {
      await withTimeout(this.inFlight, CANCEL_TIMEOUT_MS, "ACP cancellation settlement");
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.cancelPendingPermissions();
    await this.hostCapabilities.close();
    const sessionId = this.nativeSessionId;
    if (sessionId && this.initializeResponse.agentCapabilities?.sessionCapabilities?.close) {
      await withTimeout(
        this.connection.closeSession({ sessionId }),
        CANCEL_TIMEOUT_MS,
        "ACP session/close",
      ).catch(() => {});
    }
    await terminateProcessTreeAndWait(this.child, { ownedProcessGroupId: this.child.pid });
  }

  private assertUnbound(): void {
    if (this.closed) throw new Error("ACP process is closed");
    if (this.nativeSessionId) throw new Error("ACP process is already bound to a session");
  }

  private requireSession(): string {
    if (this.closed) throw new Error("ACP process is closed");
    if (!this.nativeSessionId) throw new Error("ACP session has not been created or loaded");
    return this.nativeSessionId;
  }

  private updateConfigOptions(options: SessionConfigOption[]): void {
    this.configOptions = options;
  }

  private async resolvePermissionRequest(
    request: RequestPermissionRequest,
    observer: AcpSessionObserver,
  ): Promise<RequestPermissionResponse> {
    const cancelled: RequestPermissionResponse = { outcome: { outcome: "cancelled" } };
    if (this.closed || !this.nativeSessionId || request.sessionId !== this.nativeSessionId)
      return cancelled;
    let cancel: () => void = () => {};
    const closed = new Promise<RequestPermissionResponse>((resolve) => {
      cancel = () => resolve(cancelled);
    });
    this.pendingPermissionCancels.add(cancel);
    try {
      const response = await Promise.race([observer.requestPermission(request), closed]);
      const outcome = response.outcome;
      if (
        outcome.outcome === "selected" &&
        !request.options.some((option) => option.optionId === outcome.optionId)
      )
        return cancelled;
      return response;
    } finally {
      this.pendingPermissionCancels.delete(cancel);
    }
  }

  private cancelPendingPermissions(): void {
    for (const cancel of this.pendingPermissionCancels) cancel();
    this.pendingPermissionCancels.clear();
  }

  private markExited(): void {
    this.closed = true;
    this.cancelPendingPermissions();
  }
}
