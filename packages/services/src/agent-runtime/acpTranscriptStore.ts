import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, realpath, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { ContentBlock, PromptResponse } from "@agentclientprotocol/sdk";
import type { AcpSessionUpdate } from "#src/agent-runtime/acpExtensionSchemas.js";
import { getZCodeDataRootDir } from "#src/paths.js";

const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
const TRANSCRIPT_VERSION = 1;

export type AcpTranscriptEntry =
  | { v: 1; kind: "prompt"; at: number; commandId: string; content: ContentBlock[] }
  // sessionId 仅在更新来自已宣告的原生子会话时写入；缺省（含旧转录）即根会话。
  | { v: 1; kind: "update"; at: number; update: AcpSessionUpdate; sessionId?: string }
  | { v: 1; kind: "turnEnd"; at: number; result: PromptResponse | { error: string } };

function pathDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isInside(root: string, candidate: string): boolean {
  const offset = relative(root, candidate);
  return offset === "" || (offset !== ".." && !offset.startsWith(`..${sep}`));
}

/** 工作台记录 ACP wire 事件；会话历史不依赖 Agent 是否支持 session/load 回放。 */
export class AcpTranscriptStore {
  private pending: Promise<void> = Promise.resolve();
  private failure: Error | null = null;

  constructor(
    readonly workspaceKey: string,
    readonly taskId: string,
    private readonly dataRoot = getZCodeDataRootDir(),
  ) {
    if (!workspaceKey.trim() || !taskId.trim())
      throw new Error("ACP transcript identity is missing");
  }

  async initialize(): Promise<void> {
    const path = await this.path();
    const header = {
      v: TRANSCRIPT_VERSION,
      kind: "header",
      workspaceKey: this.workspaceKey,
      taskId: this.taskId,
    };
    try {
      await stat(path);
      const existing = await this.read();
      if (!existing) throw new Error("ACP transcript header is missing");
    } catch (error) {
      if (!isMissing(error)) throw error;
      await this.writeLine(JSON.stringify(header));
    }
  }

  appendPrompt(commandId: string, content: ContentBlock[]): Promise<void> {
    return this.enqueue({ v: 1, kind: "prompt", at: Date.now(), commandId, content });
  }

  appendUpdate(
    update: AcpSessionUpdate,
    options: { sessionId?: string; at?: number } = {},
  ): Promise<void> {
    return this.enqueue({
      v: 1,
      kind: "update",
      at: options.at ?? Date.now(),
      update,
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    });
  }

  appendTurnEnd(result: PromptResponse | { error: string }): Promise<void> {
    return this.enqueue({ v: 1, kind: "turnEnd", at: Date.now(), result });
  }

  async flush(): Promise<void> {
    await this.pending;
    if (this.failure) throw this.failure;
  }

  async read(): Promise<AcpTranscriptEntry[] | null> {
    const path = await this.path();
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    let content: string;
    try {
      if ((await handle.stat()).size > MAX_TRANSCRIPT_BYTES)
        throw new Error("ACP transcript exceeds the read limit");
      content = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
    const lines = content.split("\n");
    const headerLine = lines.shift();
    if (!headerLine) throw new Error("ACP transcript is empty");
    const header: unknown = JSON.parse(headerLine);
    if (
      !header ||
      typeof header !== "object" ||
      (header as Record<string, unknown>).v !== TRANSCRIPT_VERSION ||
      (header as Record<string, unknown>).kind !== "header" ||
      (header as Record<string, unknown>).workspaceKey !== this.workspaceKey ||
      (header as Record<string, unknown>).taskId !== this.taskId
    )
      throw new Error("ACP transcript identity does not match the task");
    const entries: AcpTranscriptEntry[] = [];
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (!line) continue;
      try {
        const entry: unknown = JSON.parse(line);
        if (
          !entry ||
          typeof entry !== "object" ||
          (entry as Record<string, unknown>).v !== TRANSCRIPT_VERSION ||
          !["prompt", "update", "turnEnd"].includes(String((entry as Record<string, unknown>).kind))
        )
          throw new Error("unsupported ACP transcript entry");
        entries.push(entry as AcpTranscriptEntry);
      } catch (error) {
        // 仅容忍崩溃时最后一条未写完的记录；中间损坏不能假装历史完整。
        if (index === lines.length - 1 && !line.endsWith("}")) break;
        throw error;
      }
    }
    return entries;
  }

  private enqueue(entry: AcpTranscriptEntry): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    const next = this.pending.then(() => this.writeLine(JSON.stringify(entry)));
    this.pending = next.catch((error: unknown) => {
      this.failure = error instanceof Error ? error : new Error(String(error));
    });
    return next;
  }

  private async path(): Promise<string> {
    const root = join(this.dataRoot, "acp", "transcripts");
    const directory = join(root, pathDigest(this.workspaceKey));
    await mkdir(directory, { recursive: true });
    const canonicalRoot = await realpath(root);
    const canonicalDirectory = await realpath(directory);
    if (!isInside(canonicalRoot, canonicalDirectory))
      throw new Error("ACP transcript directory escapes the data root");
    return join(canonicalDirectory, `${pathDigest(this.taskId)}.jsonl`);
  }

  private async writeLine(value: string): Promise<void> {
    const path = await this.path();
    const flags =
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0);
    const handle = await open(path, flags, 0o600);
    try {
      if ((await handle.stat()).size + Buffer.byteLength(value, "utf8") + 1 > MAX_TRANSCRIPT_BYTES)
        throw new Error("ACP transcript exceeds the write limit");
      await handle.writeFile(`${value}\n`);
    } finally {
      await handle.close();
    }
  }
}

function isMissing(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
