import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import test from "node:test";
import { AcpAttachmentUploads } from "../src/agent-runtime/acpAttachmentUploads.js";
import { prepareAcpPromptAttachments } from "../src/agent-runtime/acpPromptAttachments.js";
import { setDataBaseDir } from "../src/paths.js";

// 1x1 PNG
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function beginParams(bytes: Buffer, chunks: number) {
  return {
    connectionId: "c1",
    uploadId: "u1",
    sessionId: "task-1",
    fileName: "Screenshot 2026.png",
    mime: "image/png",
    totalBytes: bytes.length,
    totalChunks: chunks,
    checksum: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  };
}

test("a pasted image uploads in chunks to a private local file and becomes an ACP image block", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codez-acp-upload-"));
  setDataBaseDir(dir);
  try {
    const uploads = new AcpAttachmentUploads();
    const params = beginParams(PNG, 2);
    assert.deepEqual(uploads.begin(params), {
      uploadId: "u1",
      state: "staging",
      nextChunkIndex: 0,
    });
    const half = Math.ceil(PNG.length / 2);
    const key = { connectionId: "c1", uploadId: "u1", sessionId: "task-1" };
    uploads.chunk({ ...key, chunkIndex: 0, dataBase64: PNG.subarray(0, half).toString("base64") });
    // 重复分片幂等
    uploads.chunk({ ...key, chunkIndex: 0, dataBase64: PNG.subarray(0, half).toString("base64") });
    uploads.chunk({ ...key, chunkIndex: 1, dataBase64: PNG.subarray(half).toString("base64") });
    const { ref } = await uploads.commit(key);
    assert.ok(isAbsolute(ref));
    assert.ok(!ref.includes(" "), "file name is sanitized");
    assert.deepEqual(await readFile(ref), PNG);
    assert.equal((await stat(ref)).mode & 0o777, 0o600);
    // 重试 begin 返回已提交的 ref
    assert.equal((uploads.begin(params) as { ref?: string }).ref, ref);

    const prepared = await prepareAcpPromptAttachments(
      [{ ref, fileName: "Screenshot 2026.png", mime: "image/png", bytes: PNG.length }],
      true,
    );
    assert.deepEqual(prepared.promptBlocks, [
      { type: "image", data: PNG.toString("base64"), mimeType: "image/png" },
    ]);
    assert.equal(prepared.transcriptBlocks[0]?.type, "resource_link");
  } finally {
    setDataBaseDir(null);
    await rm(dir, { recursive: true, force: true });
  }
});

test("a corrupted upload is rejected by the checksum", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codez-acp-upload-"));
  setDataBaseDir(dir);
  try {
    const uploads = new AcpAttachmentUploads();
    uploads.begin(beginParams(PNG, 1));
    const key = { connectionId: "c1", uploadId: "u1", sessionId: "task-1" };
    const corrupted = Buffer.from(PNG);
    corrupted[corrupted.length - 1] ^= 0xff;
    uploads.chunk({ ...key, chunkIndex: 0, dataBase64: corrupted.toString("base64") });
    await assert.rejects(uploads.commit(key), /checksumMismatch/);
  } finally {
    setDataBaseDir(null);
    await rm(dir, { recursive: true, force: true });
  }
});
