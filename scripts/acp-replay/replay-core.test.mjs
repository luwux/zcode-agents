import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  anthropicIsContinuation,
  buildSegments,
  isMainResponsesRequest,
  ReplayCursor,
  responsesIsContinuation,
  substituteWorkspace,
} from "./replay-core.mjs";

const load = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

test("fixtures split into one model response per CLI request", () => {
  const count = (name) =>
    buildSegments(load(name)).map((turn) =>
      turn.map((s) => s.events.filter((e) => e.kind === "tool_call").length),
    );
  assert.deepEqual(count("claude-code.json"), [[1, 1, 1, 1, 1, 1, 1, 1, 0], [0]]);
  assert.deepEqual(count("codex.json"), [
    [1, 0],
    [4, 4, 3, 3, 3, 3, 1, 1, 2, 2, 0],
  ]);
  assert.deepEqual(count("pi.json"), count("claude-code.json"));
  for (const name of ["claude-code.json", "codex.json", "pi.json"])
    for (const turn of buildSegments(load(name))) {
      assert.equal(turn.at(-1).stop, "end_turn");
      assert.ok(turn.slice(0, -1).every((segment) => segment.stop === "tool_use"));
    }
});

test("end_response keeps consecutive text-only responses separate (native subagents)", () => {
  const turns = buildSegments(load("claude-code-subagent.json"));
  assert.deepEqual(
    turns.map((turn) => turn.map((segment) => segment.stop)),
    [["tool_use", "end_turn"], ["tool_use", "end_turn", "end_turn"], ["end_turn"]],
  );
  assert.equal(turns[1][1].events[0].text, "Launched the subagent.");
});

test("cursor advances within a turn on tool results and starts a turn on a user prompt", () => {
  const cursor = new ReplayCursor(load("codex.json"));
  assert.deepEqual([cursor.advance(false).turn, cursor.advance(true).segment], [0, 1]);
  const next = cursor.advance(false);
  assert.deepEqual([next.turn, next.segment], [1, 0]);
  for (let i = 0; i < 10; i += 1) cursor.advance(true);
  assert.equal(cursor.advance(true).exhausted, true);
});

test("continuation detection matches Claude Code and Codex request shapes", () => {
  assert.equal(
    anthropicIsContinuation({
      messages: [
        { role: "user", content: [{ type: "tool_result" }] },
        { role: "system", content: [{ type: "text" }] },
      ],
    }),
    true,
  );
  assert.equal(anthropicIsContinuation({ messages: [{ role: "user", content: "hi" }] }), false);
  assert.equal(
    responsesIsContinuation({
      input: [{ type: "function_call" }, { type: "function_call_output" }],
    }),
    true,
  );
  assert.equal(responsesIsContinuation({ input: [{ type: "message", role: "user" }] }), false);
});

test("structured-output Responses requests are side requests even with tools", () => {
  const tools = [{ type: "function", name: "exec_command" }];
  assert.equal(isMainResponsesRequest({ tools, input: [] }), true);
  assert.equal(isMainResponsesRequest({ tools: [], input: [] }), false);
  // codex-acp 的标题回合：带完整工具列表，但要求 JSON Schema 输出。
  assert.equal(
    isMainResponsesRequest({
      tools,
      text: { format: { type: "json_schema", name: "codex_output_schema", schema: {} } },
    }),
    false,
  );
  assert.equal(isMainResponsesRequest({ tools, text: { verbosity: "low" } }), true);
});

test("workspace placeholder is substituted everywhere", () => {
  assert.deepEqual(substituteWorkspace({ a: ["${WORKSPACE}/x"], b: 1 }, "/w"), {
    a: ["/w/x"],
    b: 1,
  });
});
