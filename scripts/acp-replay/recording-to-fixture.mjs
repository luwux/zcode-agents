#!/usr/bin/env node
// Turns a record-proxy log (`*.record.jsonl`) of a real Claude Code run into a replay fixture.
//
//   node scripts/acp-replay/recording-to-fixture.mjs <in.record.jsonl> <out.json> [--note "..."]
//
// Unlike sanitize-sessions.mjs this keeps the real model output (text, thinking, tool calls with
// their real arguments) and the real per-event timing from the proxy's chunk `timing`, so a replay
// shows what the model actually did. Only Anthropic Messages streams are supported.
//
// Turn and segment boundaries follow ReplayCursor: every request that carries tools advances the
// fixture; a request whose last user message is not made of tool results starts a new fixture turn
// (the user prompt, or a native subagent's first request). Side requests without tools are skipped.
//
// Privacy: the working directory becomes `${WORKSPACE}`, home directories are normalised, request
// prompts (system prompt, tool schemas) are not copied, and the output is refused if it contains
// anything that looks like an API key.

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { anthropicIsContinuation, hasTools } from "./replay-core.mjs";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { note: { type: "string" } },
});
const [input, output] = positionals;
if (!input || !output) {
  console.error("usage: recording-to-fixture.mjs <in.record.jsonl> <out.json> [--note text]");
  process.exit(2);
}

const SECRET_PATTERN =
  /sk-or-v1-[A-Za-z0-9]{16,}|sk-ant-[A-Za-z0-9_-]{16,}|sk-proj-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}/;

const entries = readFileSync(input, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line))
  .filter(
    (entry) =>
      entry.status === 200 &&
      /\/messages(\?|$)/.test(entry.path ?? "") &&
      entry.request &&
      typeof entry.request === "object" &&
      hasTools(entry.request),
  );
if (!entries.length) throw new Error("no Anthropic Messages requests with tools in the recording");

/** The CLI's working directory, from the Claude Code system prompt. */
function findWorkspace() {
  for (const entry of entries) {
    const system = JSON.stringify(entry.request.system ?? "");
    const match = system.match(/(?:Primary working directory|Working directory): ([^\s"\\]+)/);
    if (match) return match[1];
  }
  return null;
}
const workspace = findWorkspace();

function scrub(value) {
  if (typeof value === "string") {
    let text = workspace ? value.replaceAll(workspace, "${WORKSPACE}") : value;
    text = text.replace(/\/(?:home|Users)\/[^/\s"']+/g, "/home/user");
    return text;
  }
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrub(item)]));
  return value;
}

/** Time (ms since the request started) at which the response had reached `offset` characters. */
function timeAt(entry, offset) {
  const timing = entry.timing ?? [];
  for (const [ms, chars] of timing) if (chars >= offset) return ms;
  return timing.at(-1)?.[0] ?? entry.ms ?? 0;
}

/** Parse one Anthropic SSE (or plain JSON) response into fixture events. */
function parseResponse(entry, base) {
  const text = entry.response ?? "";
  if (text.trimStart().startsWith("{")) {
    const message = JSON.parse(text);
    const at = base + (entry.ms ?? 0);
    return (message.content ?? []).flatMap((block) => blockEvent(block, at)).filter(Boolean);
  }
  const events = [];
  const blocks = new Map();
  let offset = 0;
  let stopReason = null;
  let usage = null;
  for (const raw of text.split("\n\n")) {
    const end = offset + raw.length;
    offset = end + 2;
    const data = raw
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("");
    if (!data || data === "[DONE]") continue;
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }
    const at = base + timeAt(entry, end);
    if (event.type === "content_block_start") {
      blocks.set(event.index, { ...event.content_block, at, text: "", json: "" });
    } else if (event.type === "content_block_delta") {
      const block = blocks.get(event.index);
      if (!block) continue;
      if (event.delta.type === "text_delta") block.text += event.delta.text;
      else if (event.delta.type === "thinking_delta") block.text += event.delta.thinking;
      else if (event.delta.type === "input_json_delta") block.json += event.delta.partial_json;
    } else if (event.type === "content_block_stop") {
      const block = blocks.get(event.index);
      blocks.delete(event.index);
      if (!block) continue;
      if (block.type === "tool_use")
        block.input = block.json ? JSON.parse(block.json) : (block.input ?? {});
      else if (block.type === "thinking") block.thinking = block.text;
      events.push(...[blockEvent(block, block.at)].flat().filter(Boolean));
    } else if (event.type === "message_delta") {
      stopReason = event.delta?.stop_reason ?? stopReason;
      usage = event.usage ?? usage;
    }
  }
  if (usage)
    events.push({ kind: "usage", t_ms: base + (entry.ms ?? 0), stop_reason: stopReason, usage });
  return events;
}

function blockEvent(block, at) {
  if (block.type === "text" && block.text) return { kind: "text", t_ms: at, text: block.text };
  if (block.type === "thinking")
    return { kind: "thinking", t_ms: at, text: block.thinking ?? block.text ?? "" };
  if (block.type === "tool_use")
    return {
      kind: "tool_call",
      t_ms: at,
      call_id: block.id,
      name: block.name,
      input: block.input ?? {},
    };
  // server_tool_use / web_search_tool_result and redacted thinking cannot be replayed.
  return null;
}

function lastUser(request) {
  return (request.messages ?? []).findLast((message) => message?.role === "user");
}

function userText(request) {
  const content = lastUser(request)?.content;
  if (typeof content === "string") return content;
  return (content ?? [])
    .filter((block) => block?.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function toolResults(request, at) {
  const content = lastUser(request)?.content;
  if (!Array.isArray(content)) return [];
  return content
    .filter((block) => block?.type === "tool_result")
    .map((block) => ({
      kind: "tool_result",
      t_ms: at,
      call_id: block.tool_use_id,
      is_error: Boolean(block.is_error),
      output: (typeof block.content === "string"
        ? block.content
        : (block.content ?? [])
            .filter((part) => part?.type === "text")
            .map((part) => part.text)
            .join("\n")
      ).slice(0, 4000),
    }));
}

const turns = [];
let turn = null;
let turnStart = 0;
for (const entry of entries) {
  const continuation = anthropicIsContinuation(entry.request);
  if (!continuation || !turn) {
    turn = { user: { text: userText(entry.request), t_ms: 0 }, events: [] };
    turns.push(turn);
    turnStart = entry.at;
  } else {
    turn.events.push(...toolResults(entry.request, entry.at - turnStart));
  }
  const events = parseResponse(entry, entry.at - turnStart);
  turn.events.push(...events);
  // A text-only response ends its own segment (see replay-core `end_response`).
  if (!events.some((event) => event.kind === "tool_call"))
    turn.events.push({ kind: "end_response", t_ms: events.at(-1)?.t_ms ?? 0 });
}

const fixture = scrub({
  source: "claude-code",
  wire: "anthropic-messages",
  model: entries[0].request.model,
  note:
    values.note ??
    "Recorded from a real live run through record-proxy.mjs; real model output and timing.",
  recorded: true,
  turns,
});
const json = `${JSON.stringify(fixture, null, 2)}\n`;
if (SECRET_PATTERN.test(json)) throw new Error("refusing to write: the fixture contains a secret");
writeFileSync(output, json);
console.log(
  JSON.stringify({
    output,
    turns: turns.length,
    requests: entries.length,
    toolCalls: turns.flatMap((t) => t.events).filter((event) => event.kind === "tool_call").length,
  }),
);
