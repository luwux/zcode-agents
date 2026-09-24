#!/usr/bin/env node
// Transparent recording proxy for live model tests (diagnostics and future fixtures).
//
//   node scripts/acp-replay/record-proxy.mjs --upstream https://openrouter.ai/api --log /tmp/rec.jsonl
//
// Listens on 127.0.0.1 only and forwards every request to `<upstream><path>` with the original
// method, body and headers (the Authorization header passes through untouched). It records only
// request/response BODIES plus status and a short event summary — never headers — so API keys cannot
// end up in the log. Prints `{"url": "http://127.0.0.1:<port>"}` once listening.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createServer } from "node:http";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    upstream: { type: "string" },
    log: { type: "string" },
    port: { type: "string", default: "0" },
    "max-body": { type: "string", default: "400000" },
  },
});
if (!values.upstream || !values.log) {
  console.error("usage: record-proxy.mjs --upstream <url> --log <file> [--port P]");
  process.exit(2);
}
mkdirSync(dirname(values.log), { recursive: true });
const upstream = values.upstream.replace(/\/$/, "");
const maxBody = Number(values["max-body"]);
const HOP_BY_HOP = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "accept-encoding",
]);

function summarize(text) {
  const types = {};
  for (const match of text.matchAll(/^event: (.+)$/gm))
    types[match[1]] = (types[match[1]] ?? 0) + 1;
  for (const match of text.matchAll(
    /"type":"(function_call|tool_use|message|reasoning|custom_tool_call)"/g,
  ))
    types[`item:${match[1]}`] = (types[`item:${match[1]}`] ?? 0) + 1;
  if (/"tool_calls"/.test(text)) types["chat:tool_calls"] = 1;
  const finish = [...text.matchAll(/"(?:finish_reason|stop_reason|status)":"([a-z_]+)"/g)].map(
    (m) => m[1],
  );
  return { events: types, finish: [...new Set(finish)].slice(0, 6) };
}

const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const requestBody = Buffer.concat(chunks);
  const headers = {};
  for (const [name, value] of Object.entries(req.headers))
    if (!HOP_BY_HOP.has(name) && typeof value === "string") headers[name] = value;
  const started = Date.now();
  let status = 0;
  let responseText = "";
  try {
    const response = await fetch(`${upstream}${req.url}`, {
      method: req.method,
      headers,
      body: ["GET", "HEAD"].includes(req.method ?? "GET") ? undefined : requestBody,
    });
    status = response.status;
    const outHeaders = {};
    response.headers.forEach((value, name) => {
      if (!HOP_BY_HOP.has(name) && name !== "content-encoding") outHeaders[name] = value;
    });
    res.writeHead(response.status, outHeaders);
    const decoder = new TextDecoder();
    if (response.body)
      for await (const chunk of response.body) {
        res.write(chunk);
        if (responseText.length < maxBody) responseText += decoder.decode(chunk, { stream: true });
      }
    res.end();
  } catch (error) {
    status = 502;
    responseText = String(error);
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: `record proxy: ${String(error)}` } }));
  }
  let request;
  try {
    request = JSON.parse(requestBody.toString("utf8") || "null");
  } catch {
    request = requestBody.toString("utf8").slice(0, maxBody);
  }
  const summary = summarize(responseText);
  appendFileSync(
    values.log,
    `${JSON.stringify({
      at: started,
      ms: Date.now() - started,
      method: req.method,
      path: req.url,
      status,
      summary,
      request,
      response: responseText.slice(0, maxBody),
    })}\n`,
  );
  // One-line summary on stderr (no bodies) for CI logs.
  console.error(
    `[record-proxy] ${req.method} ${req.url} -> ${status} ${Date.now() - started}ms ${JSON.stringify(summary)}` +
      (status >= 400 ? ` body=${responseText.slice(0, 300).replace(/\s+/g, " ")}` : ""),
  );
});

server.listen(Number(values.port), "127.0.0.1", () => {
  process.stdout.write(`${JSON.stringify({ url: `http://127.0.0.1:${server.address().port}` })}\n`);
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => server.close(() => process.exit(0)));
