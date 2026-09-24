/**
 * Test-side "user" that answers ACP permission prompts in ask modes. A rule policy always runs
 * first and can only deny; the optional model judge (OpenRouter, same model as the live tests)
 * decides the remaining requests. Nothing here widens permissions beyond the throwaway workspace.
 */
import { isAbsolute, relative, resolve } from "node:path";
import type { RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";

export type JudgeDecision = {
  decision: "allow" | "reject";
  reason: string;
  judge: "rule" | "model";
};

const DENY_PATTERNS = [
  /judge-denied/i,
  /live-denied/i,
  /\brm\s+-rf?\b/i,
  /\bsudo\b/i,
  /~\//,
  /\$HOME/,
];

function collectPaths(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    if (isAbsolute(value)) out.push(value);
  } else if (Array.isArray(value)) value.forEach((item) => collectPaths(item, out));
  else if (value && typeof value === "object")
    for (const [key, item] of Object.entries(value))
      if (/path|cwd|dir|file/i.test(key)) collectPaths(item, out);
      else if (typeof item === "object") collectPaths(item, out);
  return out;
}

function outsideWorkspace(path: string, workspace: string): boolean {
  const rel = relative(resolve(workspace), resolve(path));
  return rel.startsWith("..") || isAbsolute(rel);
}

export function ruleJudge(request: RequestPermissionRequest, workspace: string): JudgeDecision {
  const text = JSON.stringify({
    title: request.toolCall.title,
    rawInput: request.toolCall.rawInput,
  });
  const denied = DENY_PATTERNS.find((pattern) => pattern.test(text));
  if (denied) return { decision: "reject", reason: `matches deny rule ${denied}`, judge: "rule" };
  const escaping = collectPaths(request.toolCall.rawInput).find((path) =>
    outsideWorkspace(path, workspace),
  );
  if (escaping)
    return { decision: "reject", reason: `path outside workspace: ${escaping}`, judge: "rule" };
  return { decision: "allow", reason: "inside workspace, no deny rule", judge: "rule" };
}

/** 模型裁决只在规则放行时调用；模型输出 DENY 即拒绝，异常时按拒绝处理（失败即收紧）。 */
export async function modelJudge(
  request: RequestPermissionRequest,
  workspace: string,
  options: { apiKey: string; model: string },
): Promise<JudgeDecision> {
  const rule = ruleJudge(request, workspace);
  if (rule.decision === "reject") return rule;
  const summary = JSON.stringify({
    title: request.toolCall.title,
    kind: request.toolCall.kind,
    rawInput: request.toolCall.rawInput,
  }).slice(0, 4000);
  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: options.model,
        max_tokens: 20,
        temperature: 0,
        messages: [
          {
            role: "system",
            content:
              "You approve or deny a coding agent's tool call on behalf of the user. The workspace is " +
              `${workspace}. APPROVE edits and harmless commands that stay inside the workspace. ` +
              "DENY anything destructive, anything outside the workspace, and anything whose command or " +
              "path contains 'denied'. Answer with exactly one word: APPROVE or DENY.",
          },
          { role: "user", content: summary },
        ],
      }),
    });
    const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const answer = body.choices?.[0]?.message?.content?.trim().toUpperCase() ?? "";
    if (answer.startsWith("APPROVE"))
      return { decision: "allow", reason: "model approved", judge: "model" };
    return {
      decision: "reject",
      reason: `model answered ${JSON.stringify(answer.slice(0, 40))}`,
      judge: "model",
    };
  } catch (error) {
    return { decision: "reject", reason: `model judge failed: ${String(error)}`, judge: "model" };
  }
}

export function responseFor(
  request: RequestPermissionRequest,
  decision: JudgeDecision,
): RequestPermissionResponse {
  const wanted =
    decision.decision === "allow"
      ? ["allow_once", "allow_always"]
      : ["reject_once", "reject_always"];
  const option = wanted
    .map((kind) => request.options.find((candidate) => candidate.kind === kind))
    .find(Boolean);
  return option
    ? { outcome: { outcome: "selected", optionId: option.optionId } }
    : { outcome: { outcome: "cancelled" } };
}

/** Claude 以 root 运行时只有 IS_SANDBOX=1 才提供 bypassPermissions（claude-agent-acp permissions/modes.js）。 */
export function sandboxEnvForBypass(): Record<string, string> {
  return process.getuid?.() === 0 ? { IS_SANDBOX: "1" } : {};
}
