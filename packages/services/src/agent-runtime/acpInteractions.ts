import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import type { PendingInteraction, UserInputRequestPayload } from "@zcode/shared/zcode-protocol-v4";
import {
  boundedSummary,
  type AcpSubagentEntry,
  type AcpSubagentRegistry,
} from "#src/agent-runtime/acpSubagentRegistry.js";

interface StoredInteraction {
  interaction: PendingInteraction;
  /** 原生子会话 id：来自连接级登记表（线序事实），与投影是否已应用 spawn 无关。 */
  childSessionId?: string;
  toolCallId?: string;
}

/**
 * 根会话的待处理交互（权限、form 问答）。
 *
 * SDK 对 request 的处理链比 notification 短，子会话的权限请求可能先于其 subagent_spawned 被投影应用；
 * 因此 origin 与锚点在生成 snapshot 时按当前登记表解析，而不是在请求到达时固化。
 */
export class AcpInteractionBook<P> {
  private readonly items = new Map<string, StoredInteraction>();

  constructor(private readonly registry: AcpSubagentRegistry<P>) {}

  addPermission(
    interactionId: string,
    request: RequestPermissionRequest,
    childSessionId: string | undefined,
  ): void {
    this.items.set(interactionId, {
      interaction: {
        interactionId,
        kind: "permission",
        anchorRowId: null,
        createdAt: Date.now(),
        payload: {
          kind: "permission",
          toolCallId: request.toolCall.toolCallId,
          toolName: request.toolCall.title || "ACP tool",
          summary: request.toolCall.title || "ACP tool permission",
          detail: request.toolCall,
          options: request.options.map((option) => ({
            optionId: option.optionId,
            label: option.name,
            kind:
              option.kind === "allow_once"
                ? "allowOnce"
                : option.kind === "allow_always"
                  ? "allowAlways"
                  : option.kind === "reject_once" || option.kind === "reject_always"
                    ? "deny"
                    : "custom",
          })),
        },
      },
      ...(childSessionId ? { childSessionId } : {}),
      toolCallId: request.toolCall.toolCallId,
    });
  }

  addUserInput(
    interactionId: string,
    payload: UserInputRequestPayload,
    childSessionId: string | undefined,
  ): void {
    this.items.set(interactionId, {
      interaction: {
        interactionId,
        kind: "userInput",
        anchorRowId: null,
        createdAt: Date.now(),
        payload,
      },
      ...(childSessionId ? { childSessionId } : {}),
      ...(payload.toolCallId ? { toolCallId: payload.toolCallId } : {}),
    });
  }

  delete(interactionId: string): boolean {
    return this.items.delete(interactionId);
  }

  has(interactionId: string): boolean {
    return this.items.has(interactionId);
  }

  /** 根会话回合结束：只收口根会话自有交互，后台子会话的交互保留。 */
  clearRootOwned(): void {
    for (const [id, item] of this.items) if (!item.childSessionId) this.items.delete(id);
  }

  /** 子会话终结后其交互不再可答。 */
  dropChild(childSessionId: string): void {
    for (const [id, item] of this.items)
      if (item.childSessionId === childSessionId) this.items.delete(id);
  }

  /** 有待处理交互的子会话（虚拟 id），状态面板显示为 blocked。 */
  blockedChildren(): Set<string> {
    const blocked = new Set<string>();
    for (const item of this.items.values()) {
      const entry = item.childSessionId ? this.registry.bySession(item.childSessionId) : undefined;
      if (entry) blocked.add(entry.virtualId);
    }
    return blocked;
  }

  list(rootToolRowId: (toolCallId: string) => number | null): PendingInteraction[] {
    return [...this.items.values()].map((item) => {
      const entry = item.childSessionId ? this.registry.bySession(item.childSessionId) : undefined;
      if (!entry) {
        const anchorRowId =
          !item.childSessionId && item.toolCallId ? rootToolRowId(item.toolCallId) : null;
        return { ...item.interaction, anchorRowId };
      }
      const origin = subagentOrigin(entry);
      const payload = item.interaction.payload;
      return {
        ...item.interaction,
        anchorRowId: this.rootAnchorFor(entry),
        payload:
          payload.kind === "permission" || payload.kind === "userInput"
            ? { ...payload, origin }
            : payload,
      } as PendingInteraction;
    });
  }

  /** 根会话中该分支顶层宿主行（嵌套子会话的宿主行位于子投影，不能锚定根会话）。 */
  private rootAnchorFor(entry: AcpSubagentEntry<P>): number | null {
    let current: AcpSubagentEntry<P> | undefined = entry;
    while (current && current.parentTaskId !== this.registry.rootTaskId)
      current = this.registry.byVirtualId(current.parentTaskId);
    return current?.anchorRowId ?? null;
  }
}

function subagentOrigin<P>(entry: AcpSubagentEntry<P>) {
  return {
    kind: "subagent" as const,
    agentId: entry.key,
    agentType: entry.name,
    childSessionId: entry.virtualId,
    parentSessionId: entry.parentTaskId,
    parentToolCallId: entry.hostToolCallId,
    ...(entry.task ? { description: boundedSummary(entry.task) } : {}),
  };
}
