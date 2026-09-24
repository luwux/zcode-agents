/* oxlint-disable eslint(max-lines) -- ACP 更新、回放与 V4 投影共享同一会话状态；映射细节已拆到 acpToolCallProjection、acpSubagentLifecycle、acpBackgroundWorks、acpInteractions、acpRowLog。 */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type {
  PromptResponse,
  RequestPermissionRequest,
  SessionModeState,
} from "@agentclientprotocol/sdk";
import type {
  AttachmentRef,
  BackgroundWorkSummary,
  ConversationSnapshot,
  GoalState,
  PlanState,
  ToolCallRow,
  UserInputRequestPayload,
} from "@zcode/shared/zcode-protocol-v4";
import type { AcpTranscriptEntry } from "#src/agent-runtime/acpTranscriptStore.js";
import type { AcpModelOption, AcpThinkingLevel } from "#src/agent-runtime/acpConnection.js";
import { buildAcpProjectionSnapshot } from "#src/agent-runtime/acpProjectionSnapshot.js";
import {
  acpExtensionLogger,
  isAcpExtensionUpdate,
  parseAcpExtensionUpdate,
  readAcpGoalMeta,
  readAirBackgrounded,
  readLodyTaskMeta,
  type AcpExtensionUpdate,
  type AcpSessionUpdate,
} from "#src/agent-runtime/acpExtensionSchemas.js";
import {
  boundedJson,
  projectAcpToolDisplay,
  projectAcpToolInput,
  projectAcpToolOutput,
  resolveAcpToolIdentity,
  type AcpToolIdentity,
  type AcpToolUpdate,
} from "#src/agent-runtime/acpToolCallProjection.js";
import {
  AcpSubagentRegistry,
  buildSubagentState,
  listSubagents,
} from "#src/agent-runtime/acpSubagentRegistry.js";
import {
  applyLodyTask,
  lodyTaskKey,
  settleSubagent,
  spawnNativeSubagent,
} from "#src/agent-runtime/acpSubagentLifecycle.js";
import {
  AcpBackgroundWorkTracker,
  pickBackgroundAttribution,
  type AcpBackgroundAttribution,
} from "#src/agent-runtime/acpBackgroundWorks.js";
import { AcpInteractionBook } from "#src/agent-runtime/acpInteractions.js";
import { AcpRowLog } from "#src/agent-runtime/acpRowLog.js";
import {
  acpPromptFailure,
  mapAcpToolStatus,
  projectAcpGoal,
} from "#src/agent-runtime/acpProjectionSupport.js";

export { acpPromptFailure } from "#src/agent-runtime/acpProjectionSupport.js";

export interface AcpProjectionOptions {
  /** 子会话投影：只读，由根投影创建并共享同一登记表。 */
  readOnly?: boolean;
  registry?: AcpSubagentRegistry<AcpConversationProjection>;
}

/** ACP 会话自身的只读工作台投影，不借用 ZCode CLI 的 SessionRecord。 */
export class AcpConversationProjection {
  private readonly logEpoch = randomUUID();
  /** @internal 行日志由子会话生命周期（acpSubagentLifecycle）直接追加宿主行。 */
  readonly log: AcpRowLog;
  private readonly rowByMessageId = new Map<string, number>();
  private readonly rowByToolCallId = new Map<string, number>();
  private readonly toolIdentities = new Map<string, AcpToolIdentity>();
  private readonly reasoningStartedAt = new Map<number, number>();
  private anonymousChunkRow: { kind: "assistantText" | "reasoning"; rowId: number } | null = null;
  private activeTurnId: string | null = null;
  private activeTurnHeaderRowId: number | null = null;
  /** 回合外内容的仅展示轮（D4）：不改变 phase，也不占用回合所有权。 */
  private displayTurn: { turnId: string; workId: string } | null = null;
  private phase: ConversationSnapshot["control"]["phase"] = "draft";
  private plan: PlanState | null = null;
  private goal: GoalState | null = null;
  private readonly interactions: AcpInteractionBook<AcpConversationProjection>;
  private readonly works = new AcpBackgroundWorkTracker();
  private readonly registry: AcpSubagentRegistry<AcpConversationProjection>;
  private readonly readOnly: boolean;
  private lodySubagentCancel = false;
  private thoughtLevels: string[] = [];
  private thought = "";
  private model = "";
  private modelOptions: Array<{ id: string; name: string }> = [];
  private modes: SessionModeState | null = null;
  private unavailableReason: string | null = null;
  private lastError: {
    code: string;
    message: string;
    recoverable: boolean;
    at: number;
    source: "runtime";
  } | null = null;

