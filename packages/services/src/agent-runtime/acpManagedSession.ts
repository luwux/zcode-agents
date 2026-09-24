import { randomUUID } from "node:crypto";
import type {
  CreateElicitationResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { AcpConnection, type AcpSessionObserver } from "#src/agent-runtime/acpConnection.js";
import { AcpConversationProjection } from "#src/agent-runtime/acpConversationProjection.js";
import { AcpTranscriptStore } from "#src/agent-runtime/acpTranscriptStore.js";
import {
  isFormElicitation,
  planAcpElicitation,
  type AcpElicitationPlan,
} from "#src/agent-runtime/acpElicitation.js";
import { readLodySubagentCancel } from "#src/agent-runtime/acpExtensionSchemas.js";

export interface PendingPermission {
  request: RequestPermissionRequest;
  resolve: (response: RequestPermissionResponse) => void;
  /** 原生子会话的请求；根会话回合结束时不随之收口。 */
  childSessionId?: string;
}

export interface PendingElicitation {
  plan: AcpElicitationPlan;
  resolve: (response: CreateElicitationResponse) => void;
  childSessionId?: string;
}

export interface AcpPendingInteractions {
  permissions: Map<string, PendingPermission>;
  elicitations: Map<string, PendingElicitation>;
}

export function createAcpPendingInteractions(): AcpPendingInteractions {
  return { permissions: new Map(), elicitations: new Map() };
}

export interface ManagedAcpSession {
  connection: AcpConnection;
  meta: ZCodeTaskMeta;
  projection: AcpConversationProjection;
  transcript: AcpTranscriptStore;
  acceptedCommandIds: Set<string>;
  pendingPermissions: Map<string, PendingPermission>;
  pendingElicitations: Map<string, PendingElicitation>;
  closing: boolean;
  crashed: boolean;
  activeCommandId: string | null;
  turnSettled: boolean;
}

export function workspaceKey(target: {
  workspacePath: string;
  workspaceIdentity?: string;
}): string {
  return target.workspaceIdentity?.trim() || target.workspacePath;
}

export function sessionKey(
  target: { workspacePath: string; workspaceIdentity?: string },
  taskId: string,
): string {
  return `${workspaceKey(target)}\0${taskId}`;
}

export function createManagedAcpSession(input: {
  connection: AcpConnection;
  meta: ZCodeTaskMeta;
  projection: AcpConversationProjection;
  transcript: AcpTranscriptStore;
  pending: AcpPendingInteractions;
  acceptedCommandIds: Set<string>;
}): ManagedAcpSession {
  const { pending, ...rest } = input;
  input.projection.setLodySubagentCancel(
    readLodySubagentCancel(input.connection.initializeResponse.agentCapabilities),
  );
  return {
    ...rest,
    pendingPermissions: pending.permissions,
    pendingElicitations: pending.elicitations,
    closing: false,
    crashed: false,
    activeCommandId: null,
    turnSettled: true,
  };
}

/**
 * 投影是待处理交互的展示事实：回合结束（根会话交互）或子智能体终结（其交互）后投影已移除的条目，
 * 在 Host 侧以 cancelled/cancel 收口，避免 Agent 的请求悬挂或迟到的应答被当作有效选择。
 */
export function reconcilePendingInteractions(
  projection: AcpConversationProjection,
  pending: AcpPendingInteractions,
): void {
  for (const [id, entry] of pending.permissions) {
    if (projection.hasInteraction(id)) continue;
    pending.permissions.delete(id);
    entry.resolve({ outcome: { outcome: "cancelled" } });
  }
  for (const [id, entry] of pending.elicitations) {
    if (projection.hasInteraction(id)) continue;
    pending.elicitations.delete(id);
    entry.resolve({ action: "cancel" });
  }
}

export function createAcpSessionObserver(input: {
  taskId: string;
  projection: AcpConversationProjection;
  transcript: AcpTranscriptStore;
  pending: AcpPendingInteractions;
  current: () => ManagedAcpSession | null;
  syncMeta: (meta: ZCodeTaskMeta) => Promise<ZCodeTaskMeta>;
  publish: (managed: ManagedAcpSession) => void;
  onPermission?: (interactionId: string, request: RequestPermissionRequest) => void;
  finishCrashedTurn: (managed: ManagedAcpSession) => Promise<void>;
}): AcpSessionObserver {
  const childOf = (sessionId: string): string | undefined => {
    const managed = input.current();
    return managed && managed.connection.isChildSession(sessionId) ? sessionId : undefined;
  };
  return {
    onUpdate: async (notification) => {
      const managed = input.current();
      // session/load 可回放 Agent 自有历史；工作台只使用已持久记录的转录重建，禁止重复追加。
      if (!managed) return;
      const { update } = notification;
      const childSessionId = childOf(notification.sessionId);
      // 同一时间戳用于落盘与实时投影，回放的回合外归因（30s 窗口）与实时一致。
      const at = Date.now();
      await input.transcript.appendUpdate(update, {
        ...(childSessionId ? { sessionId: childSessionId } : {}),
        at,
      });
      input.projection.applyUpdate(notification, at);
      reconcilePendingInteractions(input.projection, input.pending);
      if (childSessionId) {
        input.publish(managed);
        return;
      }
      if (update.sessionUpdate === "session_info_update" && update.title) {
        managed.meta = { ...managed.meta, title: update.title, updatedAt: Date.now() };
        managed.meta = await input.syncMeta(managed.meta);
        input.projection.setTitle(managed.meta.title);
      }
      if (update.sessionUpdate === "config_option_update") {
        const models = managed.connection.modelOptions();
        const levels = managed.connection.thinkingLevels();
        input.projection.setModelOptions(models);
        input.projection.setThinkingLevels(levels);
        const model = models.find((item) => item.selected)?.id;
        const thoughtLevel = levels.find((item) => item.selected)?.value;
        if (managed.meta.model !== model || managed.meta.thoughtLevel !== thoughtLevel) {
          managed.meta = { ...managed.meta, model, thoughtLevel, updatedAt: Date.now() };
          managed.meta = await input.syncMeta(managed.meta);
        }
      }
      if (
        update.sessionUpdate === "current_mode_update" ||
        update.sessionUpdate === "config_option_update"
      ) {
        const modes = managed.connection.modeState();
        input.projection.setModes(modes);
        if (modes?.currentModeId && managed.meta.acpModeId !== modes.currentModeId) {
          try {
            managed.meta = await input.syncMeta({
              ...managed.meta,
              acpModeId: modes.currentModeId,
              updatedAt: Date.now(),
            });
          } catch {
            // Agent 主动改变模式却无法持久化时，阻止后续输入使用无法恢复的权限状态。
            managed.crashed = true;
            managed.closing = true;
            await managed.connection.close().catch(() => {});
            input.projection.markUnavailable("ACP mode update could not be saved; restart the app");
            input.publish(managed);
            return;
          }
        }
      }
      input.publish(managed);
    },
    requestPermission: (request): Promise<RequestPermissionResponse> => {
      if (!input.onPermission || !input.current())
        return Promise.resolve({ outcome: { outcome: "cancelled" } });
      const childSessionId = childOf(request.sessionId);
      // 子会话的 toolCallId 可能与根会话重叠；交互 id 带子会话前缀，保证幂等键唯一。
      const interactionId = childSessionId
        ? `acp-subagent:${childSessionId}:${request.toolCall.toolCallId}`
        : request.toolCall.toolCallId;
      if (input.pending.permissions.has(interactionId))
        return Promise.resolve({ outcome: { outcome: "cancelled" } });
      return new Promise((resolve) => {
        input.pending.permissions.set(interactionId, {
          request,
          resolve,
          ...(childSessionId ? { childSessionId } : {}),
        });
        input.projection.requestPermission(request, interactionId, childSessionId);
        const managed = input.current();
        if (managed) input.publish(managed);
        input.onPermission?.(interactionId, request);
      });
    },
    requestElicitation: (request): Promise<CreateElicitationResponse> => {
      const managed = input.current();
      if (!managed) return Promise.resolve({ action: "cancel" });
      if (!isFormElicitation(request)) return Promise.resolve({ action: "decline" });
      const sessionId = "sessionId" in request ? request.sessionId : undefined;
      const childSessionId = sessionId ? childOf(sessionId) : undefined;
      const plan = planAcpElicitation(request);
      const interactionId = `acp-elicitation:${randomUUID()}`;
      return new Promise((resolve) => {
        input.pending.elicitations.set(interactionId, {
          plan,
          resolve,
          ...(childSessionId ? { childSessionId } : {}),
        });
        input.projection.requestUserInput(interactionId, plan.payload, childSessionId);
        input.publish(managed);
      });
    },
    onExit: () => {
      const managed = input.current();
      if (!managed || managed.closing) return;
      managed.crashed = true;
      for (const request of input.pending.permissions.values())
        request.resolve({ outcome: { outcome: "cancelled" } });
      for (const request of input.pending.elicitations.values())
        request.resolve({ action: "cancel" });
      for (const interactionId of [
        ...input.pending.permissions.keys(),
        ...input.pending.elicitations.keys(),
      ])
        managed.projection.settleInteraction(interactionId);
      input.pending.permissions.clear();
      input.pending.elicitations.clear();
      // 后台子智能体与异步任务随旧进程结束，不能在回合外永远显示为运行中。
      managed.projection.markProcessExited();
      if (managed.activeCommandId) void input.finishCrashedTurn(managed).catch(() => {});
      else input.publish(managed);
    },
  };
}
