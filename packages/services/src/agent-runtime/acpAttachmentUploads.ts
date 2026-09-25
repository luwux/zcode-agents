// ACP 会话的分片附件上传（粘贴截图等无本地路径的附件）。
//
// 修复原因：附件分片上传原本一律转发给 zcode-cli，由它写入“该 CLI 会话”的附件仓；ACP 会话不在 CLI
// 中，上传在 commit 前就以 fault.attachment.sessionNotFound 失败，粘贴图片无法发给 Claude Code /
// Codex / Pi。这里由 Host 自己接收分片，校验大小与 sha256 后写入 CodeZ 数据目录下该会话的私有目录，
// 返回绝对路径作为 ref；发送时 prepareAcpPromptAttachments 按本地文件生成 image/resource 块。
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type {
  V4AttachmentBeginParams,
  V4AttachmentBeginResult,
  V4AttachmentChunkParams,
  V4AttachmentChunkResult,
  V4AttachmentCommitResult,
} from "@zcode/shared/zcode-protocol-v4";
import { getZCodeDataRootDir } from "#src/paths.js";

const UPLOAD_TTL_MS = 30 * 60_000;

interface Upload {
  sessionId: string;
  params: V4AttachmentBeginParams;
  chunks: Buffer[];
  receivedBytes: number;
  ref: string | null;
  expiresAt: number;
}

type UploadKey = { connectionId: string; sessionId: string; uploadId: string };

function keyOf({ connectionId, sessionId, uploadId }: UploadKey): string {
  return `${connectionId}\0${sessionId}\0${uploadId}`;
}

/** 目录名只保留安全字符，避免会话 ID 或文件名参与路径穿越。 */
function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "_";
}

export function acpAttachmentsRoot(): string {
  return join(getZCodeDataRootDir(), "acp-attachments");
}

export class AcpAttachmentUploads {
  private readonly uploads = new Map<string, Upload>();

  constructor(private readonly now: () => number = Date.now) {}

  private prune(): void {
    const now = this.now();
    for (const [key, upload] of this.uploads) if (upload.expiresAt < now) this.uploads.delete(key);
  }

  begin(params: V4AttachmentBeginParams): V4AttachmentBeginResult {
    this.prune();
    const key = keyOf(params);
    const existing = this.uploads.get(key);
    if (existing) {
      // 同一 uploadId 重试：已提交则直接返回 ref，未提交则从已收到的分片处续传。
      if (existing.ref)
        return {
          uploadId: params.uploadId,
          state: "committed",
          nextChunkIndex: existing.params.totalChunks,
          ref: existing.ref,
        };
      return {
        uploadId: params.uploadId,
        state: "staging",
        nextChunkIndex: existing.chunks.length,
      };
    }
    this.uploads.set(key, {
      sessionId: params.sessionId,
      params,
      chunks: [],
      receivedBytes: 0,
      ref: null,
      expiresAt: this.now() + UPLOAD_TTL_MS,
    });
    return { uploadId: params.uploadId, state: "staging", nextChunkIndex: 0 };
  }

  chunk(params: V4AttachmentChunkParams): V4AttachmentChunkResult {
    const upload = this.uploads.get(keyOf(params));
    if (!upload) throw new Error("fault.attachment.uploadNotFound");
    if (upload.ref) throw new Error("fault.attachment.uploadAlreadyCommitted");
    // 重复发送已收到的分片是幂等的；跳号拒绝。
    if (params.chunkIndex < upload.chunks.length)
      return { uploadId: params.uploadId, nextChunkIndex: upload.chunks.length };
    if (params.chunkIndex !== upload.chunks.length)
      throw new Error("fault.attachment.chunkOutOfOrder");
    if (upload.chunks.length >= upload.params.totalChunks)
      throw new Error("fault.attachment.tooManyChunks");
    const bytes = Buffer.from(params.dataBase64, "base64");
    if (upload.receivedBytes + bytes.length > upload.params.totalBytes)
      throw new Error("fault.attachment.sizeMismatch");
    upload.chunks.push(bytes);
    upload.receivedBytes += bytes.length;
    upload.expiresAt = this.now() + UPLOAD_TTL_MS;
    return { uploadId: params.uploadId, nextChunkIndex: upload.chunks.length };
  }

  async commit(params: UploadKey): Promise<V4AttachmentCommitResult> {
    const upload = this.uploads.get(keyOf(params));
    if (!upload) throw new Error("fault.attachment.uploadNotFound");
    if (upload.ref) return { ref: upload.ref };
    if (upload.chunks.length !== upload.params.totalChunks)
      throw new Error("fault.attachment.incompleteUpload");
    const bytes = Buffer.concat(upload.chunks);
    if (bytes.length !== upload.params.totalBytes) throw new Error("fault.attachment.sizeMismatch");
    const checksum = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (checksum !== upload.params.checksum) throw new Error("fault.attachment.checksumMismatch");
    const dir = join(acpAttachmentsRoot(), safeSegment(upload.sessionId), randomUUID());
    await mkdir(dir, { recursive: true });
    const path = join(dir, safeSegment(basename(upload.params.fileName)));
    const temp = `${path}.${process.pid}.tmp`;
    await writeFile(temp, bytes, { mode: 0o600 });
    await rename(temp, path);
    upload.ref = path;
    upload.chunks = [];
    return { ref: path };
  }

  abort(params: UploadKey): void {
    this.uploads.delete(keyOf(params));
  }

  /** 删除会话时清理其附件目录。 */
  async removeSession(sessionId: string): Promise<void> {
    await rm(join(acpAttachmentsRoot(), safeSegment(sessionId)), { recursive: true, force: true });
  }
}
