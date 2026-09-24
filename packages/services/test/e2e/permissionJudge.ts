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
  judge: "rule" | "random";
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

/** 可复现的伪随机数（mulberry32），种子写入产物以便复跑同一组裁决。 */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 实时测试的“用户”：规则先行（越界/拒绝名单直接拒绝），其余请求按概率随机拒绝（默认 1/5），
 * 以覆盖 Agent 在被拒后继续工作的路径；不再调用模型裁决（不值得额外的 token）。
 */
export function randomJudge(
  request: RequestPermissionRequest,
  workspace: string,
  random: () => number,
  rejectRate = 0.2,
): JudgeDecision {
  const rule = ruleJudge(request, workspace);
  if (rule.decision === "reject") return rule;
  const roll = random();
  return roll < rejectRate
    ? {
        decision: "reject",
        reason: `random rejection (roll ${roll.toFixed(3)} < ${rejectRate})`,
        judge: "random",
      }
    : { decision: "allow", reason: `random approval (roll ${roll.toFixed(3)})`, judge: "random" };
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
