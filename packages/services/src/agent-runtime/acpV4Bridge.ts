import { randomUUID } from "node:crypto";
import type { AgentRuntimeId } from "@zcode/shared";
import type { ZCodeTaskMeta } from "@zcode/shared";
import {
  BACKGROUND_WORK_CANCEL_REJECTED_FAULT_PREFIX,
  commandPayloadSchemas,
  conversationTopic,
  conversationTopicFrameSchema,
  encodeTopicWireFrames,
  utf8JsonByteLength,
  type CommandAck,
  type CommandKey,
  type CommandEnvelope,
  type ConversationSnapshot,
  type ConversationTopicWireCandidate,
  type TopicFrameDeliveryKind,
} from "@zcode/shared/zcode-protocol-v4";
import type { TaskIndexRepo } from "#src/session/taskIndexRepo.js";
import {
  AcpRuntimeCoordinator,
  type AcpWorkspaceTarget,
} from "#src/agent-runtime/acpRuntimeCoordinator.js";
import { resolveAcpRuntimeSpec } from "#src/agent-runtime/acpRuntimeCatalog.js";
import { parseAcpSubagentSessionId } from "#src/agent-runtime/acpSubagentRegistry.js";

interface AcpV4Subscription {
  target: AcpWorkspaceTarget & { taskId: string };
  subscriptionId: string;
  ordinal: number;
  /** 虚拟子会话订阅：仅在子 snapshot revision 变化时推送。 */
  lastRevision?: number;
}

function targetKey(target: AcpWorkspaceTarget & { taskId: string }): string {
  return `${target.workspaceIdentity?.trim() || target.workspacePath}\0${target.taskId}`;
}

/** 虚拟子会话订阅归属的根会话键；根会话订阅返回自身键。 */
function rootTargetKey(target: AcpWorkspaceTarget & { taskId: string }): string {
  const virtual = parseAcpSubagentSessionId(target.taskId);
  return targetKey(virtual ? { ...target, taskId: virtual.rootTaskId } : target);
}

/** ACP 到既有 ZCode V4 conversation wire 的唯一转换边界。 */
export class AcpV4Bridge {
  private readonly subscriptions = new Map<string, AcpV4Subscription>();
  private readonly lastTaskState = new Map<string, string>();
  readonly coordinator: AcpRuntimeCoordinator;

  constructor(
    private readonly taskIndex: TaskIndexRepo,
    private readonly emit: (
      target: AcpWorkspaceTarget,
      frame: ConversationTopicWireCandidate,
    ) => void,
    isMemoryEnabled: () => boolean | Promise<boolean>,
    private readonly onTaskChanged?: (meta: ZCodeTaskMeta) => void,
  ) {
    this.coordinator = new AcpRuntimeCoordinator(
      taskIndex,
      {
        onSnapshot: (target, snapshot) => {
          this.publish(target, snapshot, "online");
          const key = targetKey(target);
          const state = `${snapshot.control.phase}\0${snapshot.meta.title}`;
          if (this.lastTaskState.get(key) !== state) {
            this.lastTaskState.set(key, state);
            // 恢复旧会话时磁盘状态可能残留 running；只有当前投影实际运行才广播实时状态。
            if (snapshot.control.phase === "running" || target.status !== "running") {
              this.onTaskChanged?.(target);
            }
          }
        },
        // pending interaction 已投影到 V4；具体选项由 resolveInteraction 回传。
        onPermission: () => {},
      },
      undefined,
      isMemoryEnabled,
    );
  }

  async isAcpTask(target: AcpWorkspaceTarget & { taskId: string }): Promise<boolean> {
    // 子智能体虚拟 id 不在任务索引中，按其根会话判定归属。
    const taskId = parseAcpSubagentSessionId(target.taskId)?.rootTaskId ?? target.taskId;
    const meta = await this.taskIndex.getTaskMeta({ ...target, taskId });
    return !!meta && !!meta.runtimeId && meta.runtimeId !== "zcode-cli";
  }

