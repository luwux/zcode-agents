import type {
  RunningSubagentSummary,
  SubagentProjectionState,
} from "@zcode/shared/zcode-protocol-v4";

/** 子会话虚拟 id：`<rootTaskId>::acp-subagent::<encodeURIComponent(key)>`，只读订阅 conversation/<id>。 */
const SUBAGENT_MARKER = "::acp-subagent::";
const MAX_SUMMARY = 2_000;

export function acpSubagentSessionId(rootTaskId: string, key: string): string {
  return `${rootTaskId}${SUBAGENT_MARKER}${encodeURIComponent(key)}`;
}

export function parseAcpSubagentSessionId(id: string): { rootTaskId: string; key: string } | null {
  const index = id.indexOf(SUBAGENT_MARKER);
  if (index <= 0) return null;
  try {
    const key = decodeURIComponent(id.slice(index + SUBAGENT_MARKER.length));
    return key ? { rootTaskId: id.slice(0, index), key } : null;
  } catch {
    return null;
  }
}

export type AcpSubagentStatus = "running" | "success" | "failed" | "cancelled";

/**
 * 登记表条目。`key` 为原生子 sessionId（Claude/Codex）或 `lody-task:<taskId>`（Pi）；
 * `parentTaskId` 是持有宿主行的投影（根或上一级虚拟子会话）。
 */
export interface AcpSubagentEntry<P> {
  key: string;
  kind: "native" | "lodyTask";
  lodyTaskId?: string;
  virtualId: string;
  projection: P;
  parent: P;
  parentTaskId: string;
  hostToolCallId: string;
  subagentRowId: number;
  /** 合成的宿主 Agent 工具行（仅原生子会话）。 */
  hostRowId?: number;
  /** 父投影中用于锚定权限/问答的行。 */
  anchorRowId: number;
  /** 标题（原生为 Agent 名称，Pi 为任务说明）与类型（原生同名称，Pi 为 modelId）。 */
  name: string;
  type: string;
  task: string;
  status: AcpSubagentStatus;
  startedAt: number;
  endedAt?: number;
  summary?: string;
}

/** 根投影拥有的唯一子会话登记表；子投影共享同一实例以处理嵌套 spawn。 */
export class AcpSubagentRegistry<P> {
  private readonly entries = new Map<string, AcpSubagentEntry<P>>();
  private readonly byVirtual = new Map<string, AcpSubagentEntry<P>>();
  revision = 0;
  /** 根投影注册：子会话终结时移除其待处理交互。 */
  onSettle?: (entry: AcpSubagentEntry<P>) => void;

  constructor(readonly rootTaskId: string) {}

  add(entry: AcpSubagentEntry<P>): void {
    this.entries.set(entry.key, entry);
    this.byVirtual.set(entry.virtualId, entry);
    this.revision++;
  }

  get(key: string): AcpSubagentEntry<P> | undefined {
    return this.entries.get(key);
  }

  /** 只有原生子会话会以自己的 sessionId 发送更新。 */
  bySession(sessionId: string): AcpSubagentEntry<P> | undefined {
    const entry = this.entries.get(sessionId);
    return entry?.kind === "native" ? entry : undefined;
  }

  byVirtualId(virtualId: string): AcpSubagentEntry<P> | undefined {
    return this.byVirtual.get(virtualId);
  }

  all(): AcpSubagentEntry<P>[] {
    return [...this.entries.values()];
  }

  childrenOf(parentTaskId: string): AcpSubagentEntry<P>[] {
    return this.all().filter((entry) => entry.parentTaskId === parentTaskId);
  }

  /** 终态单调：已结束的条目不会回到 running。 */
  settle(entry: AcpSubagentEntry<P>, status: Exclude<AcpSubagentStatus, "running">, at: number) {
    if (entry.status !== "running") return false;
    entry.status = status;
    entry.endedAt = at;
    this.revision++;
    return true;
  }
}

export function boundedSummary(value: string): string {
  return value.length > MAX_SUMMARY ? `${value.slice(0, MAX_SUMMARY - 1)}…` : value;
}

function runningSummary<P>(
  entry: AcpSubagentEntry<P>,
  blocked: ReadonlySet<string>,
): RunningSubagentSummary {
  return {
    childSessionId: entry.virtualId,
    agentId: entry.key,
    toolCallId: entry.hostToolCallId,
    subagentType: entry.type,
    title: entry.name,
    ...(entry.task ? { summary: boundedSummary(entry.task) } : {}),
    status: blocked.has(entry.virtualId) ? "blocked" : "running",
    startedAt: entry.startedAt,
  };
}

/** snapshot.subagents：每个投影只列自己的直接子会话。 */
export function buildSubagentState<P>(
  registry: AcpSubagentRegistry<P>,
  parentTaskId: string,
  blocked: ReadonlySet<string>,
): SubagentProjectionState {
  const children = registry.childrenOf(parentTaskId);
  return {
    revision: registry.revision,
    childSessionIds: children.map((entry) => entry.virtualId),
    running: children
      .filter((entry) => entry.status === "running")
      .map((entry) => runningSummary(entry, blocked)),
    endedTotal: children.filter((entry) => entry.status !== "running").length,
  };
}

/** `listSessionSubagents` 应答：ended 按结束时间倒序，游标是数字偏移。 */
export function listSubagents<P>(
  registry: AcpSubagentRegistry<P>,
  parentTaskId: string,
  blocked: ReadonlySet<string>,
  endedCursor: string | undefined,
  endedLimit: number,
) {
  const children = registry.childrenOf(parentTaskId);
  const ended = children
    .filter((entry) => entry.status !== "running")
    .sort((left, right) => (right.endedAt ?? 0) - (left.endedAt ?? 0));
  const offset = Math.max(0, Number.parseInt(endedCursor ?? "0", 10) || 0);
  const limit = Math.max(1, endedLimit);
  const page = ended.slice(offset, offset + limit);
  return {
    revision: registry.revision,
    childSessionIds: children.map((entry) => entry.virtualId),
    running: children
      .filter((entry) => entry.status === "running")
      .map((entry) => runningSummary(entry, blocked)),
    ended: {
      total: ended.length,
      items: page.map((entry) => ({
        childSessionId: entry.virtualId,
        agentId: entry.key,
        toolCallId: entry.hostToolCallId,
        subagentType: entry.type,
        title: entry.name,
        ...(entry.summary || entry.task
          ? { summary: boundedSummary(entry.summary || entry.task) }
          : {}),
        startedAt: entry.startedAt,
        ...(entry.endedAt !== undefined ? { endedAt: entry.endedAt } : {}),
        status: entry.status as Exclude<AcpSubagentStatus, "running">,
      })),
      ...(offset + limit < ended.length ? { nextCursor: String(offset + limit) } : {}),
    },
  };
}