  constructor(
    readonly taskId: string,
    private title = "",
    private readonly runtimeId?: import("@zcode/shared").AgentRuntimeId,
    initialModel = "",
    initialThought = "",
    options: AcpProjectionOptions = {},
  ) {
    this.model = initialModel;
    this.thought = initialThought;
    this.readOnly = options.readOnly === true;
    this.log = new AcpRowLog(taskId);
    this.registry = options.registry ?? new AcpSubagentRegistry(taskId);
    this.interactions = new AcpInteractionBook(this.registry);
    if (!options.registry)
      this.registry.onSettle = (entry) => this.dropChildInteractions(entry.key);
  }

  private get root(): boolean {
    return this.registry.rootTaskId === this.taskId;
  }

  /** 只重放工作台已记录的 ACP 事件；不依赖 Agent 的私有历史格式。 */
  restore(entries: readonly AcpTranscriptEntry[]): void {
    if (this.log.rows.length > 0 || this.activeTurnId)
      throw new Error("ACP projection is already populated");
    let lastAt = 0;
    for (const entry of entries) {
      lastAt = Math.max(lastAt, entry.at);
      if (entry.kind === "prompt") {
        if (this.activeTurnId)
          this.finishTurn({ error: "ACP turn ended without a terminal response" });
        const text = entry.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n");
        const attachments: AttachmentRef[] = entry.content.flatMap((block) => {
          if (block.type !== "resource_link" || !block.uri.startsWith("file:")) return [];
          try {
            return [
              {
                ref: fileURLToPath(block.uri),
                fileName: block.name,
                mime: block.mimeType ?? "application/octet-stream",
                bytes: block.size ?? 0,
              },
            ];
          } catch {
            return [];
          }
        });
        this.beginTurn(entry.commandId, text, attachments, entry.at);
      } else if (entry.kind === "update") {
        this.applyUpdate({ sessionId: entry.sessionId, update: entry.update }, entry.at);
      } else {
        this.finishTurn(entry.result, entry.at);
      }
    }
    if (this.activeTurnId)
      this.finishTurn({ error: "ACP turn outcome is unknown after process exit" });
    // 旧进程已退出：回放结束时仍在运行的子智能体与后台任务不可能继续。
    this.failOrphans(lastAt, "Subagent outcome is unknown after the Agent process exited");
  }

  beginTurn(
    commandId: string,
    text: string,
    attachments?: readonly AttachmentRef[],
    at = Date.now(),
    origin: "realUser" | "synthetic" = "realUser",
  ): void {
    if (this.activeTurnId) throw new Error("ACP projection already has an active turn");
    this.closeDisplayTurn(at);
    this.anonymousChunkRow = null;
    const turnId = randomUUID();
    this.activeTurnId = turnId;
    this.phase = "running";
    this.lastError = null;
    const header = this.log.push({
      kind: "turnHeader",
      turnId,
      origin: "userInput",
      executionKind: "agent",
      sourceCommandId: commandId,
      state: "running",
      startedAt: at,
    });
    this.activeTurnHeaderRowId = header.rowId;
    this.log.push({
      kind: "userInput",
      turnId,
      text,
      origin,
      sourceCommandId: commandId,
      ...(attachments?.length ? { attachments: [...attachments] } : {}),
    });
  }

