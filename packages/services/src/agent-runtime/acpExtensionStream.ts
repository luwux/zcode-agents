import type { AnyMessage, SessionNotification } from "@agentclientprotocol/sdk";
import {
  ACP_EXTENSION_UPDATE_KINDS,
  acpExtensionLogger,
  parseAcpExtensionUpdate,
  record,
  type AcpExtensionUpdate,
  type AcpSessionUpdate,
} from "#src/agent-runtime/acpExtensionSchemas.js";

/** 载体键：扩展 update 被包进 `session_info_update._meta` 穿过 SDK 1.4 的 schema 校验。 */
export const ACP_EXTENSION_CARRIER_KEY = "codez.dev/extensionUpdate";

type Stream = { readable: ReadableStream<AnyMessage>; writable: WritableStream<AnyMessage> };

/**
 * 连接级子会话登记表：只保存 Agent 已宣告的子 sessionId 及其是否已终结。
 *
 * 登记发生在入站流变换中——这是唯一严格按 Agent 写出顺序处理消息的位置。SDK 对每条消息并发执行处理链，
 * request（权限/表单）的处理链比 notification 短，若在回调里登记，子会话紧随 spawn 的权限请求可能先到而被拒。
 */
export class AcpChildSessionRegistry {
  private readonly live = new Map<string, boolean>();

  constructor(private readonly rootSessionId: () => string | null) {}

  /** 根会话或已宣告（含已终结）的子会话。 */
  accepts(sessionId: string): boolean {
    const root = this.rootSessionId();
    return (root !== null && sessionId === root) || this.live.has(sessionId);
  }

  /** 交互请求只接受根会话与仍存活的子会话。 */
  acceptsInteraction(sessionId: string): boolean {
    const root = this.rootSessionId();
    return (root !== null && sessionId === root) || this.live.get(sessionId) === true;
  }

  isChild(sessionId: string): boolean {
    return this.live.has(sessionId);
  }

  observe(sessionId: string, update: AcpExtensionUpdate): void {
    if (update.sessionUpdate === "subagent_spawned") {
      // 只有根会话或已登记子会话可以宣告下一级；未知父会话的 spawn 不可信。
      if (this.accepts(sessionId) && !this.live.has(update.subagentSessionId))
        this.live.set(update.subagentSessionId, true);
    } else if (update.sessionUpdate === "subagent_state_update") {
      if (this.live.has(update.subagentSessionId)) this.live.set(update.subagentSessionId, false);
    }
  }
}

/**
 * 把扩展 update 改写为 SDK 1.4 可接受的载体，并在线序上喂给子会话登记表。
 * 改写后的消息与其他 `session/update` 走等长处理链，保持相对顺序；Agent 自带的同名载体键被剥离，防伪造。
 */
export function carryAcpExtensionUpdates(
  stream: Stream,
  registry: AcpChildSessionRegistry,
): Stream {
  const transform = new TransformStream<AnyMessage, AnyMessage>({
    transform(message, controller) {
      const rewritten = rewriteIncoming(message, registry);
      if (rewritten) controller.enqueue(rewritten);
    },
  });
  void stream.readable.pipeTo(transform.writable).catch(() => {});
  return { readable: transform.readable, writable: stream.writable };
}

function rewriteIncoming(
  message: AnyMessage,
  registry: AcpChildSessionRegistry,
): AnyMessage | null {
  if (!("method" in message) || message.method !== "session/update" || "id" in message)
    return message;
  const params = record(message.params);
  const update = record(params?.update);
  const sessionId = params?.sessionId;
  if (!params || !update || typeof sessionId !== "string") return message;
  const kind = update.sessionUpdate;
  if (typeof kind === "string" && ACP_EXTENSION_UPDATE_KINDS.has(kind)) {
    const parsed = parseAcpExtensionUpdate(update);
    if (!parsed) return null;
    registry.observe(sessionId, parsed);
    return {
      ...message,
      params: {
        ...params,
        update: {
          sessionUpdate: "session_info_update",
          _meta: { [ACP_EXTENSION_CARRIER_KEY]: parsed },
        },
      },
    };
  }
  const meta = record(update._meta);
  if (kind === "session_info_update" && meta && ACP_EXTENSION_CARRIER_KEY in meta) {
    const { [ACP_EXTENSION_CARRIER_KEY]: _forged, ...rest } = meta;
    acpExtensionLogger.debug(undefined, "strip forged ACP extension carrier");
    return { ...message, params: { ...params, update: { ...update, _meta: rest } } };
  }
  return message;
}

/** 解开载体：普通 update 原样返回；载体内容再次校验（防御变换之外的构造）。 */
export function unwrapAcpExtensionUpdate(
  update: SessionNotification["update"],
): AcpSessionUpdate | null {
  if (update.sessionUpdate !== "session_info_update") return update;
  const meta = record(update._meta);
  if (!meta || !(ACP_EXTENSION_CARRIER_KEY in meta)) return update;
  return parseAcpExtensionUpdate(meta[ACP_EXTENSION_CARRIER_KEY]);
}
