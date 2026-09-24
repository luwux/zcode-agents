/* oxlint-disable eslint(max-lines) -- ACP 连接的会话配置、模式确认与进程生命周期共享原生连接状态。 */
import {
  detectAcpSteering,
  steerAcpSession,
  type AcpSteerOutcome,
  type AcpSteeringKind,
} from "#src/agent-runtime/acpSteering.js";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Client,
  type ClientCapabilities,
  type ContentBlock,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  type InitializeResponse,
  type McpServer,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
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
import type { AcpUpdateNotification } from "#src/agent-runtime/acpExtensionSchemas.js";
import {
  AcpChildSessionRegistry,
  carryAcpExtensionUpdates,
  unwrapAcpExtensionUpdate,
} from "#src/agent-runtime/acpExtensionStream.js";

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
  /** sessionId 为根会话或已宣告的子会话；扩展 update 已解包并经 zod 校验。 */
  onUpdate(notification: AcpUpdateNotification): void | Promise<void>;
  requestPermission(request: RequestPermissionRequest): Promise<RequestPermissionResponse>;
  /** form 模式问答；未实现时 Host 以 decline 应答。 */
  requestElicitation?(request: CreateElicitationRequest): Promise<CreateElicitationResponse>;
  onExit?(code: number | null, signal: NodeJS.Signals | null): void;
}

/**
 * 声明的扩展能力：原生子会话（ACP RFD `subagents` 与 AIR `nativeSubagentSessions`）、AIR 后台任务与 form 问答。
 * SDK 1.4 的 ClientCapabilities 没有 `subagents` 字段，按 wire 形状断言；SDK 发送时原样透传。
 */
