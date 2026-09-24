// Unit tests for the pure helpers of the CDP suite: node --test scripts/acp-cdp/lib/helpers.test.mjs
import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildCases, fixtureExpectations } from "./cases.mjs";
import { isTerminalToolStatus, normalizeText } from "./dom.mjs";
import { findSecretInArtifacts } from "./secret-scan.mjs";
import { desktopDir, redact, replayDir } from "./util.mjs";

const load = async (name) => JSON.parse(await readFile(join(replayDir, "fixtures", name), "utf8"));

test("fixture expectations follow the replay proxy's segments", async () => {
  const claude = fixtureExpectations(await load("claude-code.json"), "claude-code");
  assert.deepEqual(
    claude.map((turn) => turn.toolCalls),
    [8, 0],
  );
  // 最后一段带工具调用时，代理追加 "Replay turn finished." 收尾。
  assert.equal(claude[0].texts.at(-1), "Replay turn finished.");
  assert.equal(claude[1].texts.length, 1);

  const codex = fixtureExpectations(await load("codex.json"), "codex");
  // codex-acp 把 write_stdin 并入 exec 行：只计 exec_command，但 ID 核对包含全部录制调用。
  assert.deepEqual(
    codex.map((turn) => turn.toolCalls),
    [1, 13],
  );
  assert.equal(codex[1].allToolCallIds.length, 26);

  const permission = fixtureExpectations(await load("codex-permission.json"), "codex");
  assert.deepEqual(permission[0].texts, ["Creating the marker file.", "Marker file created."]);
});

test("case matrix never uses a bypass mode and skips Pi's permission step with a reason", () => {
  for (const mode of ["replay", "live"]) {
    const cases = buildCases({ mode, runtimes: ["claude-code", "codex", "pi"] });
    assert.equal(cases.length, 6);
    for (const item of cases) {
      if (item.mode) assert.doesNotMatch(item.mode.id, /bypass|yolo|full/i);
      if (item.runtime === "pi" && item.id.includes("permission")) assert.match(item.skip, /Pi/);
    }
  }
});

test("normalizeText drops Markdown decoration and collapses whitespace", () => {
  assert.equal(
    normalizeText("See [`aaaa-aaaa.aaaa`](/x/y.md)\n and **bold**  `code`"),
    "See aaaa-aaaa.aaaa and bold code",
  );
  assert.equal(isTerminalToolStatus("completed"), true);
  assert.equal(isTerminalToolStatus("in_progress"), false);
});

test("redact replaces secrets but ignores short dummy values", () => {
  assert.equal(redact("key=sk-or-v1-abcdefgh!", ["sk-or-v1-abcdefgh"]), "key=[REDACTED]!");
  assert.equal(redact("short abc", ["abc"]), "short abc");
});

test("secret scan finds the key in plain files and inside deflated zip entries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "acp-cdp-scan-"));
  try {
    const secret = "sk-or-v1-test-secret-000000";
    const require = createRequire(join(desktopDir, "package.json"));
    const yazl = require("yazl");
    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.from(`trace {"k":"${secret}"}`), "trace.trace", { compress: true });
    zip.addBuffer(Buffer.from("clean"), "other.txt", { compress: false });
    zip.end();
    await new Promise((resolve, reject) =>
      zip.outputStream
        .pipe(createWriteStream(join(dir, "trace.zip")))
        .on("close", resolve)
        .on("error", reject),
    );
    await writeFile(join(dir, "clean.log"), "nothing to see");
    assert.deepEqual(await findSecretInArtifacts(dir, secret), [
      `${join(dir, "trace.zip")}!trace.trace`,
    ]);
    await writeFile(join(dir, "app.log"), `leak ${secret}`);
    assert.equal((await findSecretInArtifacts(dir, secret)).length, 2);
    assert.deepEqual(await findSecretInArtifacts(dir, "sk-or-v1-absent-0000000000"), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
