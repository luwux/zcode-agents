#!/usr/bin/env node
// Turns a recorded Claude Code or Codex session (JSONL) into a replay fixture that
// keeps only protocol shape: event order, relative timing, tool names, argument keys,
// token usage and text *length/layout*. All natural-language content is masked by
// character class and every tool invocation is replaced with a safe, read-only command.
//
// Usage: node scripts/acp-replay/sanitize-sessions.mjs <claude|codex> <input.jsonl> <output.json>

import fs from "node:fs";

const [kind, input, output] = process.argv.slice(2);
if (!["claude", "codex"].includes(kind) || !input || !output) {
  console.error("usage: sanitize-sessions.mjs <claude|codex> <input.jsonl> <output.json>");
  process.exit(2);
}

// Commands the replaying CLI will actually execute inside the sandbox workspace.
// Read-only on purpose: replays must never delete or rewrite files.
const SAFE_COMMANDS = [
  "ls",
  "cat README.md",
  "git status --short",
  "wc -l README.md",
  "head -n 5 package.json",
];

// Keeps whitespace, punctuation and markdown structure; replaces letters, digits and CJK.
function mask(text) {
  if (typeof text !== "string") return "";
  return text
    .replace(/\p{L}/gu, (ch) => (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(ch) ? "文" : "a"))
    .replace(/\p{N}/gu, "0");
}

function numericOnly(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj ?? {})) {
    if (typeof v === "number") out[k] = v;
    else if (v && typeof v === "object" && !Array.isArray(v)) {
      const nested = numericOnly(v);
      if (Object.keys(nested).length) out[k] = nested;
    }
  }
  return out;
}

const rows = fs
  .readFileSync(input, "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

const t0 = Date.parse(rows.find((r) => r.timestamp)?.timestamp ?? 0);
const at = (r) => (r.timestamp ? Date.parse(r.timestamp) - t0 : null);

let toolSeq = 0;
const callIds = new Map();
function replayCallId(original, prefix) {
  if (!callIds.has(original)) callIds.set(original, `${prefix}_replay_${String(++toolSeq).padStart(2, "0")}`);
  return callIds.get(original);
}
const safeCommand = () => SAFE_COMMANDS[(toolSeq - 1) % SAFE_COMMANDS.length];

const turns = [];
let turn = null;
let model = null;
const newTurn = (text, t_ms) => {
  turn = { user: { text: mask(text), t_ms }, events: [] };
  turns.push(turn);
};

function contentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => c.text ?? contentText(c.content) ?? "").join("\n");
  return "";
}

if (kind === "claude") {
  for (const r of rows) {
    const msg = r.message;
    if (r.type === "user" && msg) {
      if (typeof msg.content === "string") {
        newTurn(msg.content, at(r));
        continue;
      }
      for (const block of msg.content ?? []) {
        if (block.type === "text" && !turn) newTurn(block.text, at(r));
        if (block.type === "tool_result" && turn) {
          turn.events.push({
            kind: "tool_result",
            t_ms: at(r),
            call_id: replayCallId(block.tool_use_id, "toolu"),
            is_error: Boolean(block.is_error),
            output: mask(contentText(block.content)),
          });
        }
      }
    } else if (r.type === "assistant" && msg && turn) {
      model ??= msg.model;
      for (const block of msg.content ?? []) {
        const base = { t_ms: at(r), message_id: `msg_replay_${turns.length}_${turn.events.length}` };
        if (block.type === "thinking") turn.events.push({ ...base, kind: "thinking", text: mask(block.thinking) });
        else if (block.type === "text") turn.events.push({ ...base, kind: "text", text: mask(block.text) });
        else if (block.type === "tool_use") {
          const id = replayCallId(block.id, "toolu");
          let replayInput;
          if (block.name === "Bash") replayInput = { command: safeCommand(), description: `Replay step ${toolSeq}` };
          else if (block.name === "Read") replayInput = { file_path: "${WORKSPACE}/README.md" };
          else replayInput = Object.fromEntries(Object.keys(block.input ?? {}).map((k) => [k, ""]));
          turn.events.push({ ...base, kind: "tool_call", call_id: id, name: block.name, input: replayInput });
        }
      }
      if (msg.usage) turn.events.push({ kind: "usage", t_ms: at(r), stop_reason: msg.stop_reason, usage: numericOnly(msg.usage) });
    }
  }
} else {
  for (const r of rows) {
    const p = r.payload ?? {};
    if (r.type === "turn_context") model ??= p.model;
    if (r.type !== "response_item" && !(r.type === "event_msg" && p.type === "token_count")) continue;
    if (p.type === "message" && p.role === "user") {
      const text = contentText(p.content);
      // Environment context and AGENTS.md injections are not user prompts.
      if (text.trimStart().startsWith("<") || text.trimStart().startsWith("#")) continue;
      newTurn(text, at(r));
    } else if (!turn) {
      continue;
    } else if (p.type === "message" && p.role === "assistant") {
      turn.events.push({ kind: "text", t_ms: at(r), text: mask(contentText(p.content)), phase: p.phase ?? null });
    } else if (p.type === "reasoning") {
      turn.events.push({ kind: "thinking", t_ms: at(r), text: mask((p.summary ?? []).map((s) => s.text).join("\n")) });
    } else if (p.type === "function_call") {
      const id = replayCallId(p.call_id, "call");
      const args = JSON.parse(p.arguments || "{}");
      let replayArgs;
      if (p.name === "exec_command") {
        replayArgs = { cmd: safeCommand(), workdir: "${WORKSPACE}", yield_time_ms: args.yield_time_ms, max_output_tokens: args.max_output_tokens };
      } else if (p.name === "write_stdin") {
        replayArgs = { session_id: args.session_id, chars: "", yield_time_ms: args.yield_time_ms, max_output_tokens: args.max_output_tokens };
      } else {
        replayArgs = Object.fromEntries(Object.keys(args).map((k) => [k, typeof args[k] === "number" ? args[k] : ""]));
      }
      turn.events.push({ kind: "tool_call", t_ms: at(r), call_id: id, name: p.name, input: replayArgs });
    } else if (p.type === "function_call_output") {
      turn.events.push({ kind: "tool_result", t_ms: at(r), call_id: replayCallId(p.call_id, "call"), output: mask(contentText(p.output)) });
    } else if (p.type === "token_count") {
      turn.events.push({ kind: "usage", t_ms: at(r), usage: numericOnly(p.info) });
    }
  }
}

const fixture = {
  source: kind === "claude" ? "claude-code" : "codex",
  wire: kind === "claude" ? "anthropic-messages" : "openai-responses",
  model,
  note: "Sanitized replay fixture: text is masked by character class, commands are replaced with safe read-only ones, ${WORKSPACE} is substituted at replay time.",
  turns,
};
fs.writeFileSync(output, JSON.stringify(fixture, null, 2) + "\n");
console.log(`${output}: ${turns.length} turns, ${turns.reduce((n, t) => n + t.events.length, 0)} events, model=${model}`);
