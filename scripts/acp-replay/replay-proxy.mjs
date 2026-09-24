#!/usr/bin/env node
// Offline model replay proxy for built-in ACP runtime tests.
//
//   node scripts/acp-replay/replay-proxy.mjs --fixture fixtures/claude-code.json --workspace /tmp/ws \
//     [--speed 20] [--port 0] [--log /tmp/replay.jsonl]
//
// Prints one JSON line `{"url": "http://127.0.0.1:<port>"}` on stdout once listening.
// Speaks Anthropic Messages (`POST */v1/messages`, SSE or JSON) and OpenAI Responses
// (`POST */responses`, SSE). Every request that carries tools advances the fixture by one
// recorded model response, regardless of the prompt; side requests without tools (titles,
// summaries) or with a structured-output format (Codex ACP titles) get a short fixed answer and
// do not advance. Binds to 127.0.0.1 only.

import { appendFileSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { parseArgs } from "node:util";
import {
  anthropicIsContinuation,
  hasTools,
  isMainResponsesRequest,
  ReplayCursor,
  responsesIsContinuation,
  substituteWorkspace,
} from "./replay-core.mjs";

const { values } = parseArgs({
  options: {
    fixture: { type: "string" },
    workspace: { type: "string" },
    speed: { type: "string", default: "20" },
    port: { type: "string", default: "0" },
    log: { type: "string" },
    "max-delay-ms": { type: "string", default: "1500" },
  },
});
if (!values.fixture || !values.workspace) {
  console.error(
    "usage: replay-proxy.mjs --fixture <file> --workspace <dir> [--speed N] [--port P]",
  );
  process.exit(2);
}

const fixture = substituteWorkspace(
  JSON.parse(readFileSync(values.fixture, "utf8")),
  values.workspace,
);
const cursor = new ReplayCursor(fixture);
const speed = Math.max(0.01, Number(values.speed));
const maxDelay = Number(values["max-delay-ms"]);
let sequence = 0;

function log(entry) {
  if (values.log) appendFileSync(values.log, `${JSON.stringify({ at: Date.now(), ...entry })}\n`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(maxDelay, ms / speed)));

function chunks(text, size = 24) {
  const parts = [];
  for (let index = 0; index < text.length; index += size)
    parts.push(text.slice(index, index + size));
  return parts.length ? parts : [""];
}

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const parts = [];
    req.on("data", (chunk) => parts.push(chunk));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(parts).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

// ---------- Anthropic Messages ----------

function anthropicContent(events) {
  return events.map((event) => {
    if (event.kind === "text") return { type: "text", text: event.text };
    if (event.kind === "thinking")
      return { type: "thinking", thinking: event.text || "…", signature: "replay-signature" };
    return { type: "tool_use", id: event.call_id, name: event.name, input: event.input ?? {} };
  });
}

async function anthropicStream(res, model, reply) {
  const id = `msg_replay_${++sequence}`;
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  sse(res, "message_start", {
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 100,
        output_tokens: 1,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  });
  let index = 0;
  for (const event of reply.events) {
    await sleep(event.delay_ms ?? 0);
    if (event.kind === "text") {
      sse(res, "content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "text", text: "" },
      });
      for (const part of chunks(event.text))
        sse(res, "content_block_delta", {
          type: "content_block_delta",
          index,
          delta: { type: "text_delta", text: part },
        });
    } else if (event.kind === "thinking") {
      sse(res, "content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "thinking", thinking: "", signature: "" },
      });
      sse(res, "content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "thinking_delta", thinking: event.text || "…" },
      });
      sse(res, "content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "signature_delta", signature: "replay-signature" },
      });
    } else {
      sse(res, "content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: event.call_id, name: event.name, input: {} },
      });
      sse(res, "content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(event.input ?? {}) },
      });
    }
    sse(res, "content_block_stop", { type: "content_block_stop", index });
    index += 1;
  }
  sse(res, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: reply.stop, stop_sequence: null },
    usage: { output_tokens: 20 },
  });
  sse(res, "message_stop", { type: "message_stop" });
  res.end();
}

/** 记录请求中与模型/推理相关的参数（不含消息内容），供 e2e 断言所选模型与推理档位确实发往 Provider。 */
function requestParams(body) {
  const params = { model: body.model };
  for (const key of ["thinking", "output_config", "reasoning", "reasoning_effort"])
    if (body[key] !== undefined) params[key] = body[key];
  return params;
}

