#!/usr/bin/env node
// Derives fixtures/pi.json from the sanitized Claude Code fixture. There is no recorded Pi
// session to sanitize, so the Pi fixture reuses the Claude session's protocol shape (event order,
// timing, masked text) and maps its tools onto Pi's built-in tools: Bash → bash, Read → read.
// Pi talks to the replay proxy through a models.json custom provider with api "anthropic-messages".
//
// Usage: node scripts/acp-replay/derive-pi-fixture.mjs [input] [output]

import fs from "node:fs";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const input = process.argv[2] ?? path.join(here, "fixtures/claude-code.json");
const output = process.argv[3] ?? path.join(here, "fixtures/pi.json");
const source = JSON.parse(fs.readFileSync(input, "utf8"));

function mapTool(event) {
  if (event.name === "Bash")
    return { ...event, name: "bash", input: { command: event.input.command } };
  if (event.name === "Read")
    return { ...event, name: "read", input: { path: event.input.file_path } };
  throw new Error(`No Pi mapping for tool ${event.name}`);
}

const pi = {
  source: "pi (derived from claude-code fixture)",
  wire: "anthropic-messages",
  model: "replay-pi",
  note: `${source.note} Derived with derive-pi-fixture.mjs: Claude tools mapped to Pi's bash/read.`,
  turns: source.turns.map((turn) => ({
    user: turn.user,
    events: turn.events.map((event) => (event.kind === "tool_call" ? mapTool(event) : event)),
  })),
};
fs.writeFileSync(output, `${JSON.stringify(pi, null, 2)}\n`);
console.log(`wrote ${output}`);
