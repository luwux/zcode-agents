import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildSegments } from "./replay-core.mjs";

const script = new URL("./recording-to-fixture.mjs", import.meta.url).pathname;
const WS = "/tmp/live-root/workspace";

function sse(events) {
  return events.map((data) => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

function entry({ at, messages, response }) {
  // Two chunks: the first half arrives at 100 ms, the rest at 900 ms.
  const half = Math.floor(response.length / 2);
  return {
    at,
    ms: 900,
    method: "POST",
    path: "/api/v1/messages?beta=true",
    status: 200,
    request: {
      model: "vendor/model",
      system: [{ type: "text", text: `Primary working directory: ${WS}` }],
      tools: [{ name: "Bash" }],
      messages,
    },
    response,
    timing: [
      [100, half],
      [900, response.length],
    ],
  };
}

test("a real recording becomes a fixture with real output, timing and turn boundaries", () => {
  const dir = mkdtempSync(join(tmpdir(), "rec-fixture-"));
  try {
    const first = sse([
      { type: "message_start", message: {} },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "Plan" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "toolu_1", name: "Bash", input: {} },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: `{"command":"ls ${WS}"}` },
      },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } },
    ]);
    const second = sse([
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done: 42" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
    ]);
    const lines = [
      entry({ at: 1000, messages: [{ role: "user", content: "List files" }], response: first }),
      // Side request without tools (title) is ignored.
      { at: 1500, path: "/api/v1/messages", status: 200, request: { messages: [] }, response: "" },
      entry({
        at: 3000,
        messages: [
          { role: "user", content: "List files" },
          { role: "assistant", content: [] },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "a.txt" }],
          },
        ],
        response: second,
      }),
    ];
    const input = join(dir, "run.record.jsonl");
    const output = join(dir, "fixture.json");
    writeFileSync(input, lines.map((line) => JSON.stringify(line)).join("\n"));
    execFileSync(process.execPath, [script, input, output], { stdio: "pipe" });
    const fixture = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(fixture.recorded, true);
    assert.equal(fixture.turns.length, 1);
    assert.equal(fixture.turns[0].user.text, "List files");
    const kinds = fixture.turns[0].events.map((event) => event.kind);
    assert.deepEqual(kinds, [
      "thinking",
      "tool_call",
      "usage",
      "tool_result",
      "text",
      "usage",
      "end_response",
    ]);
    const call = fixture.turns[0].events[1];
    assert.deepEqual(call.input, { command: "ls ${WORKSPACE}" }, "workspace path is scrubbed");
    // Real timing: each block starts with the chunk it arrived in (100 ms after its request).
    assert.equal(fixture.turns[0].events[0].t_ms, 100);
    assert.equal(fixture.turns[0].events[4].t_ms, 2100);
    // The fixture replays as two segments: the tool call, then the final answer.
    const segments = buildSegments(fixture)[0];
    assert.deepEqual(
      segments.map((segment) => segment.stop),
      ["tool_use", "end_turn"],
    );
    assert.equal(segments[1].events[0].text, "Done: 42");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a recording containing a key is refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "rec-fixture-"));
  try {
    const leak = sse([
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: `key sk-or-v1-${"a".repeat(40)}` },
      },
      { type: "content_block_stop", index: 0 },
    ]);
    const input = join(dir, "run.record.jsonl");
    writeFileSync(
      input,
      JSON.stringify(entry({ at: 0, messages: [{ role: "user", content: "hi" }], response: leak })),
    );
    assert.throws(() =>
      execFileSync(process.execPath, [script, input, join(dir, "out.json")], { stdio: "pipe" }),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