const EXTENDED_CLIENT_CAPABILITIES = {
  fs: { readTextFile: true, writeTextFile: true },
  terminal: true,
  auth: { terminal: true },
  elicitation: { form: {} },
  subagents: {},
  _meta: {
    jetbrains: { air: { version: 1, capabilities: ["nativeSubagentSessions", "asyncTasks"] } },
  },
} as ClientCapabilities;

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
  private readonly pendingInteractionCancels = new Set<() => void>();

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly connection: ClientSideConnection,
    readonly initializeResponse: InitializeResponse,
    private readonly config: AcpLaunchConfig,
    private readonly hostCapabilities: AcpHostCapabilities,
    private readonly children: AcpChildSessionRegistry,
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
      let active: AcpConnection | null = null;
      const children = new AcpChildSessionRegistry(() => active?.sessionId ?? null);
      // SDK 1.4 拒收 subagent_*/async_task_*：先在线序上改写为载体，再交给 SDK。
      const stream = carryAcpExtensionUpdates(
        ndJsonStream(
          Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
          Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
        ),
        children,
      );
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
          // 修复：原先只接纳根 sessionId，原生子智能体的全部更新被丢弃；现在接纳已宣告的子会话，其余仍丢弃。
          if (active?.sessionId && !children.accepts(notification.sessionId)) return;
          const update = unwrapAcpExtensionUpdate(notification.update);
          if (!update) return;
          const fromRoot = !active?.sessionId || notification.sessionId === active.sessionId;
          // 子会话的配置/模式属于子 Agent 自身，不能改写根会话的已确认配置。
          if (fromRoot && update.sessionUpdate === "config_option_update")
            active?.updateConfigOptions(update.configOptions);
          if (fromRoot && update.sessionUpdate === "current_mode_update" && active?.modes)
            active.modes = { ...active.modes, currentModeId: update.currentModeId };
          await observer.onUpdate({ sessionId: notification.sessionId, update });
        },
        requestPermission(request) {
          return (
            active?.resolvePermissionRequest(request, observer) ??
            Promise.resolve({ outcome: { outcome: "cancelled" } })
          );
        },
        createElicitation(request) {
          return (
            active?.resolveElicitationRequest(request, observer) ??
            Promise.resolve({ action: "cancel" })
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
          clientCapabilities: config.textOnly ? {} : EXTENDED_CLIENT_CAPABILITIES,
          clientInfo: { name: "CodeZ", version: "1" },
        }),
        HANDSHAKE_TIMEOUT_MS,
        "ACP initialize",
      );
      if (initializeResponse.protocolVersion !== PROTOCOL_VERSION)
        throw new Error(`Unsupported ACP protocol version ${initializeResponse.protocolVersion}`);
      active = new AcpConnection(
        child,
        connection,
        initializeResponse,
        config,
        hostCapabilities,
        children,
      );
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

  /** Agent 声明的运行中 steering 方式；null 表示运行中输入只能拒绝。 */
  get steeringKind(): AcpSteeringKind | null {
    return detectAcpSteering(this.initializeResponse);
  }

  get running(): boolean {
    return this.inFlight !== null;
  }

  /** 把输入注入正在运行的 turn；promptRequired 表示 Agent 已空闲，内容仍由 Host 负责提交。 */
  async steer(steerId: string, prompt: ContentBlock[]): Promise<AcpSteerOutcome> {
    const sessionId = this.requireSession();
    const kind = this.steeringKind;
    if (!kind) throw new Error("ACP Agent does not support steering");
    return withTimeout(
      steerAcpSession(this.connection, kind, { sessionId, steerId, prompt }),
      SESSION_SETUP_TIMEOUT_MS,
      "ACP steering",
    );
  }

  get sessionId(): string | null {
    return this.nativeSessionId;
  }

  /** 该 sessionId 是否为 Agent 已宣告的子会话（非根）。 */
  isChildSession(sessionId: string): boolean {
    return sessionId !== this.nativeSessionId && this.children.isChild(sessionId);
  }

  /** 调用 Agent 的扩展请求（`_session/async_task/stop`、`_lody/subagents/cancel`）。 */
  async extRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    this.requireSession();
    return withTimeout(
      this.connection.request<unknown, Record<string, unknown>>(method, params),
      SESSION_SETUP_TIMEOUT_MS,
      `ACP ${method}`,
    );
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
    // 运行中允许：Agent 在下一次模型请求时应用；拒绝时由协调器延后到 turn 结束。
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
    // 运行中允许（与 ZCode guide 语义一致）；Agent 拒绝时由协调器延后到 turn 结束。
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
    this.cancelPendingInteractions();
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
    this.cancelPendingInteractions();
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
    // 子智能体的权限请求使用已宣告的子 sessionId；未知或已终结的子会话一律 cancelled。
    if (
      this.closed ||
      !this.nativeSessionId ||
      !this.children.acceptsInteraction(request.sessionId)
    )
      return cancelled;
    const response = await this.raceWithClose(observer.requestPermission(request), cancelled);
    const outcome = response.outcome;
    if (
      outcome.outcome === "selected" &&
      !request.options.some((option) => option.optionId === outcome.optionId)
    )
      return cancelled;
    return response;
  }

  private async resolveElicitationRequest(
    request: CreateElicitationRequest,
    observer: AcpSessionObserver,
  ): Promise<CreateElicitationResponse> {
    const sessionId = "sessionId" in request ? request.sessionId : undefined;
    if (this.closed || !this.nativeSessionId) return { action: "cancel" };
    // 只声明了 form 模式；URL/自定义模式及非会话作用域的请求明确拒绝，而不是悬挂。
    if (
      request.mode !== "form" ||
      typeof sessionId !== "string" ||
      !this.children.acceptsInteraction(sessionId) ||
      !observer.requestElicitation
    )
      return { action: "decline" };
    return this.raceWithClose(observer.requestElicitation(request), { action: "cancel" });
  }

  /** 取消、断线或进程退出时，等待中的交互以给定结果收口，不自动允许。 */
  private async raceWithClose<T>(pending: Promise<T>, onClose: T): Promise<T> {
    let cancel: () => void = () => {};
    const closed = new Promise<T>((resolve) => {
      cancel = () => resolve(onClose);
    });
    this.pendingInteractionCancels.add(cancel);
    try {
      return await Promise.race([pending, closed]);
    } finally {
      this.pendingInteractionCancels.delete(cancel);
    }
  }

  private cancelPendingInteractions(): void {
    for (const cancel of this.pendingInteractionCancels) cancel();
    this.pendingInteractionCancels.clear();
  }

  private markExited(): void {
    this.closed = true;
    this.cancelPendingInteractions();
  }
}