async function handleAnthropic(req, res, body) {
  const main = hasTools(body);
  const reply = main
    ? cursor.advance(anthropicIsContinuation(body))
    : { events: [{ kind: "text", text: "Replay", delay_ms: 0 }], stop: "end_turn", side: true };
  const lastMessages = (body.messages ?? []).slice(-2).map((message) => ({
    role: message.role,
    content: Array.isArray(message.content)
      ? message.content.map((block) => block?.type)
      : typeof message.content,
  }));
  log({
    api: "anthropic",
    path: req.url,
    params: requestParams(body),
    main,
    lastMessages,
    turn: reply.turn,
    segment: reply.segment,
    stop: reply.stop,
    exhausted: reply.exhausted ?? false,
    tools: reply.events.filter((e) => e.kind === "tool_call").map((e) => e.name),
  });
  const model = body.model ?? fixture.model;
  if (body.stream) return anthropicStream(res, model, reply);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      id: `msg_replay_${++sequence}`,
      type: "message",
      role: "assistant",
      model,
      content: anthropicContent(reply.events),
      stop_reason: reply.stop,
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 20 },
    }),
  );
}

// ---------- OpenAI Responses ----------

function responsesItems(events) {
  let n = 0;
  return events.map((event) => {
    n += 1;
    if (event.kind === "text")
      return {
        id: `msg_replay_${sequence}_${n}`,
        type: "message",
        role: "assistant",
        status: "completed",
        ...(event.phase ? { phase: event.phase } : {}),
        content: [{ type: "output_text", text: event.text, annotations: [] }],
      };
    if (event.kind === "thinking")
      return { id: `rs_replay_${sequence}_${n}`, type: "reasoning", summary: [] };
    return {
      id: `fc_replay_${sequence}_${n}`,
      type: "function_call",
      status: "completed",
      call_id: event.call_id,
      name: event.name,
      arguments: JSON.stringify(event.input ?? {}),
    };
  });
}

async function handleResponses(req, res, body) {
  const main = isMainResponsesRequest(body);
  const reply = main
    ? cursor.advance(responsesIsContinuation(body))
    : { events: [{ kind: "text", text: "Replay", delay_ms: 0 }], stop: "end_turn", side: true };
  log({
    api: "responses",
    path: req.url,
    params: requestParams(body),
    main,
    turn: reply.turn,
    segment: reply.segment,
    stop: reply.stop,
    exhausted: reply.exhausted ?? false,
    tools: reply.events.filter((e) => e.kind === "tool_call").map((e) => e.name),
  });
  const id = `resp_replay_${++sequence}`;
  const model = body.model ?? fixture.model;
  const items = responsesItems(reply.events);
  const base = { id, object: "response", created_at: Math.floor(Date.now() / 1000), model };
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  let seq = 0;
  const emit = (type, data) => sse(res, type, { type, sequence_number: seq++, ...data });
  emit("response.created", { response: { ...base, status: "in_progress", output: [] } });
  for (const [outputIndex, item] of items.entries()) {
    await sleep(reply.events[outputIndex].delay_ms ?? 0);
    if (item.type === "message") {
      const text = item.content[0].text;
      emit("response.output_item.added", {
        output_index: outputIndex,
        item: { ...item, status: "in_progress", content: [] },
      });
      emit("response.content_part.added", {
        item_id: item.id,
        output_index: outputIndex,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      });
      for (const part of chunks(text))
        emit("response.output_text.delta", {
          item_id: item.id,
          output_index: outputIndex,
          content_index: 0,
          delta: part,
        });
      emit("response.output_text.done", {
        item_id: item.id,
        output_index: outputIndex,
        content_index: 0,
        text,
      });
      emit("response.content_part.done", {
        item_id: item.id,
        output_index: outputIndex,
        content_index: 0,
        part: item.content[0],
      });
    } else if (item.type === "function_call") {
      emit("response.output_item.added", {
        output_index: outputIndex,
        item: { ...item, status: "in_progress", arguments: "" },
      });
      emit("response.function_call_arguments.delta", {
        item_id: item.id,
        output_index: outputIndex,
        delta: item.arguments,
      });
      emit("response.function_call_arguments.done", {
        item_id: item.id,
        output_index: outputIndex,
        arguments: item.arguments,
      });
    } else {
      emit("response.output_item.added", { output_index: outputIndex, item });
    }
    emit("response.output_item.done", { output_index: outputIndex, item });
  }
  emit("response.completed", {
    response: {
      ...base,
      status: "completed",
      output: items,
      usage: {
        input_tokens: 100,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 20,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 120,
      },
    },
  });
  res.end();
}

const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (req.method === "GET" && path.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          object: "list",
          data: [{ id: fixture.model, object: "model", created: 0, owned_by: "replay" }],
        }),
      );
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(404).end();
      return;
    }
    const body = await readBody(req);
    if (path.endsWith("/messages/count_tokens")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ input_tokens: 100 }));
      return;
    }
    if (path.endsWith("/messages")) return await handleAnthropic(req, res, body);
    if (path.endsWith("/responses")) return await handleResponses(req, res, body);
    log({ api: "unknown", path });
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: `replay proxy: unsupported ${path}` } }));
  } catch (error) {
    log({ api: "error", message: String(error) });
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: String(error) } }));
  }
});

server.listen(Number(values.port), "127.0.0.1", () => {
  const { port } = server.address();
  process.stdout.write(`${JSON.stringify({ url: `http://127.0.0.1:${port}` })}\n`);
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => server.close(() => process.exit(0)));
