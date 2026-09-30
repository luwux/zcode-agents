// Post-run guard for live mode: fails the run if the API key appears in any artifact, including
// inside zip entries (Playwright trace.zip). Only file paths are reported, never the key.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";

function zipEntries(buffer) {
  // End of central directory record: signature 0x06054b50, searched from the end.
  let eocd = -1;
  for (let index = buffer.length - 22; index >= Math.max(0, buffer.length - 65_557); index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip archive");
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let entry = 0; entry < count; entry += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("bad central directory");
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(start, start + compressedSize);
    entries.push({ name, data: method === 8 ? inflateRawSync(raw) : raw });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile()) yield path;
  }
}

/** @returns {Promise<string[]>} artifact paths (or path!entry) that contain the secret */
export async function findSecretInArtifacts(dir, secret) {
  if (!secret) return [];
  const needle = Buffer.from(secret, "utf8");
  const hits = [];
  for await (const path of walk(dir)) {
    const buffer = await readFile(path);
    if (buffer.includes(needle)) hits.push(path);
    if (!path.endsWith(".zip")) continue;
    try {
      for (const entry of zipEntries(buffer))
        if (entry.data.includes(needle)) hits.push(`${path}!${entry.name}`);
    } catch (error) {
      hits.push(`${path} (could not be scanned: ${error.message})`);
    }
  }
  return hits;
}
