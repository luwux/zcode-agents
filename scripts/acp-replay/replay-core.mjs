// Fixture → replayable model responses. Shared by the proxy and its tests.
//
// A fixture turn is a flat list of events recorded from a real session. The model produced every
// event except `tool_result` (those came from the CLI), so each run of non-tool_result events is
// one model response ("segment"). The CLI sends one request per segment: the first request of a
// turn carries the user prompt, the following ones carry tool results.
//
// An `end_response` marker closes a text-only response explicitly. Without it such a response is
// merged into the next one (the CLI would end its turn); with native subagents the parent and the
// subagent each end their own response inside the same fixture turn, so both must stay separate.

/** Replace `${WORKSPACE}` in every string of a JSON-compatible value. */
export function substituteWorkspace(value, workspace) {
  if (typeof value === "string") return value.replaceAll("${WORKSPACE}", workspace);
  if (Array.isArray(value)) return value.map((item) => substituteWorkspace(item, workspace));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, substituteWorkspace(item, workspace)]),
    );
  return value;
}

const MODEL_EVENT_KINDS = new Set(["text", "thinking", "tool_call"]);

/**
 * @returns {Array<Array<{segment: object[], stop: "tool_use"|"end_turn"}>>} segments per turn
 */
export function buildSegments(fixture) {
  return fixture.turns.map((turn) => {
    const segments = [];
    let current = [];
    let lastT = 0;
    const flush = (final = false) => {
      if (current.length) segments.push(final ? Object.assign(current, { final: true }) : current);
      current = [];
    };
    for (const event of turn.events) {
      if (event.kind === "tool_result") {
        flush();
        continue;
      }
      if (event.kind === "end_response") {
        flush(true);
        continue;
      }
      if (!MODEL_EVENT_KINDS.has(event.kind)) continue;
      const delay = Math.max(0, (event.t_ms ?? lastT) - lastT);
      lastT = event.t_ms ?? lastT;
      current.push({ ...event, delay_ms: delay });
    }
    flush();
    // A response without tool calls ends the turn in the CLI, so it cannot be followed by more
    // responses in the same turn: merge it forward into the next segment.
    const merged = [];
    let carry = [];
    segments.forEach((segment, index) => {
      const events = [...carry, ...segment];
      const hasTool = events.some((event) => event.kind === "tool_call");
      if (!hasTool && !segment.final && index < segments.length - 1) {
        carry = events;
        return;
      }
      carry = [];
      merged.push({ events, stop: hasTool ? "tool_use" : "end_turn" });
    });
    if (!merged.length)
      merged.push({
        events: [{ kind: "text", text: "Replay turn finished.", delay_ms: 0 }],
        stop: "end_turn",
      });
    // After the last tool results the CLI asks once more; close the turn with a short answer.
    if (merged.at(-1).stop === "tool_use")
      merged.push({
        events: [{ kind: "text", text: "Replay turn finished.", delay_ms: 0 }],
        stop: "end_turn",
      });
    return merged;
  });
}

/** Cursor over turns/segments; `advance(isContinuation)` returns the next segment. */
export class ReplayCursor {
  constructor(fixture) {
    this.turns = buildSegments(fixture);
    this.turn = -1;
    this.segment = 0;
  }

  advance(isContinuation) {
    if (!isContinuation || this.turn < 0) {
      this.turn += 1;
      this.segment = 0;
    } else {
      this.segment += 1;
    }
    const turn = this.turns[this.turn];
    const segment = turn?.[this.segment];
    if (!segment)
      return {
        turn: this.turn,
        segment: this.segment,
        exhausted: true,
        events: [{ kind: "text", text: "Replay fixture exhausted.", delay_ms: 0 }],
        stop: "end_turn",
      };
    return { turn: this.turn, segment: this.segment, exhausted: false, ...segment };
  }
}

/** Anthropic Messages: is the last user message made of tool_result blocks? */
export function anthropicIsContinuation(body) {
  // Claude Code may append a trailing `system` role message after the user turn; skip it.
  const last = (body.messages ?? []).findLast((message) => message?.role !== "system");
  if (!last || last.role !== "user" || !Array.isArray(last.content)) return false;
  return last.content.some((block) => block?.type === "tool_result");
}

/** OpenAI Responses: does the input end with tool outputs? */
export function responsesIsContinuation(body) {
  const input = Array.isArray(body.input) ? body.input : [];
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index];
    if (item?.type === "function_call_output" || item?.type === "custom_tool_call_output")
      return true;
    if (item?.type === "message" || item?.role === "user") return false;
  }
  return false;
}

export function hasTools(body) {
  return Array.isArray(body.tools) && body.tools.length > 0;
}

/**
 * A Responses request that advances the fixture: it carries the agent's tools and does not ask for
 * structured output.
 *
 * 修复原因：内置 Codex 配置写入只含声明模型的私有 model_catalog_json 后，codex-acp 生成会话标题时
 * 使用的硬编码模型不在该目录里，Codex 按默认元数据给这个标题回合附带完整工具列表。只按 tools 判断
 * 会把标题请求当成主回合，提前消耗录制的下一回合。标题回合总是带 JSON Schema 输出格式
 * （`text.format.type = "json_schema"`），主回合不会带，据此把它归为不推进夹具的旁路请求。
 */
export function isMainResponsesRequest(body) {
  return hasTools(body) && body.text?.format?.type !== "json_schema";
}