  /** sessionId 为已登记子会话时路由到对应子投影；其余（含旧转录缺省）属于本投影。 */
  applyUpdate(
    notification: { sessionId?: string; update: AcpSessionUpdate },
    at = Date.now(),
  ): void {
    // 转录来自磁盘：扩展 update 回放时再次校验，非法即丢弃。
    const update = isAcpExtensionUpdate(notification.update)
      ? parseAcpExtensionUpdate(notification.update)
      : notification.update;
    if (!update) return;
    const child = notification.sessionId
      ? this.registry.bySession(notification.sessionId)
      : undefined;
    if (child && child.projection !== this) child.projection.applyOwnUpdate(update, at);
    else this.applyOwnUpdate(update, at);
  }

  private applyOwnUpdate(update: AcpSessionUpdate, at: number): void {
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
      case "agent_thought_chunk":
        this.applyChunk(update, at);
        return;
      case "tool_call":
      case "tool_call_update":
        this.applyToolCall(update, at);
        this.anonymousChunkRow = null;
        return;
      case "plan":
        this.completeReasoning(at);
        this.plan = {
          items: update.entries.map((entry, index) => ({
            id: `acp-${index}`,
            content: entry.content,
            status: entry.status === "in_progress" ? "inProgress" : entry.status,
          })),
          updatedAt: at,
        };
        this.anonymousChunkRow = null;
        this.log.advance();
        return;
      case "session_info_update":
        this.applySessionInfo(update);
        return;
      case "current_mode_update":
        if (!this.modes) return;
        this.modes = { ...this.modes, currentModeId: update.currentModeId };
        this.log.advance();
        return;
      case "subagent_spawned":
      case "subagent_state_update":
      case "async_task_spawned":
      case "async_task_progress":
      case "async_task_state_update":
        this.applyExtension(update, at);
        return;
      default:
        return;
    }
  }

  private applyChunk(
    update: Extract<
      AcpSessionUpdate,
      { sessionUpdate: "agent_message_chunk" | "agent_thought_chunk" }
    >,
    at: number,
  ): void {
    if (update.sessionUpdate === "agent_message_chunk") this.completeReasoning(at);
    if (update.content.type !== "text") return;
    const turnId = this.lifecycleTurn(at, null);
    if (!turnId) return;
    const kind = update.sessionUpdate === "agent_message_chunk" ? "assistantText" : "reasoning";
    const key = update.messageId ? `${kind}:${update.messageId}` : null;
    // ACP 不要求 messageId。无 ID 的连续同类 chunk 属于同一段流式消息，
    // 不能把每个 token 投影成独立的思考/回复块。
    const existing = this.log.at(
      key
        ? this.rowByMessageId.get(key)
        : this.anonymousChunkRow?.kind === kind
          ? this.anonymousChunkRow.rowId
          : undefined,
    );
    if (existing && (existing.kind === "assistantText" || existing.kind === "reasoning")) {
      this.log.replace({ ...existing, text: existing.text + update.content.text });
    } else {
      // 展示轮不是运行中的回合：文本直接为完成态，不显示流式指示。
      const state = turnId === this.activeTurnId ? "streaming" : "complete";
      const row = this.log.push({ kind, turnId, text: update.content.text, state });
      if (key) this.rowByMessageId.set(key, row.rowId);
      else this.anonymousChunkRow = { kind, rowId: row.rowId };
      if (kind === "reasoning" && state === "streaming") this.reasoningStartedAt.set(row.rowId, at);
    }
    if (key) this.anonymousChunkRow = null;
  }

  private applyToolCall(update: AcpToolUpdate, at: number): void {
    const lodyTask = readLodyTaskMeta(update._meta);
    // Pi 的子任务生命周期借 tool_call 承载（toolCallId = taskId），不是工具行。
    if (lodyTask || this.registry.get(lodyTaskKey(update.toolCallId))?.kind === "lodyTask") {
      if (lodyTask) applyLodyTask(this, this.registry, lodyTask, at);
      this.log.advance();
      return;
    }
    this.completeReasoning(at);
    const status = mapAcpToolStatus(update.status);
    const existingRow = this.log.at(this.rowByToolCallId.get(update.toolCallId));
    const existing = existingRow?.kind === "toolCall" ? existingRow : undefined;
    const turnId = existing?.turnId ?? this.lifecycleTurn(at, null);
    if (!turnId) return;
    const identity = resolveAcpToolIdentity(update, this.toolIdentities.get(update.toolCallId));
    this.toolIdentities.set(update.toolCallId, identity);
    const input = projectAcpToolInput(update, identity, existing?.input);
    const terminal = status === "success" || status === "error" ? status : null;
    const { output, imageDisplay } = projectAcpToolOutput(update, identity, terminal);
    const display = imageDisplay ?? projectAcpToolDisplay(identity) ?? existing?.display;
    const common = {
      toolName: identity.toolName,
      inputText: input === undefined ? (existing?.inputText ?? "") : boundedJson(input),
      ...(input !== undefined ? { input } : {}),
      ...(output ? { output } : {}),
      ...(display ? { display } : {}),
      ...(readAirBackgrounded(update._meta) ? { backgrounded: true as const } : {}),
      ...(status === "error"
        ? {
            error: {
              code: "acpToolFailed",
              message: `${update.title ?? identity.toolName} failed`,
            },
          }
        : {}),
    };
    if (existing) {
      this.log.replace({
        ...existing,
        ...common,
        status: status ?? existing.status,
        ...(terminal ? { endedAt: at } : {}),
      });
      return;
    }
    const row = this.log.push({
      kind: "toolCall",
      turnId,
      toolCallId: update.toolCallId,
      status: status ?? "inputStreaming",
      startedAt: at,
      ...(terminal ? { endedAt: at } : {}),
      ...common,
    });
    this.rowByToolCallId.set(update.toolCallId, row.rowId);
  }

  private applySessionInfo(
    update: Extract<AcpSessionUpdate, { sessionUpdate: "session_info_update" }>,
  ): void {
    if (update.title) {
      this.title = update.title;
      this.log.advance();
    }
    const goal = readAcpGoalMeta(update._meta);
    if (!goal.present) return;
    const previous = this.goal;
    this.goal = goal.goal ? projectAcpGoal(goal.goal) : null;
    if (goal.goal && this.activeTurnId && previous?.objective !== goal.goal.objective) {
      this.log.push({
        kind: "timelineMarker",
        turnId: this.activeTurnId,
        marker: {
          type: "goalSet",
          objective: goal.goal.objective,
          ...(previous ? { previousObjective: previous.objective } : {}),
        },
      });
    }
    this.log.advance();
  }

  private applyExtension(update: AcpExtensionUpdate, at: number): void {
    if (update.sessionUpdate === "subagent_spawned") {
      spawnNativeSubagent(
        this,
        this.registry,
        { key: update.subagentSessionId, name: update.name, task: update.task },
        at,
      );
    } else if (update.sessionUpdate === "subagent_state_update") {
      const entry = this.registry.get(update.subagentSessionId);
      if (entry)
        settleSubagent(
          this.registry,
          entry,
          update.state === "completed"
            ? "success"
            : update.state === "cancelled"
              ? "cancelled"
              : "failed",
          at,
          update.state === "disconnected" ? "Subagent disconnected" : undefined,
        );
    } else {
      const affected = this.works.apply(update, at);
      const row = affected?.toolCallId ? this.findToolRow(affected.toolCallId) : undefined;
      if (affected && row && (row.backgrounded !== true || row.workId !== affected.workId))
        this.log.replace({ ...row, backgrounded: true, workId: affected.workId });
    }
    this.log.advance();
  }

  /** @internal 子会话生命周期创建只读子投影，共享根登记表。 */
  createChild(virtualId: string, title: string, model: string): this {
    return new AcpConversationProjection(virtualId, title, this.runtimeId, model, "", {
      readOnly: true,
      registry: this.registry,
    }) as this;
  }

  private failOrphans(at: number, reason: string): void {
    if (!this.root) return;
    for (const entry of this.registry.all())
      if (entry.status === "running") settleSubagent(this.registry, entry, "failed", at, reason);
    this.works.failRunning(at);
  }

  /** 进程退出后，后台子智能体与异步任务随旧进程结束，不能在回合外永远显示为运行中。 */
  markProcessExited(at = Date.now()): void {
    this.failOrphans(at, "ACP process exited");
    this.log.advance();
  }

  finishTurn(result: PromptResponse | { error: string }, endedAt = Date.now()): void {
    if (!this.activeTurnId) return;
    const failure = acpPromptFailure(result);
    const failed = failure !== null || this.unavailableReason !== null;
    const cancelled = !failed && "stopReason" in result && result.stopReason === "cancelled";
    this.completeReasoning(endedAt, cancelled || failed);
    // 根回合被取消或失败时子智能体随之结束；正常结束则保留（可能是后台子智能体）。
    if (this.root && (failed || cancelled)) {
      for (const entry of this.registry.all())
        if (entry.status === "running")
          settleSubagent(
            this.registry,
            entry,
            cancelled ? "cancelled" : "failed",
            endedAt,
            "Parent turn failed",
          );
    }
    this.lastError = failure
      ? {
          code: "acpPromptFailed",
          message: failure,
          recoverable: true,
          at: endedAt,
          source: "runtime",
        }
      : null;
    this.phase = failed ? "error" : cancelled ? "completedInterrupted" : "completedSuccess";
    // 仍在运行的后台子智能体的宿主行不是“未收到终态的工具”。
    const liveHosts = new Set(
      this.registry
        .childrenOf(this.taskId)
        .filter((entry) => entry.status === "running")
        .map((entry) => entry.hostToolCallId),
    );
    const rows = this.log.rows;
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index]!;
      if (row.turnId !== this.activeTurnId) continue;
      if (row.kind === "turnHeader" && row.rowId === this.activeTurnHeaderRowId) {
        rows[index] = {
          ...row,
          state: failed ? "failed" : cancelled ? "completedInterrupted" : "completedSuccess",
          endedAt,
        };
      } else if (row.kind === "assistantText" && row.state === "streaming") {
        rows[index] = { ...row, state: failed ? "failed" : cancelled ? "interrupted" : "complete" };
      } else if (
        row.kind === "toolCall" &&
        !liveHosts.has(row.toolCallId) &&
        row.status !== "success" &&
        row.status !== "error" &&
        row.status !== "cancelled"
      ) {
        rows[index] = {
          ...row,
          status: cancelled ? "cancelled" : "error",
          ...(cancelled
            ? {}
            : {
                error: {
                  code: "acpToolIncomplete",
                  message: "Tool ended without a terminal update",
                },
              }),
          endedAt,
        };
      }
    }
    this.activeTurnId = null;
    this.activeTurnHeaderRowId = null;
    this.clearTurnMaps();
    // 根会话自有的交互随 prompt 结束；仍在后台运行的子智能体的交互保留。
    this.interactions.clearRootOwned();
    this.log.advance();
  }

  /** childSessionId 来自连接级登记表；origin 与锚点在 snapshot 时解析（见 AcpInteractionBook）。 */
  requestPermission(
    request: RequestPermissionRequest,
    interactionId = request.toolCall.toolCallId,
    childSessionId?: string,
  ): string {
    this.interactions.addPermission(interactionId, request, childSessionId);
    this.log.advance();
    return interactionId;
  }

  /** form elicitation 呈现为 userInput 交互；子会话的请求挂在根会话并带 origin。 */
  requestUserInput(
    interactionId: string,
    payload: UserInputRequestPayload,
    childSessionId?: string,
  ): void {
    this.interactions.addUserInput(interactionId, payload, childSessionId);
    this.log.advance();
  }

  settlePermission(interactionId: string): void {
    this.settleInteraction(interactionId);
  }

  settleInteraction(interactionId: string): void {
    if (this.interactions.delete(interactionId)) this.log.advance();
  }

  hasInteraction(interactionId: string): boolean {
    return this.interactions.has(interactionId);
  }

  private dropChildInteractions(childSessionId: string): void {
    this.interactions.dropChild(childSessionId);
    this.log.advance();
  }

  setThinkingLevels(levels: readonly AcpThinkingLevel[]): void {
    this.thoughtLevels = levels.map((level) => level.value);
    this.thought = levels.find((level) => level.selected)?.value ?? "";
    this.log.advance();
  }

  setModelOptions(models: readonly AcpModelOption[]): void {
    this.modelOptions = models.map((model) => ({ id: model.id, name: model.name }));
    this.model = models.find((model) => model.selected)?.id ?? "";
    this.log.advance();
  }

  setModes(modes: SessionModeState | null): void {
    this.modes = modes;
    this.log.advance();
  }

  setTitle(title: string): void {
    if (this.title === title) return;
    this.title = title;
    this.log.advance();
  }

  /** Pi 公布 `_lody/subagents/cancel` 时子任务在状态面板可停止。 */
  setLodySubagentCancel(enabled: boolean): void {
    this.lodySubagentCancel = enabled;
  }

  markUnavailable(reason: string): void {
    this.phase = "error";
    this.unavailableReason = reason;
    this.log.advance();
  }

  /** 虚拟子会话 id 对应的只读子投影。 */
  childProjection(virtualId: string): AcpConversationProjection | null {
    return this.registry.byVirtualId(virtualId)?.projection ?? null;
  }

  listSubagents(sessionId: string, endedCursor: string | undefined, endedLimit: number) {
    return listSubagents(this.registry, sessionId, this.blocked(), endedCursor, endedLimit);
  }

  /** cancelBackgroundWork 的目标：AIR 异步任务或 Pi 子任务。 */
  backgroundWorkTarget(
    workId: string,
  ): { kind: "asyncTask" | "lodyTask"; running: boolean; cancellable: boolean } | null {
    const task = this.works.cancelTarget(workId);
    if (task) return { kind: "asyncTask", ...task };
    const entry = this.registry.get(lodyTaskKey(workId));
    if (entry?.kind !== "lodyTask" || entry.parentTaskId !== this.taskId) return null;
    return {
      kind: "lodyTask",
      running: entry.status === "running",
      cancellable: this.lodySubagentCancel,
    };
  }

  snapshot(): ConversationSnapshot {
    return buildAcpProjectionSnapshot({
      taskId: this.taskId,
      logEpoch: this.logEpoch,
      seq: this.log.seq,
      revision: this.log.revision,
      phase: this.phase,
      title: this.title,
      runtimeId: this.runtimeId,
      model: this.model,
      thought: this.thought,
      thoughtLevels: this.thoughtLevels,
      modelOptions: this.modelOptions,
      modes: this.modes,
      permissions: this.interactions.list(
        (toolCallId) => this.findToolRow(toolCallId)?.rowId ?? null,
      ),
      plan: this.plan,
      goal: this.goal,
      rows: this.log.rows,
      readOnly: this.readOnly,
      backgroundWorks: [
        ...this.works.summaries((toolCallId) => this.findToolRow(toolCallId)?.rowId ?? null),
        ...this.lodyWorks(),
      ],
      subagents: buildSubagentState(this.registry, this.taskId, this.blocked()),
      unavailableReason: this.unavailableReason,
      lastError: this.lastError,
    });
  }

  rowsRange(beforeRowId: number | undefined, limit: number) {
    const snapshot = this.snapshot();
    const earlier = this.log.rows.filter(
      (row) => beforeRowId === undefined || row.rowId < beforeRowId,
    );
    return {
      rows: earlier.slice(-limit),
      atSeq: snapshot.seq,
      atRevision: snapshot.revision,
      atLogEpoch: snapshot.logEpoch,
      hasMore: earlier.length > limit,
    };
  }

  private lodyWorks(): BackgroundWorkSummary[] {
    const cancellable = this.rootProjection().lodySubagentCancel;
    return this.registry
      .childrenOf(this.taskId)
      .filter((entry) => entry.kind === "lodyTask" && entry.status === "running")
      .map((entry) => ({
        workId: entry.lodyTaskId ?? entry.key,
        kind: "subagent" as const,
        title: entry.name,
        status: "running" as const,
        startedAt: entry.startedAt,
        cancellable,
        anchorRowId: entry.subagentRowId,
        childSessionId: entry.virtualId,
      }));
  }

  private rootProjection(): AcpConversationProjection {
    if (this.root) return this;
    let entry = this.registry.byVirtualId(this.taskId);
    while (entry && entry.parentTaskId !== this.registry.rootTaskId)
      entry = this.registry.byVirtualId(entry.parentTaskId);
    return entry?.parent ?? this;
  }

  private blocked(): Set<string> {
    return this.rootProjection().interactions.blockedChildren();
  }

  /**
   * @internal 内容与生命周期行的归属轮：活动回合，否则按 D4 选择/创建展示轮；
   * 不可归因且无兜底时返回 null（调用方丢弃并记 debug）。
   */
  lifecycleTurn(at: number, fallback: AcpBackgroundAttribution | null): string | null {
    if (this.activeTurnId) return this.activeTurnId;
    const attribution = pickBackgroundAttribution(this.backgroundCandidates(), at) ?? fallback;
    if (!attribution) {
      acpExtensionLogger.debug(undefined, "drop ACP content outside a turn", {
        taskId: this.taskId,
      });
      return null;
    }
    if (this.displayTurn?.workId === attribution.workId) return this.displayTurn.turnId;
    this.closeDisplayTurn(at);
    const turnId = randomUUID();
    this.log.push({
      kind: "turnHeader",
      turnId,
      origin: "backgroundResult",
      executionKind: "agent",
      state: "completedSuccess",
      startedAt: at,
      endedAt: at,
      originMeta: {
        backgroundSource: attribution.source,
        workId: attribution.workId,
        title: attribution.title.trim() || attribution.workId,
      },
    });
    this.displayTurn = { turnId, workId: attribution.workId };
    this.anonymousChunkRow = null;
    return turnId;
  }

  private backgroundCandidates(): AcpBackgroundAttribution[] {
    return [
      ...this.works.attributions(),
      ...this.registry.childrenOf(this.taskId).map((entry) => ({
        source: "subagent" as const,
        workId: entry.virtualId,
        title: entry.name,
        startedAt: entry.startedAt,
        ...(entry.status !== "running" && entry.endedAt !== undefined
          ? { endedAt: entry.endedAt }
          : {}),
      })),
    ];
  }

  /** 展示轮在新回合开始或改换归因时收口：未终结的工具行标为 cancelled。 */
  private closeDisplayTurn(at: number): void {
    const display = this.displayTurn;
    if (!display) return;
    for (const row of this.log.rows) {
      if (
        row.turnId === display.turnId &&
        row.kind === "toolCall" &&
        (row.status === "inputStreaming" ||
          row.status === "running" ||
          row.status === "pendingApproval")
      )
        this.log.replace({ ...row, status: "cancelled", endedAt: at });
    }
    this.displayTurn = null;
    this.clearTurnMaps();
  }

  private clearTurnMaps(): void {
    this.rowByMessageId.clear();
    this.reasoningStartedAt.clear();
    this.rowByToolCallId.clear();
    this.toolIdentities.clear();
    this.anonymousChunkRow = null;
  }

  /** @internal */
  findToolRow(toolCallId: string): ToolCallRow | undefined {
    return this.log.findToolRow(toolCallId, this.rowByToolCallId.get(toolCallId));
  }

  private completeReasoning(at: number, interrupted = false): void {
    const rows = this.log.rows;
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      if (
        row?.kind !== "reasoning" ||
        row.turnId !== this.activeTurnId ||
        row.state !== "streaming"
      )
        continue;
      rows[index] = {
        ...row,
        state: interrupted ? "interrupted" : "complete",
        durationMs: Math.max(0, at - (this.reasoningStartedAt.get(row.rowId) ?? at)),
      };
      this.reasoningStartedAt.delete(row.rowId);
      for (const [key, rowId] of this.rowByMessageId) {
        if (rowId === row.rowId) this.rowByMessageId.delete(key);
      }
      if (this.anonymousChunkRow?.rowId === row.rowId) this.anonymousChunkRow = null;
      this.log.advance();
    }
  }
}