  /** `listSessionSubagents` 对 ACP 根会话（及虚拟子会话）由投影事实应答。 */
  async listSubagents(
    target: AcpWorkspaceTarget & { taskId: string; endedCursor?: string; endedLimit?: number },
  ) {
    await this.coordinator.load(target);
    return this.coordinator.listSubagents(target);
  }

  async subscribe(target: AcpWorkspaceTarget & { taskId: string }): Promise<{
    ack: {
      subscriptionId: string;
      mode: "snapshot";
      logEpoch: string;
    };
  }> {
    const snapshot = await this.coordinator.load(target);
    const subscriptionId = randomUUID();
    const subscription: AcpV4Subscription = { target, subscriptionId, ordinal: 0 };
    this.subscriptions.set(subscriptionId, subscription);
    this.publishTo(subscription, snapshot, "initial");
    return { ack: { subscriptionId, mode: "snapshot", logEpoch: snapshot.logEpoch } };
  }

  unsubscribe(subscriptionId: string): boolean {
    return this.subscriptions.delete(subscriptionId);
  }

  hasSubscription(subscriptionId: string): boolean {
    return this.subscriptions.has(subscriptionId);
  }

  resync(
    subscriptionId: string,
  ): { ack: { subscriptionId: string; mode: "snapshot"; logEpoch: string } } | null {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) return null;
    const snapshot = this.coordinator.snapshot(subscription.target);
    if (!snapshot) return null;
    this.publishTo(subscription, snapshot, "recovery");
    return { ack: { subscriptionId, mode: "snapshot", logEpoch: snapshot.logEpoch } };
  }

  async command(target: AcpWorkspaceTarget, envelope: CommandEnvelope): Promise<CommandAck> {
    const revision = envelope.sessionId
      ? (this.coordinator.snapshot({ ...target, taskId: envelope.sessionId })?.revision ?? 0)
      : 0;
    const reject = (reasonCode: string): CommandAck => ({
      commandId: envelope.commandId,
      status: "rejected",
      reasonCode,
      revisionAtDecision: revision,
    });
    if (envelope.type === "createSession") {
      const payload = commandPayloadSchemas.createSession.parse(envelope.payload);
      if (!payload.runtimeId || payload.runtimeId === "zcode-cli")
        return reject("acpRuntimeNotSelected");
      if (payload.mcpServers?.length) return reject("acpCapabilityUnsupported");
      const meta = await this.coordinator.create({
        ...target,
        commandId: envelope.commandId,
        runtimeId: payload.runtimeId as AgentRuntimeId,
        modelId: payload.acpConfig?.modelId,
        thoughtLevel: payload.acpConfig?.thoughtLevel,
        modeId: payload.acpConfig?.modeId,
        projectWorkspacePath: payload.projectWorkspacePath,
      });
      if (payload.firstInput) {
        await this.coordinator.sendPrompt({
          ...target,
          taskId: meta.taskId,
          commandId: envelope.commandId,
          text: payload.firstInput.text,
          attachments: payload.firstInput.attachments,
        });
      }
      return {
        commandId: envelope.commandId,
        status: "accepted",
        revisionAtDecision: 0,
        result: {
          type: "createSession",
          sessionId: meta.taskId,
          ...(payload.firstInput
            ? { input: { delivery: "startNow", inputId: envelope.commandId } }
            : {}),
        },
      };
    }
    if (!envelope.sessionId) return reject("acpSessionRequired");
    // 子智能体会话由 Agent 驱动，工作台只读。
    if (parseAcpSubagentSessionId(envelope.sessionId)) return reject("acpSubagentReadOnly");
    const task = { ...target, taskId: envelope.sessionId };
    if (!this.coordinator.snapshot(task)) await this.coordinator.load(task);
    if (this.coordinator.isUnavailable(task)) return reject("acpRuntimeUnavailable");
    switch (envelope.type) {
      case "createSelectionSideSession": {
        const payload = commandPayloadSchemas.createSelectionSideSession.parse(envelope.payload);
        const parent = await this.taskIndex.getTaskMeta(task);
        if (!parent?.runtimeId || parent.runtimeId === "zcode-cli")
          return reject("acpRuntimeUnavailable");
        const currentSpec = await resolveAcpRuntimeSpec(parent.runtimeId, { restoreLegacy: true });
        if (
          !currentSpec ||
          (parent.agentServerFingerprint &&
            currentSpec.fingerprint !== parent.agentServerFingerprint)
        )
          return reject("acpRuntimeUnavailable");
        const selection = payload.firstInput?.modelSelection;
        if (selection && selection.providerId !== parent.runtimeId)
          return reject("acpRuntimeNotSelected");
        const child = await this.coordinator.create({
          ...target,
          commandId: envelope.commandId,
          runtimeId: parent.runtimeId,
          parentTaskId: parent.taskId,
          modelId: selection?.modelId ?? parent.model,
          thoughtLevel: selection?.options?.reasoningLevel ?? parent.thoughtLevel,
        });
        if (payload.firstInput) {
          // 创建命令本身是首条输入的幂等键；重试不会向 Agent 再送一遍文本。
          await this.coordinator.sendPrompt({
            ...target,
            taskId: child.taskId,
            commandId: envelope.commandId,
            text: payload.firstInput.text,
          });
        }
        return {
          commandId: envelope.commandId,
          status: "accepted",
          revisionAtDecision: revision,
          result: {
            type: "createSelectionSideSession",
            sessionId: child.taskId,
            ...(payload.firstInput
              ? { input: { delivery: "startNow", inputId: envelope.commandId } }
              : {}),
          },
        };
      }
      case "sendText": {
        const payload = commandPayloadSchemas.sendText.parse(envelope.payload);
        if (payload.context_refs?.length || payload.modelExecution)
          return reject("acpCapabilityUnsupported");
        // 运行中输入经 steering 注入当前 turn，回执标记为 guide。
        const delivery =
          this.coordinator.snapshot(task)?.control.phase === "running" ? "guide" : "startNow";
        const outcome = await this.coordinator.sendPrompt({
          ...task,
          commandId: envelope.commandId,
          text: payload.text,
          attachments: payload.attachments,
        });
        return {
          commandId: envelope.commandId,
          status: outcome === "duplicate" ? "duplicate" : "accepted",
          revisionAtDecision: this.coordinator.snapshot(task)?.revision ?? revision,
          result: { type: "inputAccepted", delivery, inputId: envelope.commandId },
        };
      }
      case "stop":
        await this.coordinator.cancel(task);
        return { commandId: envelope.commandId, status: "accepted", revisionAtDecision: revision };
      case "resolveInteraction": {
        const payload = commandPayloadSchemas.resolveInteraction.parse(envelope.payload);
        const settled = this.coordinator.respondInteraction({
          ...task,
          interactionId: payload.interactionId,
          answer: payload.answer,
        });
        if (!settled) return reject("acpInteractionNotPending");
        return {
          commandId: envelope.commandId,
          status: "accepted",
          revisionAtDecision: revision,
          result: {
            type: "resolveInteraction",
            resolvedBy: {
              clientId: envelope.clientId,
              ...(payload.answer.optionId ? { optionId: payload.answer.optionId } : {}),
            },
          },
        };
      }
      case "cancelBackgroundWork": {
        const payload = commandPayloadSchemas.cancelBackgroundWork.parse(envelope.payload);
        const outcome = await this.coordinator.cancelBackgroundWork({
          ...task,
          workId: payload.workId,
        });
        if (!outcome.accepted)
          return reject(`${BACKGROUND_WORK_CANCEL_REJECTED_FAULT_PREFIX}${outcome.reason}`);
        return { commandId: envelope.commandId, status: "accepted", revisionAtDecision: revision };
      }
      case "switchModelConfig": {
        const payload = commandPayloadSchemas.switchModelConfig.parse(envelope.payload);
        if (payload.provider !== "acp") return reject("acpProviderRequired");
        const current = this.coordinator.snapshot(task);
        // 运行中也接纳：协调器即时转发，Agent 拒绝时在 turn 结束后应用（与 ZCode guide 一致）。
        if (!payload.model && !payload.thought && !payload.acpModeId)
          return reject("acpModelOrThoughtRequired");
        if (payload.model && payload.model !== current?.config.model)
          await this.coordinator.setModel({ ...task, value: payload.model });
        if (payload.thought && payload.thought !== this.coordinator.snapshot(task)?.config.thought)
          await this.coordinator.setThinkingLevel({ ...task, value: payload.thought });
        if (
          payload.acpModeId &&
          payload.acpModeId !== this.coordinator.snapshot(task)?.config.acpModeId
        )
          await this.coordinator.setMode({ ...task, value: payload.acpModeId });
        return { commandId: envelope.commandId, status: "accepted", revisionAtDecision: revision };
      }
      default:
        return reject("acpCapabilityUnsupported");
    }
  }

  async queryCommand(
    target: AcpWorkspaceTarget,
    key: CommandKey,
  ): Promise<CommandAck | "unknown" | null> {
    if (key.sessionId === null) {
      const meta = await this.taskIndex.getTaskMeta({ ...target, taskId: key.commandId });
      if (!meta || !meta.runtimeId || meta.runtimeId === "zcode-cli") return null;
      return {
        commandId: key.commandId,
        status: "accepted",
        revisionAtDecision: 0,
        result: { type: "createSession", sessionId: meta.taskId },
      };
    }
    if (!(await this.isAcpTask({ ...target, taskId: key.sessionId }))) return null;
    const child = await this.taskIndex.getTaskMeta({ ...target, taskId: key.commandId });
    if (child?.forkedFromTaskId === key.sessionId) {
      return {
        commandId: key.commandId,
        status: "accepted",
        revisionAtDecision: 0,
        result: { type: "createSelectionSideSession", sessionId: child.taskId },
      };
    }
    if (
      !(await this.coordinator.hasAcceptedCommand({
        ...target,
        taskId: key.sessionId,
        commandId: key.commandId,
      }))
    )
      return "unknown";
    return {
      commandId: key.commandId,
      status: "accepted",
      revisionAtDecision: 0,
      result: { type: "inputAccepted", delivery: "startNow", inputId: key.commandId },
    };
  }

  async dispose(): Promise<void> {
    this.subscriptions.clear();
    await this.coordinator.closeAll();
  }

  private publish(
    target: AcpWorkspaceTarget & { taskId: string },
    snapshot: ConversationSnapshot,
    delivery: TopicFrameDeliveryKind,
  ): void {
    const key = targetKey(target);
    for (const subscription of this.subscriptions.values()) {
      if (targetKey(subscription.target) === key) {
        this.publishTo(subscription, snapshot, delivery);
        continue;
      }
      // 根会话变化时，同一根下的虚拟子会话订阅按子 snapshot revision 去重推送。
      if (rootTargetKey(subscription.target) !== key) continue;
      const child = this.coordinator.snapshot(subscription.target);
      if (!child || child.revision === subscription.lastRevision) continue;
      this.publishTo(subscription, child, delivery);
    }
  }

  private publishTo(
    subscription: AcpV4Subscription,
    snapshot: ConversationSnapshot,
    deliveryKind: TopicFrameDeliveryKind,
  ): void {
    subscription.lastRevision = snapshot.revision;
    const topic = conversationTopic(subscription.target.taskId);
    const frame = conversationTopicFrameSchema.parse({
      topic,
      subscriptionId: subscription.subscriptionId,
      fromSeq: 0,
      toSeq: snapshot.seq,
      sentAt: Date.now(),
      payload: { kind: "snapshot", snapshot },
    });
    const frames = encodeTopicWireFrames(frame, {
      deliveryKind,
      topic,
      subscriptionId: subscription.subscriptionId,
      logicalFrameId: randomUUID(),
      logicalFrameOrdinal: ++subscription.ordinal,
      measurePhysicalFrameBytes: utf8JsonByteLength,
    });
    for (const item of frames) this.emit(subscription.target, item);
  }
}
