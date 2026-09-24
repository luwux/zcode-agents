import type { ConversationRow, ToolCallRow } from "@zcode/shared/zcode-protocol-v4";

type RowBaseKey =
  | "rowId"
  | "entityId"
  | "productTurnId"
  | "visibility"
  | "createdAt"
  | "createdAtSeq";
export type AcpRowDraft = ConversationRow extends infer R
  ? R extends ConversationRow
    ? Omit<R, RowBaseKey>
    : never
  : never;

/** 一条 ACP 投影的行日志与水位：行只追加不删除，rowId 恒等于数组下标。 */
export class AcpRowLog {
  readonly rows: ConversationRow[] = [];
  seq = 0;
  revision = 0;

  constructor(private readonly taskId: string) {}

  push(row: AcpRowDraft): ConversationRow {
    const rowId = this.rows.length;
    this.advance();
    const value = {
      ...row,
      rowId,
      entityId: `${this.taskId}:${rowId}`,
      productTurnId: row.turnId,
      visibility: "visible" as const,
      createdAt: Date.now(),
      createdAtSeq: this.seq,
    } as ConversationRow;
    this.rows.push(value);
    return value;
  }

  at(rowId: number | undefined): ConversationRow | undefined {
    return rowId === undefined ? undefined : this.rows[rowId];
  }

  replace(row: ConversationRow): void {
    if (this.rows[row.rowId]?.rowId !== row.rowId) return;
    this.rows[row.rowId] = row;
    this.advance();
  }

  /** 按 toolCallId 从尾部查找工具行（跨回合；回合内索引可能已清空）。 */
  findToolRow(toolCallId: string, indexed?: number): ToolCallRow | undefined {
    const direct = this.at(indexed);
    if (direct?.kind === "toolCall") return direct;
    for (let index = this.rows.length - 1; index >= 0; index--) {
      const row = this.rows[index];
      if (row?.kind === "toolCall" && row.toolCallId === toolCallId) return row;
    }
    return undefined;
  }

  lastAssistantText(): string {
    for (let index = this.rows.length - 1; index >= 0; index--) {
      const row = this.rows[index];
      if (row?.kind === "assistantText" && row.text.trim()) return row.text.trim();
    }
    return "";
  }

  advance(): void {
    this.seq++;
    this.revision++;
  }
}
